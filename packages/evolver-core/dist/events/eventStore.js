import { openSync, writeSync, fsyncSync, closeSync, statSync, readSync, mkdirSync, existsSync, truncateSync, readFileSync, lstatSync, readdirSync, } from 'node:fs';
import { dirname, join } from 'node:path';
import { monotonicFactory } from 'ulid';
import { acquireLock, releaseLock } from '../util/fileLock.js';
import { readRootEventHistory, readRootEventHistoryStrict, rootEventArchiveDir } from './eventArchive.js';
import { AuditBudget, AuditWriteSkipped, openAuditFile, commitAuditLine, withAuditLock } from './boundedAudit.js';
import { auditCleanupSequence, withAuditCleanup } from './auditCleanup.js';
import { contextDeliveryRootOwned, DeliveryMetadataInvalidError } from '../ops/geneContextDeliveryJournal.js';
import { protectedAuditConfigured, protectedAuditRpc, protectedAuditRpcSync, protectedAuditReadSnapshotSync, isProtectedAuditServiceProcess, ProtectedAuditUnavailableError } from './protectedAuditRpc.js';
// Monotonic ULIDs: plain ulid() randomizes the low 80 bits, so two ids minted in the SAME millisecond can sort
// out of order — the event log wants time-sortable eventIds (and a flaky CI test proved it). The monotonic
// factory increments within a millisecond, guaranteeing each successive eventId is strictly greater.
const makeUlid = monotonicFactory();
function namedIdentity(path) {
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1)
        throw new AuditWriteSkipped('path_changed');
    return `${stat.dev}:${stat.ino}:${stat.birthtimeMs}`;
}
function descriptorMatchesPath(stat, path) {
    // Windows admission holds a no-delete-share HANDLE and verifies its native
    // identity; POSIX names remain replaceable while the descriptor stays open.
    if (process.platform === 'win32')
        return true;
    const named = lstatSync(path);
    return named.isFile() && !named.isSymbolicLink() && named.nlink === 1
        && String(stat.dev) === String(named.dev) && String(stat.ino) === String(named.ino);
}
function targetMatches(expected, actual) {
    if (expected === null)
        return true;
    if (!expected.startsWith('['))
        return expected === actual;
    const values = JSON.parse(expected);
    return Array.isArray(values) && values.length === 2 && values.every(value => typeof value === 'string') && values.includes(actual);
}
import { rootEvent, EVENT_SCHEMA_VERSION } from './eventSchema.js';
/** 单行字节上限, 保 O_APPEND+write 在 ext4 的原子性 (军杰 §3.2). */
export const MAX_LINE_BYTES = 4096;
export const MAX_PROTECTED_HISTORY_BYTES = 256 * 1024 * 1024;
const auditFileLimit = () => isProtectedAuditServiceProcess() ? MAX_PROTECTED_HISTORY_BYTES : 64 * 1024 * 1024;
function assertProtectedHistoryCapacity(path, incoming) {
    if (!isProtectedAuditServiceProcess())
        return;
    let bytes = existsSync(path) ? lstatSync(path).size : 0;
    const archive = rootEventArchiveDir(path);
    try {
        for (const name of readdirSync(archive)) {
            if (/^root-events-\d{16}-\d{16}\.jsonl$/.test(name))
                bytes += lstatSync(join(archive, name)).size;
        }
    }
    catch (error) {
        if (error.code !== 'ENOENT')
            throw error;
    }
    if (bytes + incoming > MAX_PROTECTED_HISTORY_BYTES)
        throw new AuditWriteSkipped('protected_history_capacity');
}
function envelope(raw, identity) {
    return rootEvent.parse({
        ...identity,
        type: raw.type,
        schemaVersion: raw.schemaVersion ?? EVENT_SCHEMA_VERSION,
        replayability: raw.replayability ?? 'deterministic',
        payload: raw.payload ?? {},
        human: raw.human,
        actor: raw.actor ?? { kind: 'machine' },
        ...(raw.auditOperationId ? { auditOperationId: raw.auditOperationId } : {}),
        ...(raw.auditRequestHash ? { auditRequestHash: raw.auditRequestHash } : {}),
    });
}
/** Size-only preflight using the writer's schema and the longest generated envelope. No I/O or IDs consumed. */
export function fitsRootEventLine(raw) {
    const value = envelope(raw, { seq: Number.MAX_SAFE_INTEGER, eventId: '0'.repeat(26), ts: '9999-12-31T23:59:59.999Z' });
    return Buffer.byteLength(`${JSON.stringify(value)}\n`, 'utf8') <= MAX_LINE_BYTES;
}
export class LineTooLargeError extends Error {
    bytes;
    constructor(bytes) {
        super(`root_event line ${bytes}B exceeds ${MAX_LINE_BYTES}B; 大 payload 须走 artifact 引用`);
        this.bytes = bytes;
        this.name = 'LineTooLargeError';
    }
}
/** This error is minted only before append dispatch, never for an ambiguous filesystem failure. */
export class EventWriteNotCommittedError extends Error {
    operationId;
    constructor(operationId, cause) {
        super('event_write_not_committed', { cause });
        this.operationId = operationId;
    }
}
function checkWriteAdmission(options) {
    if (options.signal?.aborted || (options.deadlineAt !== undefined
        && (!Number.isFinite(options.deadlineAt) || Date.now() >= options.deadlineAt))) {
        throw new EventWriteNotCommittedError(options.operationId);
    }
}
// A prototype and matching method descriptors do not establish construction:
// a Proxy can report those values during admission and switch its method later.
const builtInEventStores = new WeakSet();
const builtInClockFunctions = new WeakMap();
/** 唯一权威事件流 (AE). single-writer / append-only / seq 递增 / fsync. */
export class EventStore {
    static isBuiltInObservationStore(value) {
        try {
            return value !== null && typeof value === 'object'
                && builtInEventStores.has(value)
                && Object.getPrototypeOf(value) === EventStore.prototype;
        }
        catch {
            return false;
        }
    }
    static usesBuiltInClock(value) {
        if (!EventStore.isBuiltInObservationStore(value))
            return false;
        const expected = builtInClockFunctions.get(value);
        return expected !== undefined && Object.getOwnPropertyDescriptor(value, 'now')?.value === expected;
    }
    path;
    lockPath;
    now;
    chain = Promise.resolve();
    constructor(opts) {
        this.path = opts.path;
        this.lockPath = `${opts.path}.lock`;
        this.now = opts.now ?? Date.now;
        if (!protectedAuditConfigured() && !isProtectedAuditServiceProcess())
            mkdirSync(dirname(this.path), { recursive: true });
        builtInEventStores.add(this);
        if (opts.now === undefined)
            builtInClockFunctions.set(this, this.now);
    }
    /** 唯一写路径: 生成 seq/eventId/ts, 校验, 原子 append + fsync. */
    async append(raw, options = {}) {
        options = { ...options };
        checkWriteAdmission(options);
        if (protectedAuditConfigured()) {
            try {
                return await protectedAuditRpc('append_root', this.path, raw, {
                    deadlineAt: options.deadlineAt ?? Date.now() + 30_000,
                    ...(options.operationId ? { operationId: options.operationId } : {}),
                    ...(options.signal ? { signal: options.signal } : {}),
                });
            }
            catch (cause) {
                // Only the authenticated service's existing explicit no-dispatch reply
                // proves this outcome. Lost/late transport receipts remain ambiguous.
                if (cause instanceof ProtectedAuditUnavailableError
                    && cause.message === 'protected_audit_unavailable: event_write_not_committed') {
                    throw new EventWriteNotCommittedError(options.operationId, cause);
                }
                throw cause;
            }
        }
        const run = this.chain.then(() => { checkWriteAdmission(options); return this.appendLocked(raw, options); });
        this.chain = run.then(() => undefined, () => undefined);
        return run;
    }
    appendLocked(raw, options) {
        // A background caller may resume after a later async projection acquired
        // this root. Never synchronously wait on resources whose cleanup needs this
        // event loop; refuse before dispatch so its durable work remains retryable.
        try {
            if (contextDeliveryRootOwned(this.path))
                throw new AuditWriteSkipped('delivery_cleanup_pending');
        }
        catch (cause) {
            throw new EventWriteNotCommittedError(options.operationId, cause);
        }
        // Crash-recoverable, pid-aware O_EXCL lock shared with every other persistence path (localJsonl /
        // materialStore / mailbox / pendingSignals): it reclaims a stale lock left by a crashed writer instead of
        // deadlocking every future append until the .lock is deleted by hand.
        acquireLock(this.lockPath);
        try {
            checkWriteAdmission(options);
            const seq = this.lastSeqFromFile() + 1;
            const evt = envelope(raw, {
                seq,
                eventId: makeUlid(),
                ts: new Date(this.now()).toISOString(),
            });
            const line = `${JSON.stringify(evt)}\n`;
            const bytes = Buffer.byteLength(line, 'utf8');
            if (bytes > MAX_LINE_BYTES)
                throw new LineTooLargeError(bytes);
            assertProtectedHistoryCapacity(this.path, bytes);
            const fd = openSync(this.path, 'a');
            try {
                // Lock acquisition, envelope construction and open may consume the
                // remaining budget synchronously. This is the final no-commit boundary.
                checkWriteAdmission(options);
                writeSync(fd, line);
                fsyncSync(fd);
            }
            finally {
                closeSync(fd);
            }
            return evt;
        }
        finally {
            releaseLock(this.lockPath);
        }
    }
    /** Bounded audit entry used only through Ingestor. Shares the envelope and cross-process writer lock. */
    static async appendBounded(raw, opts) {
        if (protectedAuditConfigured())
            return protectedAuditRpc('append_root_bounded', opts.path, raw, {
                deadlineAt: opts.deadlineAt ?? Date.now() + 30_000,
                ...(opts.signal ? { signal: opts.signal } : {}),
            });
        const budget = new AuditBudget(opts);
        budget.check();
        if (!fitsRootEventLine(raw))
            throw new LineTooLargeError(MAX_LINE_BYTES + 1);
        return withAuditLock(`${opts.path}.lock`, budget, async () => {
            const maxFileBytes = auditFileLimit();
            const handle = await openAuditFile(opts.path, maxFileBytes, budget);
            return withAuditCleanup(async () => {
                const stat = await handle.stat();
                const size = Math.min(8192, stat.size);
                const buffer = Buffer.alloc(size);
                let seq = 0;
                if (size > 0) {
                    budget.check();
                    const { bytesRead } = await handle.read(buffer, 0, size, stat.size - size);
                    if (bytesRead !== size)
                        throw new AuditWriteSkipped('tail_changed');
                    // Do not append to a partial/corrupt tail and make a previously readable log worse. The regular
                    // recovery entrypoint repairs interrupted writes before a subsequent hook can append again.
                    if (buffer[size - 1] !== 10)
                        throw new AuditWriteSkipped('partial_event_tail');
                    const lines = buffer.toString('utf8').split('\n').filter(Boolean);
                    let tail;
                    try {
                        tail = JSON.parse(lines.at(-1) ?? 'null');
                    }
                    catch {
                        throw new AuditWriteSkipped('invalid_event_tail');
                    }
                    const last = rootEvent.safeParse(tail);
                    if (!last.success || !Number.isSafeInteger(last.data.seq) || last.data.seq < 0 || last.data.seq >= Number.MAX_SAFE_INTEGER) {
                        throw new AuditWriteSkipped('invalid_event_tail');
                    }
                    seq = last.data.seq;
                }
                else
                    seq = readRootEventHistoryStrict(opts.path).at(-1)?.seq ?? 0;
                budget.check();
                const evt = envelope(raw, { seq: seq + 1, eventId: makeUlid(), ts: new Date((opts.now ?? Date.now)()).toISOString() });
                const line = `${JSON.stringify(evt)}\n`;
                assertProtectedHistoryCapacity(opts.path, Buffer.byteLength(line));
                await commitAuditLine(handle, line, maxFileBytes, budget);
                return evt;
            }, auditCleanupSequence([{ run: () => handle.close(), retryFailedOperation: true }]));
        });
    }
    /** Operation-bound delivery projection. Only Ingestor supplies validated authority. */
    static async projectContextDelivery(authority, opts, validate) {
        if (protectedAuditConfigured())
            throw new ProtectedAuditUnavailableError('delivery_projection_requires_protected_authority');
        const budget = new AuditBudget(opts);
        return withAuditLock(`${opts.path}.lock`, budget, async () => {
            let saved;
            try {
                saved = authority.read();
            }
            catch (error) {
                if (!(error instanceof DeliveryMetadataInvalidError))
                    throw error;
                authority.unknown('metadata_invalid');
                return 'unknown';
            }
            validate?.(saved.raw);
            if (saved.state === 'projected')
                return 'projected';
            if (saved.state === 'projecting' || saved.state === 'projection_unknown') {
                const plan = saved.plan;
                if (!plan || typeof plan.line !== 'string' || Buffer.byteLength(plan.line) > MAX_LINE_BYTES || !plan.line.endsWith('\n')
                    || !Number.isSafeInteger(plan.offset) || plan.offset < 0 || typeof plan.identity !== 'string') {
                    authority.unknown('metadata_invalid');
                    return 'unknown';
                }
                let validLine = false;
                try {
                    const parsed = rootEvent.safeParse(JSON.parse(plan.line));
                    validLine = parsed.success && JSON.stringify(envelope(saved.raw, parsed.data)) + '\n' === plan.line;
                }
                catch { /* Invalid JSON/envelope cannot certify a persisted projection. */ }
                if (!validLine) {
                    authority.unknown('metadata_invalid');
                    return 'unknown';
                }
                for (const locator of [plan, ...(plan.previous ? [plan.previous] : [])]) {
                    const archive = locator.archive;
                    if ((archive !== undefined && !/^root-events-\d{16}-\d{16}\.jsonl$/.test(archive))
                        || !Number.isSafeInteger(locator.offset) || locator.offset < 0)
                        continue;
                    const path = archive ? join(rootEventArchiveDir(opts.path), archive) : opts.path;
                    try {
                        if (namedIdentity(path) !== locator.identity)
                            continue;
                    }
                    catch (error) {
                        if (error.code === 'ENOENT')
                            continue;
                        throw error;
                    }
                    // Existing-only handles: absence never creates a new log or grants permission to replay.
                    const handle = await openAuditFile(path, auditFileLimit(), budget, true);
                    const found = await withAuditCleanup(async () => {
                        if (!descriptorMatchesPath(await handle.stat(), path) || namedIdentity(path) !== locator.identity)
                            return false;
                        const bytes = Buffer.from(plan.line), actual = Buffer.alloc(bytes.length);
                        const read = await handle.read(actual, 0, actual.length, locator.offset);
                        if (read.bytesRead !== bytes.length || !actual.equals(bytes))
                            return false;
                        await handle.sync();
                        if (!descriptorMatchesPath(await handle.stat(), path) || namedIdentity(path) !== locator.identity)
                            return false;
                        authority.projected();
                        return true;
                    }, auditCleanupSequence([{ run: () => handle.close(), retryFailedOperation: true }]));
                    if (found)
                        return 'projected';
                }
                authority.unknown('history_missing');
                return 'unknown';
            }
            if (saved.state !== 'confirmed')
                return 'unknown';
            if (!fitsRootEventLine(saved.raw))
                throw new LineTooLargeError(MAX_LINE_BYTES + 1);
            if (saved.targetIdentity) {
                try {
                    const named = lstatSync(opts.path);
                    if (!targetMatches(saved.targetIdentity, `${named.dev}:${named.ino}:${named.birthtimeMs}`) || named.isSymbolicLink() || named.nlink !== 1) {
                        authority.unknown('target_changed');
                        return 'unknown';
                    }
                }
                catch (error) {
                    if (error.code !== 'ENOENT')
                        throw error;
                    authority.unknown('target_changed');
                    return 'unknown';
                }
            }
            const handle = await openAuditFile(opts.path, auditFileLimit(), budget);
            return withAuditCleanup(async () => {
                const stat = await handle.stat();
                const fileIdentity = namedIdentity(opts.path);
                if (!descriptorMatchesPath(stat, opts.path) || !targetMatches(saved.targetIdentity, fileIdentity)) {
                    authority.unknown('target_changed');
                    return 'unknown';
                }
                const size = Math.min(8192, stat.size), buffer = Buffer.alloc(size);
                let seq = 0;
                if (size > 0) {
                    const read = await handle.read(buffer, 0, size, stat.size - size);
                    if (read.bytesRead !== size || buffer[size - 1] !== 10)
                        throw new AuditWriteSkipped('partial_event_tail');
                    const tail = rootEvent.safeParse(JSON.parse(buffer.toString('utf8').split('\n').filter(Boolean).at(-1)));
                    if (!tail.success || !Number.isSafeInteger(tail.data.seq) || tail.data.seq < 0 || tail.data.seq >= Number.MAX_SAFE_INTEGER)
                        throw new AuditWriteSkipped('invalid_event_tail');
                    seq = tail.data.seq;
                }
                else
                    seq = readRootEventHistoryStrict(opts.path).at(-1)?.seq ?? 0;
                budget.check();
                const evt = envelope(saved.raw, { seq: seq + 1, eventId: makeUlid(), ts: new Date((opts.now ?? Date.now)()).toISOString() });
                const line = `${JSON.stringify(evt)}\n`;
                assertProtectedHistoryCapacity(opts.path, Buffer.byteLength(line));
                authority.plan({ line, offset: stat.size, identity: fileIdentity });
                let dispatched = false;
                try {
                    await commitAuditLine(handle, line, auditFileLimit(), budget, true, { dispatched: () => {
                            const fresh = authority.read();
                            if (fresh.state !== 'projecting' || fresh.plan?.line !== line || namedIdentity(opts.path) !== fileIdentity)
                                throw new AuditWriteSkipped('projection_changed');
                            budget.check(); // Generation validation can consume the remaining admission budget.
                            dispatched = true;
                        }, rolledBack: () => { dispatched = false; } });
                }
                catch (error) {
                    if (!dispatched)
                        authority.notDispatched();
                    else
                        authority.unknown();
                    throw error;
                }
                // If this marker fails, the persisted exact line/locator remains readback-only.
                if (!descriptorMatchesPath(await handle.stat(), opts.path) || namedIdentity(opts.path) !== fileIdentity) {
                    authority.unknown();
                    return 'unknown';
                }
                authority.projected();
                return 'projected';
            }, auditCleanupSequence([{ run: () => handle.close(), retryFailedOperation: true }]));
        });
    }
    /** 读全部事件 (跳过尾部半行/损坏行). */
    readAll() {
        if (protectedAuditConfigured())
            return protectedAuditReadSnapshotSync('root', this.path);
        return readRootEventHistory(this.path);
    }
    /** Fail-closed replay for decision policies that cannot safely consume a partial history. */
    readAllStrict() {
        if (protectedAuditConfigured())
            return protectedAuditReadSnapshotSync('root_strict', this.path);
        return readRootEventHistoryStrict(this.path);
    }
    *iterate(fromSeq = 0) {
        for (const e of this.readAll())
            if (e.seq >= fromSeq)
                yield e;
    }
    tail(n = 1) {
        const all = this.readAll();
        return all.slice(Math.max(0, all.length - n));
    }
    /** 截断尾部半行 (崩溃恢复). */
    recover() {
        if (protectedAuditConfigured())
            return protectedAuditRpcSync('recover_root', this.path, undefined, { deadlineAt: Date.now() + 30_000 });
        if (!existsSync(this.path))
            return { truncated: false };
        const buf = readFileSync(this.path);
        if (buf.length === 0)
            return { truncated: false };
        const lastNl = buf.lastIndexOf(0x0a);
        if (lastNl === buf.length - 1)
            return { truncated: false };
        truncateSync(this.path, lastNl + 1);
        return { truncated: true };
    }
    lastSeqFromFile() {
        if (!existsSync(this.path))
            return readRootEventHistoryStrict(this.path).at(-1)?.seq ?? 0;
        const size = statSync(this.path).size;
        if (size === 0)
            return readRootEventHistoryStrict(this.path).at(-1)?.seq ?? 0;
        const readBytes = Math.min(8192, size);
        const fd = openSync(this.path, 'r');
        try {
            const buf = Buffer.alloc(readBytes);
            readSync(fd, buf, 0, readBytes, size - readBytes);
            const lines = buf.toString('utf8').split('\n').filter((l) => l.length > 0);
            for (let i = lines.length - 1; i >= 0; i--) {
                try {
                    const o = JSON.parse(lines[i]);
                    if (typeof o.seq === 'number')
                        return o.seq;
                }
                catch { /* skip */ }
            }
            return 0;
        }
        finally {
            closeSync(fd);
        }
    }
}