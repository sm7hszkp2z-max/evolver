/**
 * Short, cross-process critical sections for durable outbox state transitions.
 * Network I/O must happen outside this lock. The repository file lock owns
 * crashed-process recovery and refuses ambiguous live owners.
 */
import { dirname, join, resolve } from 'node:path';
import { lstatSync, mkdirSync } from 'node:fs';
import { hub, util } from '@evomap/evolver-core';
function unsafeDirectory() { throw new Error('unsafe outbox directory'); }
function assertDirectory(stat) {
    if (!stat.isDirectory() || stat.isSymbolicLink())
        unsafeDirectory();
}
function assertTrustedParents(path) {
    if (process.platform === 'win32') {
        new hub.PowerShellWindowsAclOps({ redactDiagnostics: true }).assertTrustedParent(path, true);
        return;
    }
    const uid = process.getuid?.();
    if (uid === undefined)
        unsafeDirectory();
    for (let current = path;; current = dirname(current)) {
        const stat = lstatSync(current, { bigint: true });
        assertDirectory(stat);
        if (stat.uid !== BigInt(uid) && stat.uid !== 0n)
            unsafeDirectory();
        if ((stat.mode & 18n) !== 0n && (stat.mode & 512n) === 0n)
            unsafeDirectory();
        if (dirname(current) === current)
            return;
    }
}
function createMissingDirectories(path) {
    const existing = lstatSync(path, { bigint: true, throwIfNoEntry: false });
    if (existing) {
        assertDirectory(existing);
        return;
    }
    const parent = dirname(path);
    if (parent === path)
        unsafeDirectory();
    createMissingDirectories(parent);
    assertTrustedParents(parent);
    let created = false;
    try {
        mkdirSync(path, { mode: 0o700 });
        created = true;
    }
    catch (error) {
        if (error.code !== 'EEXIST')
            throw error;
    }
    const before = lstatSync(path, { bigint: true });
    assertDirectory(before);
    assertTrustedParents(path);
    if (created && process.platform === 'win32') {
        new hub.PowerShellWindowsAclOps({ redactDiagnostics: true }).secureDirectory(path);
    }
    const after = lstatSync(path, { bigint: true });
    if (after.dev !== before.dev || after.ino !== before.ino)
        unsafeDirectory();
}
/** Only new directories are hardened; existing directories must already be private. */
export function prepareOutboxDirectory(directory) {
    const path = resolve(directory);
    try {
        createMissingDirectories(path);
    }
    catch (cause) {
        throw new Error('unsafe outbox directory', { cause });
    }
    const identity = lstatSync(path, { bigint: true });
    const prepared = {
        path,
        assertTrusted() {
            try {
                const before = lstatSync(path, { bigint: true });
                assertDirectory(before);
                if (before.dev !== identity.dev || before.ino !== identity.ino) {
                    throw new Error('outbox directory changed');
                }
                if (process.platform === 'win32') {
                    new hub.PowerShellWindowsAclOps({ redactDiagnostics: true }).assertPrivateDirectory(path);
                }
                else {
                    assertTrustedParents(path);
                    const uid = process.getuid?.();
                    if (uid === undefined || before.uid !== BigInt(uid) || (before.mode & 63n) !== 0n)
                        unsafeDirectory();
                }
                const after = lstatSync(path, { bigint: true });
                if (after.dev !== before.dev || after.ino !== before.ino || after.mode !== before.mode || after.uid !== before.uid) {
                    throw new Error('outbox directory changed');
                }
            }
            catch (cause) {
                throw new Error('unsafe outbox directory', { cause });
            }
        },
    };
    prepared.assertTrusted();
    return Object.freeze(prepared);
}
// ponytail: this static guard rejects visible Promise types, not async callbacks erased to void.
// Keep callers synchronous; async critical sections need an owned completion protocol.
export function withOutboxLock(directory, operation, ..._syncOnly) {
    directory.assertTrusted();
    const path = join(directory.path, '.outbox.lock');
    const owner = util.acquireLock(path);
    let result;
    let failure;
    let failed = false;
    try {
        directory.assertTrusted();
        result = operation();
    }
    catch (error) {
        failure = error;
        failed = true;
    }
    try {
        directory.assertTrusted();
        const released = util.releaseLock(path, owner);
        if (!released.released || released.reason !== 'released') {
            throw new Error(`outbox lock release failed: ${released.reason}`);
        }
    }
    catch (cleanup) {
        const deferred = util.deferLockRelease(path, owner);
        const errors = failed ? [failure, cleanup] : [cleanup];
        if (!deferred.deferred)
            errors.push(new Error(`outbox lock cleanup deferral failed: ${deferred.reason}`));
        if (errors.length > 1) {
            throw new AggregateError(errors, failed ? 'outbox operation and lock release failed' : 'outbox lock release failed');
        }
        throw cleanup;
    }
    if (failed)
        throw failure;
    return result;
}