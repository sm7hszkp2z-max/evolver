import { win32 } from 'node:path';
import { referenceFilePath } from '../benchmark/referenceAccess.js';
import { createWindowsSnapshotApi } from '../events/boundedAuditWindows.js';
const missing = (error) => error?.code === 'ENOENT';
const valid = (handle) => typeof handle === 'bigint' && handle > 0n
    && handle !== 0xffffffffn && handle !== 0xffffffffffffffffn;
const identity = (s) => `${s.volume}:${s.index}:${s.creation}:${s.attributes}`;
const fingerprint = (s) => `${identity(s)}:${s.size}:${s.write}:${s.change}:${s.links}`;
function key(path) {
    try {
        return referenceFilePath(path.startsWith('\\\\?\\') ? path.slice(4) : path);
    }
    catch {
        throw new Error('unsafe_snapshot_path');
    }
}
function safe(info, directory) {
    if (!Number.isInteger(info.volume) || !Number.isInteger(info.attributes) || !Number.isInteger(info.links)
        || typeof info.index !== 'bigint' || info.index < 0n || typeof info.size !== 'bigint' || info.size < 0n
        || typeof info.creation !== 'bigint' || typeof info.write !== 'bigint' || typeof info.change !== 'bigint'
        || (info.attributes & 0x400) !== 0 || Boolean(info.attributes & 0x10) !== directory || (!directory && info.links !== 1)) {
        throw new Error('unsafe_snapshot_path');
    }
}
/** One snapshot owns all ancestors until final verification/cleanup. Every descent uses
 * FILE_OPEN relative to a retained no-share-delete directory HANDLE. File reads allow
 * concurrent writers, detected by full HANDLE metadata before/after and by named reopen
 * during the outer cross-file verify. No Node lstat/fstat identity is mixed into this path.
 * An aborted in-flight open/read is awaited by the detached outer task, then cleaned up;
 * no new work is submitted after check() observes cancellation.
 */
