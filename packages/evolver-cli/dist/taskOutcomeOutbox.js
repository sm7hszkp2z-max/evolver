/**
 * Durable task-wide Hub outcome delivery. One committed queue claim owns one
 * operation, independently of its task id or any exact-asset reuse-result. A
 * network send is marked ambiguous on disk before it begins and is never
 * replayed without independent reconciliation evidence.
 */
import { createHash, randomUUID } from 'node:crypto';
import { closeSync, constants, existsSync, fsyncSync, lstatSync, openSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync, } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { hub } from '@evomap/evolver-core';
import { prepareOutboxDirectory, withOutboxLock } from './outboxLock.js';
import { FeedbackNotDispatchedError } from './feedbackOutbox.js';
const SCHEMA_VERSION = 'autoexec-task-outcome-outbox.v1';
const OPERATION_PREFIX = 'autoexec-task-outcome:';
const OPERATION_ID = /^autoexec-task-outcome:[a-f0-9]{64}$/;
const SHA256_ID = /^sha256:[a-f0-9]{64}$/;
const ROW_NAME = /^[a-f0-9]{64}\.json$/;
const MAX_ROW_BYTES = 64 * 1024;
const MAX_SIGNALS = 32;
const MAX_SIGNAL_CHARS = 160;
export class TaskOutcomeOutboxError extends Error {
    constructor(message) {
        super(message);
        this.name = 'TaskOutcomeOutboxError';
    }
}
function digest(value) {
    return createHash('sha256').update(value, 'utf8').digest('hex');
}
function hasControlCharacter(value) {
    return [...value].some((character) => {
        const code = character.charCodeAt(0);
        return code < 32 || code === 127;
    });
}
function exactString(value, label, maxLength = 256) {
    if (typeof value !== 'string' || !value || value.length > maxLength || hasControlCharacter(value)) {
        throw new TaskOutcomeOutboxError(`invalid ${label}`);
    }
    return value;
}
function safeReason(value, label) {
    if (typeof value !== 'string' || !value || value.length > 1024) {
        throw new TaskOutcomeOutboxError(`invalid ${label}`);
    }
    const cleaned = [...hub.redactString(value)].map((character) => {
        const code = character.charCodeAt(0);
        return code < 32 || code === 127 ? ' ' : character;
    }).join('').trim();
    if (!cleaned)
        throw new TaskOutcomeOutboxError(`invalid ${label}`);
    return cleaned.slice(0, 256);
}
function receiptReason(value) {
    try {
        return safeReason(value, 'terminal reason');
    }
    catch {
        return 'outcome_not_recorded';
    }
}
function safeSignals(signals) {
    if (!Array.isArray(signals))
        throw new TaskOutcomeOutboxError('invalid task signals');
    const out = [];
    const seen = new Set();
    for (const item of signals) {
        if (out.length >= MAX_SIGNALS)
            break;
        if (typeof item !== 'string')
            continue;
        const cleaned = [...hub.redactString(item)].map((character) => {
            const code = character.charCodeAt(0);
            return code < 32 || code === 127 ? ' ' : character;
        }).join('').trim().slice(0, MAX_SIGNAL_CHARS);
        if (!cleaned || seen.has(cleaned))
            continue;
        seen.add(cleaned);
        out.push(cleaned);
    }
    return out;
}
function copyUse(use) {
    if (use.schemaVersion !== 'applied-use.v1'
        || !SHA256_ID.test(use.assetId)
        || !exactString(use.geneId, 'gene id')
        || !exactString(use.cycleId, 'cycle id')
        || !['hub', 'local', 'migrated', 'unknown'].includes(use.source)
        || !['success', 'failed', 'inert', 'inconclusive'].includes(use.outcome)
        || (use.producedValue !== null && typeof use.producedValue !== 'boolean')
        || use.applicationBinding !== 'selected_execution'
        || use.verification !== 'unverified') {
        throw new TaskOutcomeOutboxError('invalid applied-use evidence');
    }
    if (use.outcome === 'success' && use.producedValue !== true)
        throw new TaskOutcomeOutboxError('success lacks produced value');
    if (use.outcome === 'inert' && use.producedValue !== false)
        throw new TaskOutcomeOutboxError('inert outcome has produced value');
    if (use.hubOriginDestinationId !== undefined) {
        if (!SHA256_ID.test(use.hubOriginDestinationId))
            throw new TaskOutcomeOutboxError('invalid Hub origin destination id');
        if (use.source !== 'hub')
            throw new TaskOutcomeOutboxError('non-Hub use has Hub origin');
    }
    return {
        schemaVersion: 'applied-use.v1', assetId: use.assetId, geneId: use.geneId,
        cycleId: use.cycleId, source: use.source, outcome: use.outcome,
        producedValue: use.producedValue, applicationBinding: 'selected_execution',
        verification: 'unverified',
        ...(use.hubOriginDestinationId ? { hubOriginDestinationId: use.hubOriginDestinationId } : {}),
    };
}
function outcomeStatus(verdictStatus, producedValue, use) {
    if (use?.outcome === 'inert' || use?.outcome === 'inconclusive')
        return null;
    if (verdictStatus === 'solidified') {
        // A legacy verdict without a production result has no positive evidence.
        if (producedValue !== true)
            return null;
        if (use?.outcome === 'failed')
            throw new TaskOutcomeOutboxError('success verdict/applied-use mismatch');
        return 'success';
    }
    if (verdictStatus === 'failed') {
        if (use?.outcome === 'success')
            throw new TaskOutcomeOutboxError('failure verdict/applied-use mismatch');
        return 'failed';
    }
    return null;
}
function reportFor(signals, verdictStatus, producedValue, use, score, destinationId) {
    const status = outcomeStatus(verdictStatus, producedValue, use);
    if (status === null)
        return null;
    if (score !== undefined && (!Number.isFinite(score) || score < 0 || score > 1)) {
        throw new TaskOutcomeOutboxError('invalid outcome score');
    }
    const exactHubAsset = use?.source === 'hub' && use.hubOriginDestinationId === destinationId
        && use.outcome === status
        && use.applicationBinding === 'selected_execution' && use.verification === 'unverified'
        ? use.assetId : undefined;
    return {
        signals: [...signals], status,
        ...(score !== undefined ? { score } : {}),
        ...(exactHubAsset ? { usedAssetIds: [exactHubAsset] } : {}),
    };
}
export function taskOutcomeIdentity(claimRoot) {
    const claimRootDigest = digest(exactString(claimRoot, 'claim root', 1024));
    return { operationId: `${OPERATION_PREFIX}${claimRootDigest}`, claimRootDigest };
}
function immutablePayload(row) {
    return {
        schemaVersion: row.schemaVersion, operationId: row.operationId,
        claimRootDigest: row.claimRootDigest, taskId: row.taskId,
        ...(row.generation ? { generation: row.generation } : {}),
        destinationId: row.destinationId, verdictStatus: row.verdictStatus, agentInvoked: row.agentInvoked,
        ...(row.producedValue !== undefined ? { producedValue: row.producedValue } : {}),
        ...(row.appliedUse ? { appliedUse: row.appliedUse } : {}),
        report: row.report,
    };
}
/** A recovered queue claim keeps its original destination when the report and verdict agree. */
function committedEvidencePayload(row) {
    const payload = immutablePayload(row);
    delete payload['destinationId'];
    // usedAssetIds is a destination-specific projection of immutable use evidence.
    // A restarted claim may see a different destination but retains the saved row.
    const report = { ...row.report };
    delete report.usedAssetIds;
    payload['report'] = report;
    return payload;
}
function payloadDigest(row) {
    return digest(JSON.stringify(immutablePayload(row)));
}
function frozen(value) {
    if (value && typeof value === 'object') {
        for (const child of Object.values(value))
            frozen(child);
        Object.freeze(value);
    }
    return value;
}
function validateRecord(value, expectedOperationId) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw new TaskOutcomeOutboxError('invalid task outcome record');
    }
    const row = value;
    if (row.schemaVersion !== SCHEMA_VERSION || row.operationId !== expectedOperationId
        || !OPERATION_ID.test(row.operationId)
        || row.operationId !== `${OPERATION_PREFIX}${row.claimRootDigest}`
        || !/^[a-f0-9]{64}$/.test(row.claimRootDigest)
        || !SHA256_ID.test(row.destinationId)
        || row.agentInvoked !== true
        || !Number.isSafeInteger(row.revision) || row.revision < 1
        || !['pending', 'acknowledged'].includes(row.localStatus)
        || !['pending', 'ambiguous', 'acknowledged', 'terminal'].includes(row.networkStatus)
        || typeof row.preparedAt !== 'string') {
        throw new TaskOutcomeOutboxError('invalid task outcome record');
    }
    exactString(row.taskId, 'task id');
    if (row.generation !== undefined)
        exactString(row.generation, 'generation');
    if (row.producedValue !== undefined && typeof row.producedValue !== 'boolean') {
        throw new TaskOutcomeOutboxError('invalid produced value');
    }
    const use = row.appliedUse ? copyUse(row.appliedUse) : undefined;
    if (!row.report || !Array.isArray(row.report.signals)
        || row.report.signals.length > MAX_SIGNALS
        || row.report.signals.some((signal) => typeof signal !== 'string' || !signal
            || signal.length > MAX_SIGNAL_CHARS || hasControlCharacter(signal))) {
        throw new TaskOutcomeOutboxError('invalid task outcome report');
    }
    if (JSON.stringify(safeSignals(row.report.signals)) !== JSON.stringify(row.report.signals)) {
        throw new TaskOutcomeOutboxError('unsafe task outcome signals');
    }
    const expected = reportFor(row.report.signals, row.verdictStatus, row.producedValue, use, row.report.score, row.destinationId);
    if (!expected || JSON.stringify(row.report) !== JSON.stringify(expected)) {
        throw new TaskOutcomeOutboxError('task outcome report/evidence mismatch');
    }
    if (row.localStatus === 'acknowledged' && !row.localAcknowledgedAt) {
        throw new TaskOutcomeOutboxError('acknowledged local outcome has no timestamp');
    }
    if (row.networkStatus !== 'pending' && row.localStatus !== 'acknowledged') {
        throw new TaskOutcomeOutboxError('invalid task outcome dispatch state');
    }
    if ((row.networkStatus === 'ambiguous' || row.networkStatus === 'acknowledged'
        || (row.networkStatus === 'terminal' && !row.reconciliationEvidence)) && !row.dispatchStartedAt) {
        throw new TaskOutcomeOutboxError('invalid task outcome dispatch state');
    }
    if (row.networkStatus === 'terminal' && !row.dispatchStartedAt
        && (!row.reconciliationEvidence || !row.terminalReason)) {
        throw new TaskOutcomeOutboxError('invalid task outcome reconciliation state');
    }
    if ((row.networkStatus === 'acknowledged' || row.networkStatus === 'terminal') && !row.settledAt) {
        throw new TaskOutcomeOutboxError('settled task outcome has no timestamp');
    }
    if (row.payloadDigest !== payloadDigest(row)) {
        throw new TaskOutcomeOutboxError('task outcome payload digest mismatch');
    }
    return row;
}
function fsyncDirectory(path) {
    if (process.platform === 'win32')
        return;
    const fd = openSync(path, constants.O_RDONLY);
    try {
        fsyncSync(fd);
    }
    finally {
        closeSync(fd);
    }
}
function writeAtomic(path, row) {
    const dir = dirname(path);
    const temp = join(dir, `.${basename(path)}.${randomUUID()}.tmp`);
    let fd;
    try {
        fd = openSync(temp, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
        writeFileSync(fd, `${JSON.stringify(row)}\n`, 'utf8');
        fsyncSync(fd);
        closeSync(fd);
        fd = undefined;
        renameSync(temp, path);
        fsyncDirectory(dir);
    }
    finally {
        if (fd !== undefined)
            closeSync(fd);
        try {
            unlinkSync(temp);
        }
        catch {
            // Preserve the original write error; an ignored temp file can be swept later.
        }
    }
}
export class TaskOutcomeOutbox {
    dir;
    directory;
    reportedUnreadable = new Set();
    constructor(dir) {
        try {
            this.directory = prepareOutboxDirectory(dir);
        }
        catch {
            throw new TaskOutcomeOutboxError('unsafe task outcome outbox directory');
        }
        this.dir = this.directory.path;
    }
    path(operationId) {
        if (!OPERATION_ID.test(operationId))
            throw new TaskOutcomeOutboxError('invalid task outcome operation id');
        return join(this.dir, `${operationId.slice(OPERATION_PREFIX.length)}.json`);
    }
    get(operationId) {
        this.directory.assertTrusted();
        const path = this.path(operationId);
        if (!existsSync(path)) {
            this.directory.assertTrusted();
            return null;
        }
        const stat = lstatSync(path);
        if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_ROW_BYTES) {
            throw new TaskOutcomeOutboxError('unsafe task outcome outbox record');
        }
        let parsed;
        try {
            parsed = JSON.parse(readFileSync(path, 'utf8'));
        }
        catch {
            throw new TaskOutcomeOutboxError('corrupt task outcome outbox record');
        }
        const row = frozen(validateRecord(parsed, operationId));
        this.directory.assertTrusted();
        return row;
    }
    save(row) {
        row.payloadDigest = payloadDigest(row);
        writeAtomic(this.path(row.operationId), row);
        return frozen(row);
    }
    /** Called after the queue claim receipt is durable and before the claim is archived. */
    prepare(input) {
        if (input.task.id !== input.verdict.taskId
            || input.task.generation !== input.verdict.generation) {
            throw new TaskOutcomeOutboxError('task/verdict claim mismatch');
        }
        const taskId = exactString(input.task.id, 'task id');
        const identity = taskOutcomeIdentity(input.claimRoot);
        const failureKind = input.verdict.failureKind;
        const disposition = input.verdict.execution_terminal?.disposition;
        if (input.verdict.agentInvoked !== true
            || failureKind === 'cancelled' || failureKind === 'timeout'
            || failureKind === 'spawn_failed' || failureKind === 'permission_denied'
            || disposition === 'cancelled' || disposition === 'timed_out' || disposition === 'denied'
            || disposition === 'unsafe_to_replay' || disposition === 'crashed'
            || input.verdict.appliedUse?.outcome === 'inconclusive') {
            return withOutboxLock(this.directory, () => {
                if (this.get(identity.operationId))
                    throw new TaskOutcomeOutboxError('task outcome operation payload conflict');
                return null;
            });
        }
        const use = input.verdict.appliedUse ? copyUse(input.verdict.appliedUse) : undefined;
        if (input.verdict.status === 'failed') {
            if (use?.outcome === 'success')
                throw new TaskOutcomeOutboxError('failure verdict/applied-use mismatch');
            // The queue can produce a failed verdict before any cycle runs. Only a
            // recorded failed cycle outcome is evidence for Hub failure learning.
            if (input.verdict.outcome?.status !== 'failed') {
                return withOutboxLock(this.directory, () => {
                    if (this.get(identity.operationId)) {
                        throw new TaskOutcomeOutboxError('task outcome operation payload conflict');
                    }
                    return null;
                });
            }
        }
        const signals = safeSignals(input.task.signals);
        const report = reportFor(signals, input.verdict.status, input.verdict.producedValue, use, input.verdict.outcome?.score, input.destinationId);
        if (!report) {
            return withOutboxLock(this.directory, () => {
                if (this.get(identity.operationId))
                    throw new TaskOutcomeOutboxError('task outcome operation payload conflict');
                return null;
            });
        }
        if (!SHA256_ID.test(input.destinationId)) {
            throw new TaskOutcomeOutboxError('task outcome destination id required');
        }
        const candidate = {
            schemaVersion: SCHEMA_VERSION, ...identity, taskId,
            ...(input.task.generation ? { generation: exactString(input.task.generation, 'generation') } : {}),
            destinationId: input.destinationId, verdictStatus: input.verdict.status, agentInvoked: true,
            ...(input.verdict.producedValue !== undefined ? { producedValue: input.verdict.producedValue } : {}),
            ...(use ? { appliedUse: use } : {}), report, payloadDigest: '',
            localStatus: 'pending', networkStatus: 'pending', revision: 1,
            preparedAt: new Date().toISOString(),
        };
        candidate.payloadDigest = payloadDigest(candidate);
        return withOutboxLock(this.directory, () => {
            const existing = this.get(identity.operationId);
            if (existing) {
                if (existing.payloadDigest !== candidate.payloadDigest
                    && digest(JSON.stringify(committedEvidencePayload(existing)))
                        !== digest(JSON.stringify(committedEvidencePayload(candidate)))) {
                    throw new TaskOutcomeOutboxError('task outcome operation payload conflict');
                }
                return existing;
            }
            return this.save(candidate);
        });
    }
    rows() {
        this.directory.assertTrusted();
        const rows = [];
        for (const name of readdirSync(this.dir).filter((item) => ROW_NAME.test(item)).sort()) {
            const operationId = `${OPERATION_PREFIX}${name.slice(0, -5)}`;
            try {
                const row = this.get(operationId);
                if (row)
                    rows.push(row);
            }
            catch (error) {
                if (!(error instanceof TaskOutcomeOutboxError))
                    throw error;
                if (!this.reportedUnreadable.has(operationId)) {
                    this.reportedUnreadable.add(operationId);
                    try {
                        process.stderr.write(`[autoexec] task_outcome_outbox_record_unreadable operation=${operationId}\n`);
                    }
                    catch { /* A closed diagnostic stream cannot block healthy outcomes. */ }
                }
            }
        }
        this.directory.assertTrusted();
        return rows;
    }
    localPending() {
        return this.rows().filter((row) => row.localStatus === 'pending');
    }
    /** Acknowledge only after the queue's local receipt is committed. */
    acknowledgeLocal(operationId) {
        return withOutboxLock(this.directory, () => {
            const row = this.get(operationId);
            if (!row)
                throw new TaskOutcomeOutboxError('task outcome operation not found');
            if (row.localStatus === 'acknowledged')
                return row;
            return this.save({ ...row, localStatus: 'acknowledged',
                localAcknowledgedAt: new Date().toISOString(), revision: row.revision + 1 });
        });
    }
    pending(destinationId) {
        return this.rows().filter((row) => row.localStatus === 'acknowledged'
            && row.networkStatus === 'pending' && (!destinationId || row.destinationId === destinationId));
    }
    /** An explicit false receipt is terminal; an indeterminate send remains ambiguous. */
    async deliver(operationId, destinationId, sender) {
        const started = withOutboxLock(this.directory, () => {
            const row = this.get(operationId);
            if (!row)
                throw new TaskOutcomeOutboxError('task outcome operation not found');
            if (row.localStatus !== 'acknowledged')
                throw new TaskOutcomeOutboxError('local task outcome is pending');
            if (row.networkStatus !== 'pending')
                throw new TaskOutcomeOutboxError('task outcome dispatch is not pending');
            if (!SHA256_ID.test(destinationId) || destinationId !== row.destinationId) {
                throw new TaskOutcomeOutboxError('task outcome destination mismatch');
            }
            return this.save({ ...row, networkStatus: 'ambiguous',
                dispatchStartedAt: new Date().toISOString(), revision: row.revision + 1 });
        });
        let receipt;
        let notDispatched = false;
        try {
            receipt = await sender(started.report);
        }
        catch (error) {
            if (error instanceof FeedbackNotDispatchedError)
                notDispatched = true;
            // Any other error may have reached Hub, so leave the started operation ambiguous.
        }
        return withOutboxLock(this.directory, () => {
            const current = this.get(operationId);
            if (!current || current.payloadDigest !== started.payloadDigest) {
                throw new TaskOutcomeOutboxError('task outcome dispatch owner changed');
            }
            // Evidence-based operator reconciliation can complete while the original
            // sender is still waiting. A late reply cannot overwrite that evidence.
            if (current.revision !== started.revision || current.networkStatus !== 'ambiguous')
                return current;
            if (notDispatched) {
                const pending = { ...current, networkStatus: 'pending', revision: current.revision + 1 };
                delete pending.dispatchStartedAt;
                delete pending.ambiguousReason;
                return this.save(pending);
            }
            if (receipt?.recorded === true) {
                return this.save({ ...current, networkStatus: 'acknowledged',
                    settledAt: new Date().toISOString(), revision: current.revision + 1 });
            }
            if (receipt?.recorded === false) {
                return this.save({ ...current, networkStatus: 'terminal',
                    terminalReason: receiptReason(receipt.reason),
                    settledAt: new Date().toISOString(), revision: current.revision + 1 });
            }
            return this.save({ ...current, ambiguousReason: 'indeterminate_response', revision: current.revision + 1 });
        });
    }
    /** A later receipt or operator evidence can settle ambiguity without resending. */
    reconcile(operationId, resolution) {
        return withOutboxLock(this.directory, () => {
            const row = this.get(operationId);
            if (!row)
                throw new TaskOutcomeOutboxError('task outcome operation not found');
            if (row.networkStatus === 'pending') {
                if (resolution.status !== 'terminal')
                    throw new TaskOutcomeOutboxError('task outcome operation is not ambiguous');
                if (row.localStatus !== 'acknowledged')
                    throw new TaskOutcomeOutboxError('local task outcome is pending');
            }
            else if (row.networkStatus !== 'ambiguous') {
                throw new TaskOutcomeOutboxError('task outcome operation is not ambiguous');
            }
            const evidence = safeReason(resolution.evidence, 'reconciliation evidence');
            const reconciled = { ...row };
            delete reconciled.ambiguousReason;
            if (resolution.status === 'acknowledged') {
                return this.save({ ...reconciled, networkStatus: 'acknowledged', settledAt: new Date().toISOString(),
                    reconciliationEvidence: evidence, revision: row.revision + 1 });
            }
            return this.save({ ...reconciled, networkStatus: 'terminal', settledAt: new Date().toISOString(),
                terminalReason: safeReason(resolution.reason, 'terminal reason'),
                reconciliationEvidence: evidence, revision: row.revision + 1 });
        });
    }
    /** Skip rows bound to another destination; never retry started or settled sends. */
    async flush(destinationId, sender) {
        if (!SHA256_ID.test(destinationId))
            throw new TaskOutcomeOutboxError('invalid task outcome destination id');
        let delivered = 0;
        let terminal = 0;
        let ambiguous = 0;
        for (const row of this.pending(destinationId)) {
            let result;
            try {
                result = await this.deliver(row.operationId, destinationId, sender);
            }
            catch (error) {
                // The pending list is a snapshot. A second process can begin or settle a later row
                // while this process awaits a prior send. Only that observed state change is safe
                // to skip; corruption, destination drift, and other delivery errors still fail closed.
                if (error instanceof TaskOutcomeOutboxError && error.message === 'task outcome dispatch is not pending') {
                    const current = this.get(row.operationId);
                    if (current?.localStatus === 'acknowledged' && current.destinationId === destinationId
                        && current.networkStatus !== 'pending')
                        continue;
                }
                throw error;
            }
            if (result.networkStatus === 'acknowledged')
                delivered++;
            else if (result.networkStatus === 'terminal')
                terminal++;
            else if (result.networkStatus === 'ambiguous')
                ambiguous++;
        }
        return { delivered, terminal, ambiguous };
    }
}