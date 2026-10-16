import { createRequire } from 'node:module';
import process from 'node:process';
import { Buffer } from 'node:buffer';
import { URL, fileURLToPath } from 'node:url';
import { close, constants, fstat, lstat, read } from 'node:fs';
import { open } from 'node:fs/promises';
/* global __EVOLVER_EMBEDDED_REFERENCE_FFI__ */
const MAX_LINE = 8192;
const MAX_READ = 64 * 1024;
const MAX_BYTES = 64 * 1024 * 1024;
const MAX_OPEN = 64;
const descriptors = new Map();
let nextDescriptor = 1;
let bytesRead = 0;
let poisoned = false;
let openAt;
let retainedLibrary;
let lstatMeasured = false;
const timingEnabled = process.env.EVOLVER_SNAPSHOT_TIMING_DIAGNOSTICS === '1';
if (timingEnabled)
    process.stderr.on('error', () => { });
function snapshotTiming(marker) {
    if (timingEnabled) {
        try {
            process.stderr.write(`snapshot-worker-timing ${marker}\n`);
        }
        catch { /* Timing delivery cannot replace the operation. */ }
    }
}
snapshotTiming('bootstrap');
function nativeOpenAt() {
    if (openAt)
        return openAt;
    snapshotTiming('native_start');
    const packaged = typeof __EVOLVER_EMBEDDED_REFERENCE_FFI__ !== 'undefined'
        && __EVOLVER_EMBEDDED_REFERENCE_FFI__;
    const embedded = Object.getOwnPropertyDescriptor(globalThis, Symbol.for('evolver.referenceNativeFfi.v1'));
    if ((packaged && !embedded) || (embedded && (embedded.get || embedded.set || embedded.writable || embedded.configurable)))
        throw new Error('reference_native_unavailable');
    const ffi = embedded ? embedded.value : createRequire(new URL('../../package.json', import.meta.url))('koffi');
    if (ffi?.version !== '3.2.1' || typeof ffi.load !== 'function')
        throw new Error('reference_native_unavailable');
    retainedLibrary = ffi.load(null);
    openAt = retainedLibrary.func('int openat(int dirfd, const char *path, int flags)');
    snapshotTiming('native_ready');
    return openAt;
}
function checkedPath(path) {
    if (typeof path !== 'string' || !path || Buffer.byteLength(path) > 4096 || path.includes('\0'))
        throw new Error('unsafe_snapshot_path');
    return path;
}
function checkedChild(name) {
    if (typeof name !== 'string' || !name || name === '.' || name === '..' || Buffer.byteLength(name) > 255
        || name.includes('/') || name.includes('\\') || name.includes('\0'))
        throw new Error('unsafe_snapshot_path');
    return name;
}
function descriptor(id) {
    if (!Number.isSafeInteger(id) || id < 1 || !descriptors.has(id))
        throw new Error('snapshot_closed');
    return descriptors.get(id);
}
function statValue(value) {
    return {
        dev: String(value.dev), ino: String(value.ino), mode: String(value.mode), size: String(value.size),
        mtimeNs: String(value.mtimeNs), ctimeNs: String(value.ctimeNs),
        kind: value.isFile() ? 'file' : value.isDirectory() ? 'directory' : value.isSymbolicLink() ? 'symlink' : 'other',
    };
}
const fstatAsync = fd => new Promise((resolve, reject) => fstat(fd, { bigint: true }, (error, value) => error ? reject(error) : resolve(value)));
const readAsync = (fd, buffer) => new Promise((resolve, reject) => read(fd, buffer, 0, buffer.length, null, (error, count) => error ? reject(error) : resolve(count)));
const closeAsync = fd => new Promise((resolve, reject) => close(fd, error => error ? reject(error) : resolve()));
async function closeEntry(id) {
    const entry = descriptor(id);
    // A close failure is ambiguous: never issue another operation on its numeric fd.
    // The parent must terminate this process and wait for kernel exit confirmation.
    try {
        await (entry.handle ? entry.handle.close() : closeAsync(entry.fd));
    }
    catch (error) {
        poisoned = true;
        throw error;
    }
    descriptors.delete(id);
    // An invocation may borrow this idle process for a fresh query. Only actual
    // closure of every descriptor ends the previous read's byte admission; a
    // child close while its pinned root remains open cannot reset consumption.
    if (descriptors.size === 0)
        bytesRead = 0;
}
async function command(message) {
    if (!message || typeof message !== 'object' || !Number.isSafeInteger(message.id) || message.id < 1
        || typeof message.op !== 'string')
        throw new Error('invalid_snapshot_ipc');
    if (poisoned && message.op !== 'shutdown')
        throw new Error('snapshot_cleanup_unconfirmed');
    switch (message.op) {
        case 'lstat': {
            const measured = !lstatMeasured;
            lstatMeasured = true;
            if (measured)
                snapshotTiming('lstat_start');
            let completed = false;
            try {
                const value = { stat: statValue(await new Promise((resolve, reject) => lstat(checkedPath(message.path), { bigint: true }, (error, value) => error ? reject(error) : resolve(value)))) };
                completed = true;
                return value;
            }
            catch (error) {
                if (error?.code === 'ENOENT') {
                    completed = true;
                    return { missing: true };
                }
                throw error;
            }
            finally {
                if (measured)
                    snapshotTiming(completed ? 'lstat_done' : 'lstat_rejected');
            }
        }
        case 'openRoot': {
            if (descriptors.size >= MAX_OPEN)
                throw new Error('snapshot_descriptor_capacity');
            const handle = await open(checkedPath(message.path), constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
            const id = nextDescriptor++;
            descriptors.set(id, { fd: handle.fd, handle });
            return { descriptor: id };
        }
        case 'openChild': {
            if (descriptors.size >= MAX_OPEN || !Number.isSafeInteger(message.parent))
                throw new Error('snapshot_descriptor_capacity');
            const parent = descriptor(message.parent);
            const name = checkedChild(message.name);
            const directory = message.directory === true;
            if (message.directory !== true && message.directory !== false)
                throw new Error('invalid_snapshot_ipc');
            const flags = constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK
                | (directory ? constants.O_DIRECTORY : 0) | (process.platform === 'linux' ? 0x80000 : 0x1000000);
            const fd = await new Promise((resolve, reject) => {
                nativeOpenAt().async(parent.fd, name, flags, (error, result) => {
                    if (error)
                        reject(error);
                    else if (!Number.isInteger(result) || result < 0)
                        reject(new Error('snapshot_changed'));
                    else
                        resolve(result);
                });
            });
            const id = nextDescriptor++;
            descriptors.set(id, { fd });
            return { descriptor: id };
        }
        case 'fstat': return { stat: statValue(await fstatAsync(descriptor(message.descriptor).fd)) };
        case 'read': {
            if (!Number.isInteger(message.maximum) || message.maximum < 1 || message.maximum > MAX_READ
                || bytesRead + message.maximum > MAX_BYTES)
                throw new Error('snapshot_byte_limit');
            const buffer = Buffer.allocUnsafe(message.maximum);
            const count = await readAsync(descriptor(message.descriptor).fd, buffer);
            bytesRead += count;
            return { data: buffer.subarray(0, count).toString('base64') };
        }
        case 'close':
            await closeEntry(message.descriptor);
            return {};
        case 'shutdown': {
            if (!poisoned)
                for (const id of [...descriptors.keys()].reverse())
                    await closeEntry(id);
            return { shutdown: true };
        }
        default: throw new Error('invalid_snapshot_ipc');
    }
}
async function* boundedLines(input) {
    let pending = Buffer.alloc(0);
    for await (const chunk of input) {
        if (!Buffer.isBuffer(chunk))
            throw new Error('invalid_snapshot_ipc');
        let offset = 0;
        while (offset < chunk.length) {
            const newline = chunk.indexOf(10, offset);
            const end = newline < 0 ? chunk.length : newline;
            const fragment = chunk.subarray(offset, end);
            if (pending.length + fragment.length > MAX_LINE)
                throw new Error('invalid_snapshot_ipc');
            pending = Buffer.concat([pending, fragment]);
            if (newline < 0)
                break;
            yield pending.toString('utf8');
            pending = Buffer.alloc(0);
            offset = newline + 1;
        }
    }
    if (pending.length)
        throw new Error('invalid_snapshot_ipc');
}
/** A private, fixed-command protocol. The caller trusts only exit of this process
 * as confirmation that an ambiguous close cannot leave a live descriptor. */
export async function runPosixSnapshotWorker() {
    if (process.platform !== 'linux' && process.platform !== 'darwin')
        throw new Error('unsupported_snapshot_worker');
    try {
        for await (const line of boundedLines(process.stdin)) {
            let message;
            try {
                message = JSON.parse(line);
                if (!message || typeof message !== 'object' || Array.isArray(message)
                    || !Number.isSafeInteger(message.id) || message.id < 1 || typeof message.op !== 'string') {
                    throw new Error('invalid_snapshot_ipc');
                }
            }
            catch {
                // No response ID can be trusted. Emit only the fixed diagnostic, then
                // exit; the parent keeps its descriptors owned until actual close.
                process.stderr.write('invalid_snapshot_ipc\n');
                throw new Error('invalid_snapshot_ipc');
            }
            let result;
            try {
                result = { id: message.id, ok: true, value: await command(message) };
            }
            catch (error) {
                result = { id: message.id, ok: false, error: String(error?.message ?? error).slice(0, 256) };
            }
            const output = JSON.stringify(result) + '\n';
            if (Buffer.byteLength(output) > 100 * 1024)
                throw new Error('invalid_snapshot_ipc');
            await new Promise((resolve, reject) => process.stdout.write(output, error => error ? reject(error) : resolve()));
            if (message.op === 'shutdown')
                break;
        }
    }
    finally {
        // Process exit is the only authority for closing an ambiguous descriptor.
        // Do not retry a numeric fd here, even when a previous close reported error.
        process.stdin.destroy();
    }
}
if (typeof __EVOLVER_EMBEDDED_REFERENCE_FFI__ === 'undefined' && process.argv.length === 3
    && process.argv[1] === fileURLToPath(import.meta.url)
    && process.argv[2] === '--run-posix-snapshot-worker') {
    runPosixSnapshotWorker().then(() => { process.exitCode = 0; }, () => { process.exitCode = 1; });
}