export class WindowsSnapshotReader {
    budget;
    api;
    // Ownership is per acquisition, not per numeric HANDLE: Windows can reuse a closed value.
    retained = new Set();
    acquisitions = new Set();
    directories = new Map();
    closing;
    closed = false;
    constructor(budget, api) {
        this.budget = budget;
        budget.check();
        this.api = api ?? createWindowsSnapshotApi();
    }
    check() {
        if (this.closed)
            throw new Error('snapshot_closed');
        this.budget.check();
    }
    own(run) {
        const cleanup = { run, pending: new Set() };
        this.retained.add(cleanup);
        return cleanup;
    }
    cleanupError(errors, cleanup) {
        return Object.assign(new AggregateError(errors, 'windows snapshot cleanup failed'), {
            retryCleanup: () => cleanup ? this.release(cleanup) : this.close(),
        });
    }
    acquire(run) {
        const pending = this.acquireOwned(run);
        this.acquisitions.add(pending);
        return pending.finally(() => { this.acquisitions.delete(pending); });
    }
    async acquireOwned(run) {
        this.check();
        let handle;
        try {
            handle = await run();
        }
        catch (error) {
            const retry = error?.retryCleanup;
            if (typeof retry === 'function') {
                const cleanup = this.own(() => retry.call(error));
                // A close in progress must include late native cleanup ownership.
                if (this.closed) {
                    try {
                        await this.release(cleanup);
                    }
                    catch (failure) {
                        throw this.cleanupError([error, failure], cleanup);
                    }
                }
                throw this.cleanupError([error], cleanup);
            }
            throw error;
        }
        if (!valid(handle))
            throw new Error('unsafe_snapshot_path');
        const cleanup = this.own(() => this.api.close(handle));
        try {
            this.check();
        }
        catch (error) {
            // The acquisition cleans its late result before settling. close() waits for
            // that settlement; the outer deadline independently releases the caller.
            try {
                await this.release(cleanup);
            }
            catch (failure) {
                throw this.cleanupError([error, failure], cleanup);
            }
            throw error;
        }
        return { handle, cleanup };
    }
    async checked(owned, expected, directory, root = false) {
        try {
            return this.validate(owned, expected, directory, root);
        }
        catch (error) {
            try {
                await this.release(owned.cleanup);
            }
            catch (failure) {
                throw this.cleanupError([error, failure], owned.cleanup);
            }
            throw error;
        }
    }
    validate(owned, expected, directory, root) {
        this.check();
        const { handle } = owned;
        const info = this.api.info(handle);
        safe(info, directory);
        const final = this.api.finalPath(handle);
        const path = final.startsWith('\\\\?\\') ? final.slice(4) : final;
        // Accept native long spellings of 8.3 components, but never another parent or a reparse target.
        if (this.api.fileType(handle) !== 1 || (root ? key(path) !== key(expected)
            : key(win32.dirname(path)) !== key(win32.dirname(expected))))
            throw new Error('unsafe_snapshot_path');
        this.check();
        return { ...owned, info, path };
    }
    child(parent, name, directory) {
        // NtCreateFile uses RootDirectory on a native worker. Keep that acquisition
        // alive until the submitted open (and any late-result cleanup) has settled.
        const pending = this.acquire(() => this.api.child(parent.handle, name, directory));
        parent.cleanup.pending.add(pending);
        return pending.finally(() => { parent.cleanup.pending.delete(pending); });
    }
    current(file, directory) {
        this.check();
        const info = this.api.info(file.handle);
        safe(info, directory);
        if (identity(info) !== identity(file.info) || key(this.api.finalPath(file.handle)) !== key(file.path)
            || this.api.fileType(file.handle) !== 1)
            throw new Error('snapshot_changed');
        this.check();
        return info;
    }
    parts(path) {
        // Reject caller device/UNC paths before normalization; ordinary relative paths retain Node semantics.
        if (/^(?:\\\\|\/\/)/.test(path))
            throw new Error('unsafe_snapshot_path');
        const normalized = win32.resolve(path);
        key(normalized);
        const drive = win32.parse(normalized).root;
        const segments = normalized.slice(drive.length).split('\\').filter(Boolean);
        if (segments.length > 128)
            throw new Error('unsafe_snapshot_path');
        for (const name of segments) {
            if (Buffer.byteLength(name, 'utf16le') > 510)
                throw new Error('unsafe_snapshot_path');
            key(`C:\\${name}`);
        }
        return { drive, segments };
    }
    async directory(drive, segments) {
        this.check();
        let cachedKey = key(drive);
        let parent = this.directories.get(cachedKey);
        if (!parent) {
            parent = await this.checked(await this.acquire(() => this.api.root(drive)), drive, true, true);
            this.directories.set(cachedKey, parent);
        }
        else
            this.current(parent, true);
        for (const name of segments) {
            // A Windows directory can opt into case sensitivity. Only the OS may collapse spellings.
            this.check();
            cachedKey += `/${name}`;
            const existing = this.directories.get(cachedKey);
            if (existing) {
                this.current(existing, true);
                parent = existing;
                continue;
            }
            let owned;
            const ancestor = parent;
            try {
                owned = await this.child(ancestor, name, true);
            }
            catch (error) {
                if (error?.retryCleanup)
                    throw error;
                this.check();
                if (missing(error))
                    return undefined;
                throw error;
            }
            parent = await this.checked(owned, win32.join(ancestor.path, name), true);
            this.directories.set(cachedKey, parent);
        }
        return parent;
    }
    async stat(path, directory = false) {
        this.check();
        if (directory) {
            const { drive, segments } = this.parts(path);
            const opened = await this.directory(drive, segments);
            return opened ? identity(this.current(opened, true)) : 'missing';
        }
        const file = await this.open(path);
        if (!file)
            return 'missing';
        try {
            return (await file.stat()).state;
        }
        finally {
            await file.close();
        }
    }
    async open(path) {
        this.check();
        const { drive, segments } = this.parts(path);
        const name = segments.pop();
        if (!name)
            throw new Error('unsafe_snapshot_path');
        const parent = await this.directory(drive, segments);
        if (!parent)
            return undefined;
        let owned;
        try {
            owned = await this.child(parent, name, false);
        }
        catch (error) {
            if (error?.retryCleanup)
                throw error;
            this.check();
            if (missing(error))
                return undefined;
            throw error;
        }
        const file = await this.checked(owned, win32.join(parent.path, name), false);
        // close/cancellation may start after validation but before this continuation.
        // Rejected publication still owns its file until cleanup succeeds, just like validation.
        try {
            this.check();
        }
        catch (error) {
            try {
                await this.release(owned.cleanup);
            }
            catch (failure) {
                throw this.cleanupError([error, failure], owned.cleanup);
            }
            throw error;
        }
        const { handle, cleanup } = owned;
        let position = 0, closed = false, reading = false;
        const live = () => { this.check(); if (closed || cleanup.running)
            throw new Error('snapshot_closed'); };
        return {
            stat: async () => { live(); const info = this.current(file, false); return { state: fingerprint(info), size: info.size }; },
            read: async (buffer) => {
                live();
                if (reading)
                    throw new Error('snapshot_read_busy');
                if (buffer.length < 1 || buffer.length > 64 * 1024)
                    throw new Error('snapshot_byte_limit');
                const before = fingerprint(this.current(file, false));
                reading = true;
                const pending = Promise.resolve().then(() => { live(); return this.api.read(handle, buffer, position); });
                cleanup.pending.add(pending);
                try {
                    const count = await pending;
                    live();
                    if (fingerprint(this.current(file, false)) !== before)
                        throw new Error('snapshot_changed');
                    if (!Number.isInteger(count) || count < 0 || count > buffer.length)
                        throw new Error('snapshot_invalid_read');
                    position += count;
                    return count;
                }
                finally {
                    cleanup.pending.delete(pending);
                    reading = false;
                }
            },
            close: async () => {
                // Admission ends at the first close attempt, even if native cleanup fails.
                // release retains the acquisition until success and safely retries it.
                closed = true;
                await this.release(cleanup);
            },
        };
    }
    release(cleanup) {
        if (!this.retained.has(cleanup))
            return Promise.resolve();
        // Publish the shared promise before invoking native code (including synchronous throws).
        // Keep failed ownership for explicit retry; never resubmit a successful close.
        return cleanup.running ??= Promise.resolve().then(async () => {
            await Promise.allSettled([...cleanup.pending]);
            await cleanup.run();
        }).then(() => {
            this.retained.delete(cleanup);
        }).finally(() => { delete cleanup.running; });
    }
    close() {
        this.closed = true;
        return this.closing ??= Promise.resolve().then(async () => {
            // Stop admission first, then collect every ownership returned by submitted opens.
            // Rejected acquisitions retain cleanup separately; only final release decides success.
            await Promise.allSettled([...this.acquisitions]);
            const errors = [];
            for (const cleanup of [...this.retained].reverse()) {
                try {
                    await this.release(cleanup);
                }
                catch (error) {
                    errors.push(error);
                }
            }
            if (errors.length)
                throw this.cleanupError(errors);
        }).finally(() => { this.closing = undefined; });
    }
}