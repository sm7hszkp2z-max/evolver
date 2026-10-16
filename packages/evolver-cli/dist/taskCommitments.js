import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { util } from '@evomap/evolver-core';
import { AtpHubClient } from '@evomap/evolver-adapter-public';
import { resolveAtpHome } from './atp.js';
export const COMPLETION_LEDGER_FILENAME = 'task-complete-pending.json';
const COMPLETION_RETRY_BASE_MS = 60_000;
const COMPLETION_RETRY_CAP_MS = 60 * 60_000;
const COMPLETION_MAX_ATTEMPTS = 8;
const COMPLETION_RETRIES_PER_TICK = 5;
/** A queue name that never comes free is a name we are not getting; stop owing it. */
const UNQUEUED_MAX_ATTEMPTS = 8;
export function completionLedgerPath(env = process.env) {
    return join(resolveAtpHome(env), 'evolution', COMPLETION_LEDGER_FILENAME);
}
export function readCompletionLedger(path) {
    try {
        if (!existsSync(path))
            return { version: 1, pending: {}, unqueued: {}, owned: {} };
        const parsed = JSON.parse(readFileSync(path, 'utf8'));
        return {
            version: 1,
            pending: parsed?.pending && typeof parsed.pending === 'object' ? parsed.pending : {},
            unqueued: parsed?.unqueued && typeof parsed.unqueued === 'object' ? parsed.unqueued : {},
            owned: parsed?.owned && typeof parsed.owned === 'object' ? parsed.owned : {},
        };
    }
    catch {
        return { version: 1, pending: {}, unqueued: {}, owned: {} };
    }
}
/**
 * Hold the ledger for one read-modify-write. Without it two writers read the same version,
 * both replace the file, both are told they succeeded, and one update is simply gone — a
 * unique temp name per write stops them corrupting each other's bytes, not their meaning.
 *
 * The lock is `util.acquireLock`, the one the daemon already uses for its single-instance
 * guard: it reclaims by checking whether the owning pid is alive rather than by guessing
 * from an mtime, and it has been carrying that weight in this codebase for far longer than
 * anything written here would have.
 */
function withLedgerLock(path, held, unavailable) {
    const lock = `${path}.lock`;
    try {
        mkdirSync(dirname(path), { recursive: true });
        util.acquireLock(lock, { maxTries: 60, waitMs: 25 });
    }
    catch {
        return unavailable;
    }
    try {
        return held();
    }
    finally {
        util.releaseLock(lock);
    }
}
/**
 * Read the ledger, change it, and put it back as one step — the only way any of this file
 * mutates it. Returning null from `change` means "nothing to do" and leaves it untouched.
 */
function updateCompletionLedger(path, change) {
    return withLedgerLock(path, () => {
        const next = change(readCompletionLedger(path));
        return next === null ? true : replaceCompletionLedger(path, next);
    }, false);
}
/** False when the ledger could not be persisted — the caller decides what that costs. */
function replaceCompletionLedger(path, ledger) {
    // Unique per write, not per process: a worker thread shares the pid with its parent.
    const temporary = `${path}.${process.pid}.${randomUUID().slice(0, 8)}.tmp`;
    try {
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(temporary, `${JSON.stringify(ledger, null, 2)}\n`, 'utf8');
        renameSync(temporary, path);
        return true;
    }
    catch {
        // A failed rename leaves the temp file behind, and every attempt now picks a new name,
        // so sweeping it up here is what keeps a retry loop from filling the directory.
        rmSync(temporary, { force: true });
        return false;
    }
}
export function rememberUnqueued(path, queueTask, error) {
    updateCompletionLedger(path, (ledger) => ({
        ...ledger,
        unqueued: { ...(ledger.unqueued ?? {}), [queueTask.id]: { taskId: queueTask.id, queueTask, attempts: (ledger.unqueued?.[queueTask.id]?.attempts ?? 0) + 1, lastError: error } },
    }));
}
/**
 * Release a claim — but only the filing named, when one is. A retry round that decided in
 * favour of dropping an old claim shares its queue id with whatever was registered since,
 * and deleting by id alone takes that newer filing's ownership with it.
 */
