import { closeSync, constants, fstatSync, lstatSync, openSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { loadReferenceSystemLibrary } from '../benchmark/referenceNativeRuntime.js';
import { ProtectedAuditUnavailableError } from './protectedAuditRpc.js';
const retained = new Map();
const authority = (a, b) => a.dev === b.dev && a.ino === b.ino
    && a.uid === b.uid && a.gid === b.gid && a.mode === b.mode;
const identity = (a, b) => authority(a, b) && a.nlink === b.nlink;
/** A permanent private inode with a kernel lock, never stale-lock deletion or PID guessing. */
export function acquireProtectedAuditStartupOwner(socketPath, serviceUid) {
    if (!['linux', 'darwin'].includes(process.platform))
        throw new ProtectedAuditUnavailableError('startup_runtime_unsupported');
    const directory = dirname(socketPath), path = join(directory, '.protected-audit-startup.lock');
    if (retained.has(path))
        throw new ProtectedAuditUnavailableError('startup_cleanup_unknown');
    const uid = BigInt(serviceUid);
    const parent = lstatSync(directory, { bigint: true });
    if (!parent.isDirectory() || parent.isSymbolicLink() || parent.uid !== uid || (parent.mode & 18n) !== 0n) {
        throw new ProtectedAuditUnavailableError('startup_parent_untrusted');
    }
    // Retain the actual LibraryHandle and native function for the entire owner lifetime (including Bun GC).
    const library = loadReferenceSystemLibrary(null);
    const flock = library.func('int flock(int fd, int operation)');
    const fd = openSync(path, constants.O_RDWR | constants.O_CREAT | constants.O_NOFOLLOW | constants.O_NONBLOCK, 0o600);
    let closed = false, poisoned = false;
    let opened;
    try {
        opened = fstatSync(fd, { bigint: true });
    }
    catch (error) {
        try {
            closeSync(fd);
        }
        catch (cleanup) {
            throw new AggregateError([error, cleanup], 'protected_audit_unavailable: startup_cleanup_unknown');
        }
        throw error;
    }
    const owner = {
        assert() {
            if (closed || poisoned)
                throw new ProtectedAuditUnavailableError('startup_cleanup_unknown');
            const currentParent = lstatSync(directory, { bigint: true });
            const current = lstatSync(path, { bigint: true }), actual = fstatSync(fd, { bigint: true });
            // Publishing/removing siblings may change a directory's link count; its
            // inode and access authority must remain exact throughout ownership.
            if (!authority(parent, currentParent) || !currentParent.isDirectory() || currentParent.isSymbolicLink()
                || (currentParent.mode & 18n) !== 0n || !identity(opened, current) || !identity(opened, actual)
                || !current.isFile() || current.isSymbolicLink() || current.uid !== uid
                || current.nlink !== 1n || (current.mode & 4095n) !== 384n || current.size !== 0n) {
                throw new ProtectedAuditUnavailableError('startup_owner_untrusted');
            }
        },
        release() {
            if (closed)
                return;
            if (poisoned)
                throw new ProtectedAuditUnavailableError('startup_cleanup_unknown');
            try {
                closeSync(fd);
                closed = true;
            }
            catch (error) {
                poisoned = true;
                retained.set(path, owner);
                throw new ProtectedAuditUnavailableError('startup_cleanup_unknown', { cause: error });
            }
            // Keep the fixed loaded library alive until after kernel fd release.
            void library;
        },
    };
    try {
        owner.assert();
        if (flock(fd, 2 | 4) !== 0)
            throw new ProtectedAuditUnavailableError('startup_owner_busy');
        owner.assert();
        return owner;
    }
    catch (error) {
        try {
            owner.release();
        }
        catch (cleanup) {
            throw new AggregateError([error, cleanup], 'protected_audit_unavailable: startup_cleanup_unknown');
        }
        throw error;
    }
}