function forgetOwned(path, queueTaskId, generation) {
    updateCompletionLedger(path, (ledger) => {
        const held = ledger.owned?.[queueTaskId];
        if (!held)
            return null;
        if (generation !== undefined && held.generation !== generation)
            return null;
        const owned = { ...ledger.owned };
        delete owned[queueTaskId];
        return { ...ledger, owned };
    });
}
/** The same claim, not merely the same task id: filing and attempt both have to agree. */
function sameClaim(current, other) {
    if (!current || !other)
        return false;
    return current.queueTask.generation === other.queueTask.generation && current.attempts === other.attempts;
}
/**
 * The same debt, not merely the same task. Asset, attempt and filing all have to agree:
 * two filings can produce the same asset on the same attempt and still be different work.
 */
function sameDebt(current, other) {
    if (!current || !other)
        return false;
    return current.resultAssetId === other.resultAssetId
        && current.attempts === other.attempts
        && current.generation === other.generation;
}
/** A deadline the clock has passed. An absent one is not expired — it is unknown. */
function lapsed(deadline, nowMs) {
    if (!deadline)
        return false;
    const parsed = Date.parse(deadline);
    return Number.isFinite(parsed) && parsed <= nowMs;
}
/** A commitment the Hub has stopped holding for us; it is free to re-dispatch the task. */
function commitmentExpired(claim, nowMs) {
    return lapsed(claim?.commitmentDeadline, nowMs);
}
function retryDelayMs(attempts) {
    return Math.min(COMPLETION_RETRY_BASE_MS * 2 ** Math.max(0, attempts - 1), COMPLETION_RETRY_CAP_MS);
}
/** A dead owner cannot prove remote non-delivery, regardless of the retry count. */
function completionDeliveryUnknown(entry) {
    return entry.dispatchState !== undefined
        || (entry.attempts === 0 && entry.lastError === 'completion_in_progress');
}
/** Queue ids the receiver writes carry this prefix, so the loop can tell hub work apart. */
export const HUB_QUEUE_PREFIX = 'hub-';
/** A task id becomes a filename, so it may only be what a filename may safely be. */
/** The queue entry already under this id, or null when there is none we can read. */
export function defaultReadQueueTask(dir, id) {
    try {
        const parsed = JSON.parse(readFileSync(join(dir, `${id}.json`), 'utf8'));
        return typeof parsed?.hubTaskId === 'string' ? parsed : null;
    }
    catch {
        return null;
    }
}
export function defaultWriteQueueTask(dir, task) {
    writeFileSync(join(dir, `${task.id}.json`), `${JSON.stringify(task, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
}
export function defaultRemoveQueueTask(dir, id) {
    rmSync(join(dir, `${id}.json`), { force: true });
}
function alreadyQueued(error) {
    return error?.code === 'EEXIST';
}
/**
 * File a claimed task under its queue id. An `EEXIST` is only "an earlier beat already did
 * this" when the register says that queue id is ours; otherwise the name belongs to a local
 * task, and treating the collision as success would hand its capsule to the Hub.
 */
export function fileClaim(deps, queueDir, claim) {
    // One write-ahead record before the queue file: the claim is already spent at the Hub,
    // so a crash here must leave behind both who owns the task (`owned`, or it can never be
    // delivered) and that it still needs queueing (`unqueued`, or nothing will retry it).
    const recorded = updateCompletionLedger(deps.ledgerPath, (ledger) => ({
        ...ledger,
        owned: { ...(ledger.owned ?? {}), [claim.id]: { queueTaskId: claim.id, hubTaskId: claim.hubTaskId, generation: claim.generation, ...(claim.commitmentDeadline ? { commitmentDeadline: claim.commitmentDeadline } : {}) } },
        unqueued: { ...(ledger.unqueued ?? {}), [claim.id]: { taskId: claim.id, queueTask: claim, attempts: ledger.unqueued?.[claim.id]?.attempts ?? 0, lastError: 'not queued yet' } },
    }));
    if (!recorded)
        return 'unrecorded';
    try {
        deps.write(queueDir, claim);
    }
    catch (error) {
        if (!alreadyQueued(error))
            throw error;
        // The name is taken. Only the file on disk can say by what — a register entry from a
        // previous filing proves nothing about what is sitting there now, and believing it is
        // how a local task's capsule gets reported as this claim's result.
        const existing = (deps.read ?? defaultReadQueueTask)(queueDir, claim.id);
        if (existing?.hubTaskId !== claim.hubTaskId) {
            // Not this claim's queue entry, so not its registration either: leaving it would make
            // `claimFor` answer for a task we never filed. Only this filing's registration goes —
            // the one written moments ago, above. The claim stays owed in `unqueued`.
            forgetOwned(deps.ledgerPath, claim.id, claim.generation);
            return 'name_taken';
        }
        if (existing.generation !== claim.generation) {
            // Same task, earlier filing. The Hub only let us claim it again because that filing
            // is over, so its queue entry is stale work: replace it. Taking its generation
            // instead would let that run's late result walk through the gate as this claim's.
            // Drop then create exclusively, so a file that changed between the read and the
            // write collides again instead of being silently overwritten.
            (deps.remove ?? defaultRemoveQueueTask)(queueDir, claim.id);
            deps.write(queueDir, claim);
        }
    }
    clearUnqueued(deps.ledgerPath, claim.id);
    return 'written';
}
function clearUnqueued(path, queueTaskId) {
    updateCompletionLedger(path, (ledger) => {
        if (!ledger.unqueued?.[queueTaskId])
            return null;
        const unqueued = { ...ledger.unqueued };
        delete unqueued[queueTaskId];
        return { ...ledger, unqueued };
    });
}
/**
 * Write the debt down, unless it is no longer owed. A report that failed while an
 * overlapping one succeeded must not come back as a pending debt: the Hub already has the
 * result, and re-sending it is how a settled task starts failing as `not_claimed`.
 * A recorded refusal may retry, retire an obsolete dispatch, or exhaust its budget.
 * A persistence failure is distinct from an obsolete response and is reported explicitly.
 */
function oweCompletion(ledgerPath, entry, error, nowMs) {
    return withLedgerLock(ledgerPath, () => {
        const ledger = readCompletionLedger(ledgerPath);
        const current = ledger.pending[entry.taskId];
        // This response owns only its exact write-ahead entry. A replaced debt is not
        // its acknowledgement to record, even if it shares the same task id.
        if (entry.generation === undefined || !sameDebt(current, entry) || current?.dispatchState !== 'in_progress')
            return 'obsolete';
        const owned = { ...(ledger.owned ?? {}) };
        const pending = { ...ledger.pending };
        const owner = owned[`${HUB_QUEUE_PREFIX}${entry.taskId}`];
        // An actual returned refusal settles this old dispatch's ambiguity. If the
        // claim moved on, retire only its matching marker, never the replacement claim.
        if (owner?.generation !== entry.generation) {
            delete pending[entry.taskId];
            return replaceCompletionLedger(ledgerPath, { ...ledger, pending }) ? 'obsolete' : 'unrecorded';
        }
        const attempts = entry.attempts + 1;
        if (attempts >= COMPLETION_MAX_ATTEMPTS) {
            delete pending[entry.taskId];
            delete owned[`${HUB_QUEUE_PREFIX}${entry.taskId}`];
            return replaceCompletionLedger(ledgerPath, { ...ledger, pending, owned }) ? 'abandoned' : 'unrecorded';
        }
        const next = { ...entry, attempts, nextAttemptMs: nowMs + retryDelayMs(attempts), lastError: error };
        delete next.dispatchState;
        pending[entry.taskId] = next;
        return replaceCompletionLedger(ledgerPath, { ...ledger, pending }) ? 'retryable' : 'unrecorded';
    }, 'unrecorded');
}
/**
 * What a wiring with no Hub client can still do: write the debt down. A task claimed before
 * a restart finishes in a process that may have no identity left, and dropping the report
 * there is the one outcome the Hub cannot recover from — it waits out the whole commitment.
 */
/** A returned refusal can retry; a throw does not prove whether the Hub accepted the POST. */
async function hubComplete(client, taskId, assetId) {
    try {
        const result = await client.completeTask(taskId, assetId);
        return result.ok ? { ok: true } : { ok: false, error: result.error ?? `hub ${result.status ?? 0}` };
    }
    catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : String(error), deliveryUnknown: true };
    }
}
const NO_RETRIES = async () => ({ retried: 0, completed: 0, abandoned: 0, pending: 0, unrecorded: 0, abandonedTasks: [] });
const NO_QUEUE_RETRIES = async () => ({ retried: 0, queued: 0, pending: 0, dropped: 0 });
/** Fix a filing's result under the same lock as the ownership check, before any send. */
function reserveCompletion(path, taskId, resultAssetId, generation, nowMs, error, attempts) {
    return withLedgerLock(path, () => {
        const ledger = readCompletionLedger(path);
        const owned = ledger.owned?.[`${HUB_QUEUE_PREFIX}${taskId}`];
        if (!owned)
            return { outcome: { taskId, completed: false, error: 'not_claimed' } };
        if (generation === undefined || owned.generation !== generation) {
            return { outcome: { taskId, completed: false, error: 'stale_generation' } };
        }
        const prior = ledger.pending[taskId];
        if (prior && (prior.generation === undefined || completionDeliveryUnknown(prior) || prior.generation === generation)) {
            return { outcome: { taskId, completed: false, pending: true,
                    ...(prior.generation === undefined ? { error: 'generation_unbound' }
                        : prior.generation === generation && prior.resultAssetId !== resultAssetId ? { error: 'completion_result_conflict' }
                            : completionDeliveryUnknown(prior) ? { error: 'completion_in_progress' }
                                : prior.lastError ? { error: prior.lastError } : {}) } };
        }
        const entry = { taskId, resultAssetId, generation, attempts,
            nextAttemptMs: nowMs + retryDelayMs(Math.max(attempts, 1)), lastError: error,
            ...(error === 'completion_in_progress' ? { dispatchState: 'in_progress' } : {}) };
        return replaceCompletionLedger(path, { ...ledger, pending: { ...ledger.pending, [taskId]: entry } })
            ? { entry } : { outcome: { taskId, completed: false, error, unrecorded: true } };
    }, { outcome: { taskId, completed: false, error, unrecorded: true } });
}
/** A live request owns its send through settlement; another beat cannot overlap it. */
function acquireCompletionDispatch(path, taskId) {
    const lock = `${path}.complete-${createHash('sha256').update(taskId).digest('hex')}.lock`;
    try {
        mkdirSync(dirname(path), { recursive: true });
        return { path: lock, owner: util.acquireLock(lock, { maxTries: 1, waitMs: 0 }) };
    }
    catch {
        return null;
    }
}
export function unsentCommitments(ledgerPath, now) {
    return {
        claimFor: (queueTaskId) => readCompletionLedger(ledgerPath).owned?.[queueTaskId] ?? null,
        complete: async (taskId, resultAssetId, generation) => {
            // The same gate as the live wiring: a debt is only worth recording for a claim this
            // node actually holds, under the filing that holds it.
            // Nothing can send this now, so writing it down is the whole job — and claiming a
            // retry the ledger never recorded would promise a delivery no later run can make.
            const reserved = reserveCompletion(ledgerPath, taskId, resultAssetId, generation, now(), 'task_receiver_disabled', 1);
            return 'outcome' in reserved ? reserved.outcome : { taskId, completed: false, error: 'task_receiver_disabled', pending: true };
        },
        retryCompletions: NO_RETRIES,
        retryQueueWrites: NO_QUEUE_RETRIES,
    };
}
export function liveCommitments(client, deps) {
    const { ledgerPath, now, queueDir } = deps;
    // Clearing a debt is itself a ledger write, and a write that did not land leaves the
    // record disagreeing with what the caller was told. `unrecorded` says so out loud.
    // The claim only goes with it when it is the claim this debt was made under: a later
    // filing shares the task id and is still held.
    const settle = (taskId, outcome, generation, onlyKnownDelivery = false) => {
        let protectedDebt;
        const persisted = updateCompletionLedger(ledgerPath, (ledger) => {
            // Expiry or changed ownership is not a remote acknowledgement. Recheck the
            // current debt under this write lock before releasing either it or its claim.
            const debt = ledger.pending[taskId];
            if (onlyKnownDelivery && debt && (debt.generation === undefined || completionDeliveryUnknown(debt))) {
                protectedDebt = debt;
                return null;
            }
            const queueTaskId = `${HUB_QUEUE_PREFIX}${taskId}`;
            const owned = { ...(ledger.owned ?? {}) };
            // The claim goes only when this debt can prove the claim is its own. A debt written
            // before the field existed cannot prove it, and an unknown generation must not read
            // as a wildcard: releasing a claim that a later filing now holds is worse than
            // leaving a dead register entry for the next filing to overwrite.
            if (generation !== undefined && owned[queueTaskId]?.generation === generation)
                delete owned[queueTaskId];
            const pending = { ...ledger.pending };
            // Only a bound debt belongs to this settlement. Legacy unbound evidence stays,
            // as does any entry that names another filing.
            if (debt?.generation !== undefined && debt.generation === generation)
                delete pending[taskId];
            return { ...ledger, pending, owned };
        });
        if (protectedDebt)
            return { taskId, completed: false, pending: true,
                error: protectedDebt.generation === undefined ? 'generation_unbound' : 'completion_in_progress' };
        return persisted ? outcome : { ...outcome, unrecorded: true };
    };
    // A debt is only this attempt's to settle while the ledger still holds the entry the
    // attempt was made against. A late response must never clear a newer one for another asset.
    const stillOurs = (entry) => {
        const current = readCompletionLedger(ledgerPath).pending[entry.taskId];
        return sameDebt(current, entry);
    };
    const report = async (taskId, resultAssetId, generation) => {
        const opening = readCompletionLedger(ledgerPath);
        const owned = opening.owned?.[`${HUB_QUEUE_PREFIX}${taskId}`];
        const before = opening.pending[taskId];
        // Only a claim this node registered may be completed, and only by the filing that
        // holds it. No record, or a record from a later filing, and the result is not ours to
        // hand over — the Hub cannot take a completion back once it has one.
        if (!owned)
            return { taskId, completed: false, error: 'not_claimed' };
        if (generation === undefined || owned.generation !== generation)
            return { taskId, completed: false, error: 'stale_generation' };
        if (before && (before.generation === undefined || completionDeliveryUnknown(before))) {
            return { taskId, completed: false, pending: true,
                error: before.generation === undefined ? 'generation_unbound'
                    : before.generation === generation && before.resultAssetId !== resultAssetId ? 'completion_result_conflict' : 'completion_in_progress' };
        }
        // The Hub holds a task for its claimant only until the commitment runs out. Past that
        // it may have re-dispatched the work, and a late report would overwrite whoever now
        // owns it — so stop, and name the orphaned asset loudly enough to be recoverable.
        if (commitmentExpired(owned, now())) {
            // This filing's commitment is over, so this filing's claim goes with it — scoped, so
            // a re-claim that happened in the meantime keeps the claim it made.
            return settle(taskId, { taskId, completed: false, error: 'commitment_expired' }, generation, true);
        }
        // A filing owes one result. Changing its asset cannot replace an ambiguous
        // completion or bypass backoff; only retryCompletions may send its saved debt.
        if (before && (before.generation === undefined || before.generation === generation)) {
            return { taskId, completed: false, pending: true,
                ...(before.generation === undefined ? { error: 'generation_unbound' }
                    : before.resultAssetId !== resultAssetId ? { error: 'completion_result_conflict' }
                        : before.lastError ? { error: before.lastError } : {}) };
        }
        const dispatch = acquireCompletionDispatch(ledgerPath, taskId);
        if (!dispatch) {
            const current = readCompletionLedger(ledgerPath).pending[taskId];
            return { taskId, completed: false, ...(current ? { pending: true } : { unrecorded: true }),
                error: current?.generation === generation && current.resultAssetId !== resultAssetId ? 'completion_result_conflict' : 'completion_busy' };
        }
        try {
            const reserved = reserveCompletion(ledgerPath, taskId, resultAssetId, generation, now(), 'completion_in_progress', 0);
            if ('outcome' in reserved)
                return reserved.outcome;
            const result = await hubComplete(client, taskId, resultAssetId);
            // Keep the write-ahead marker on network/timeouts or unclassified adapter throws.
            // Neither a released local lock nor an expired commitment proves non-delivery.
            if (!result.ok && result.deliveryUnknown)
                return { taskId, completed: false, pending: true, error: result.error };
            // The Hub has this asset. Whatever this filing owed is paid, including a debt another
            // attempt of the SAME filing recorded while we waited — leaving it would re-send a
            // completed task. A later filing's debt is another claim's and stays.
            if (result.ok)
                return settle(taskId, { taskId, completed: true }, generation);
            // The work is done and the Hub does not know it. Owe the report and retry it on
            // later beats — otherwise a transient 429 silently costs us the whole delivery.
            const recorded = oweCompletion(ledgerPath, reserved.entry, result.error, now());
            return { taskId, completed: false, error: result.error,
                ...(recorded === 'retryable' ? { pending: true } : recorded === 'unrecorded' ? { unrecorded: true } : {}) };
        }
        finally {
            util.releaseLock(dispatch.path, dispatch.owner);
        }
    };
    return {
        claimFor: (queueTaskId) => readCompletionLedger(ledgerPath).owned?.[queueTaskId] ?? null,
        complete: report,
        retryQueueWrites: async () => {
            const ledger = readCompletionLedger(ledgerPath);
            const owed = Object.values(ledger.unqueued ?? {});
            const out = { retried: 0, queued: 0, pending: owed.length, dropped: 0 };
            if (owed.length === 0 || !queueDir)
                return out;
            // What this pass decided, key by key. Replacing the whole `unqueued` map with a
            // snapshot taken before the work would delete any claim another writer filed while
            // this pass ran — the lock protects the write, not a stale picture carried into it.
            const settled = new Set();
            const requeued = new Map();
            const seen = new Map(owed.map((entry) => [entry.taskId, entry]));
            for (const entry of owed) {
                // A claim whose commitment ran out is not work any more, and neither is one whose
                // queue name is permanently taken: both would otherwise sit here being retried for
                // the life of the process.
                if (lapsed(entry.queueTask.commitmentDeadline, now()) || entry.attempts >= UNQUEUED_MAX_ATTEMPTS) {
                    settled.add(entry.taskId);
                    forgetOwned(ledgerPath, entry.taskId, entry.queueTask.generation);
                    out.dropped += 1;
                    continue;
                }
                out.retried += 1;
                try {
                    const filed = fileClaim(deps, queueDir, entry.queueTask);
                    if (filed === 'name_taken' || filed === 'unrecorded') {
                        requeued.set(entry.taskId, { ...entry, attempts: entry.attempts + 1, lastError: filed === 'name_taken' ? 'queue id taken by another task' : 'ownership could not be recorded' });
                        continue;
                    }
                    settled.add(entry.taskId);
                    out.queued += 1;
                }
                catch (error) {
                    requeued.set(entry.taskId, { ...entry, attempts: entry.attempts + 1, lastError: error instanceof Error ? error.message : String(error) });
                }
            }
            updateCompletionLedger(ledgerPath, (ledger) => {
                const unqueued = { ...(ledger.unqueued ?? {}) };
                // Each key is written back only while it still holds the claim this pass answered
                // for. A filing recorded by another writer meanwhile shares the task id and is not
                // this pass's to delete or to overwrite with an older generation and attempt count.
                for (const taskId of settled) {
                    if (sameClaim(unqueued[taskId], seen.get(taskId)))
                        delete unqueued[taskId];
                }
                for (const [taskId, entry] of requeued) {
                    if (sameClaim(unqueued[taskId], seen.get(taskId)))
                        unqueued[taskId] = entry;
                }
                return { ...ledger, unqueued };
            });
            out.pending = Object.keys(readCompletionLedger(ledgerPath).unqueued ?? {}).length;
            return out;
        },
        retryCompletions: async () => {
            const ledger = readCompletionLedger(ledgerPath);
            // Oldest due first, not insertion order: a fixed slice of an unsorted map lets the
            // same five debts hold every slot forever while the ones behind them expire unsent.
            const due = Object.values(ledger.pending)
                .filter((entry) => entry.generation !== undefined && !completionDeliveryUnknown(entry) && entry.nextAttemptMs <= now())
                .sort((left, right) => left.nextAttemptMs - right.nextAttemptMs)
                .slice(0, COMPLETION_RETRIES_PER_TICK);
            const out = { retried: 0, completed: 0, abandoned: 0, pending: Object.keys(ledger.pending).length, unrecorded: 0, abandonedTasks: [] };
            for (const entry of due) {
                // Only known-unsent or response-settled, generation-bound debt is retryable.
                // Unknown delivery and legacy evidence remain pending for authoritative reconciliation.
                const dispatch = acquireCompletionDispatch(ledgerPath, entry.taskId);
                if (!dispatch)
                    continue;
                try {
                    if (!stillOurs(entry))
                        continue;
                    out.retried += 1;
                    const owned = readCompletionLedger(ledgerPath).owned?.[`${HUB_QUEUE_PREFIX}${entry.taskId}`];
                    if (commitmentExpired(owned, now())) {
                        if (!stillOurs(entry))
                            continue;
                        // A debt the ledger still holds has not been let go of, whatever this tick says.
                        const expired = settle(entry.taskId, { taskId: entry.taskId, completed: false }, entry.generation, true);
                        if (expired.pending) {
                            out.retried -= 1;
                            continue;
                        }
                        if (expired.unrecorded) {
                            out.unrecorded += 1;
                            continue;
                        }
                        out.abandoned += 1;
                        out.abandonedTasks.push({ taskId: entry.taskId, resultAssetId: entry.resultAssetId, lastError: 'commitment_expired' });
                        continue;
                    }
                    // The same gate the first report passed: a debt with no claim behind it, or one
                    // whose claim moved on to a later filing, is not ours to send. Drop it, and leave
                    // any claim that is not this debt's alone — it is still held.
                    if (!owned || owned.generation !== entry.generation) {
                        if (stillOurs(entry)) {
                            const stale = settle(entry.taskId, { taskId: entry.taskId, completed: false }, entry.generation, true);
                            if (stale.pending)
                                out.retried -= 1;
                        }
                        continue;
                    }
                    // Reserve this exact known-unsent or response-settled retry under the lock. A snapshot
                    // selected before another process crashed must not revive its now-unknown send.
                    let marked;
                    const reserved = updateCompletionLedger(ledgerPath, (ledger) => {
                        const current = ledger.pending[entry.taskId];
                        const owner = ledger.owned?.[`${HUB_QUEUE_PREFIX}${entry.taskId}`];
                        if (!sameDebt(current, entry) || !current || completionDeliveryUnknown(current)
                            || current.nextAttemptMs !== entry.nextAttemptMs || current.lastError !== entry.lastError
                            || owner?.generation !== entry.generation || commitmentExpired(owner, now()))
                            return null;
                        marked = { ...current, dispatchState: 'in_progress' };
                        return { ...ledger, pending: { ...ledger.pending, [entry.taskId]: marked } };
                    });
                    if (!reserved) {
                        out.unrecorded += 1;
                        continue;
                    }
                    if (!marked)
                        continue;
                    const result = await hubComplete(client, entry.taskId, entry.resultAssetId);
                    // An unclassified throw leaves the actual dispatch unknown; do not spend a
                    // response-settled retry attempt or erase the marker. Other debts still drain.
                    if (!result.ok && result.deliveryUnknown)
                        continue;
                    if (result.ok) {
                        // The Hub has the result; the record must go even if a newer debt replaced it.
                        if (settle(entry.taskId, { taskId: entry.taskId, completed: true }, entry.generation).unrecorded)
                            out.unrecorded += 1;
                        out.completed += 1;
                        continue;
                    }
                    const recorded = oweCompletion(ledgerPath, marked, result.error, now());
                    if (recorded === 'unrecorded')
                        out.unrecorded += 1;
                    if (recorded === 'abandoned') {
                        out.abandoned += 1;
                        out.abandonedTasks.push({ taskId: entry.taskId, resultAssetId: entry.resultAssetId, lastError: result.error });
                    }
                }
                finally {
                    util.releaseLock(dispatch.path, dispatch.owner);
                }
            }
            out.pending = Object.keys(readCompletionLedger(ledgerPath).pending).length;
            return out;
        },
    };
}
/** The Hub task id behind an execute-queue id, or null when the task is local. */
export function hubTaskIdOf(queueTaskId) {
    return queueTaskId.startsWith(HUB_QUEUE_PREFIX) ? queueTaskId.slice(HUB_QUEUE_PREFIX.length) : null;
}