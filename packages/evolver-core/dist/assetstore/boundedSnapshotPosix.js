import {} from 'node:fs';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { measureContextReadStage, startContextReadStage } from './contextReadDiagnostics.js';
export { runPosixSnapshotWorker } from './boundedSnapshotPosixWorker.js';
export class PosixSnapshotExitConfirmedError extends Error {
    cleanupConfirmed = true;
    constructor(cause) { super('posix_snapshot_worker_cleanup_failed', { cause }); }
}
let configuredWorkerCommand;
/** The CLI registers its own entrypoint so a Bun single-file executable starts
 * the same embedded worker. Library callers use the copied package worker file. */
export function configurePosixSnapshotWorkerCommand(command) {
    if (command && (!command.command || command.args.some(arg => typeof arg !== 'string')))
        throw new Error('invalid_snapshot_worker_command');
    configuredWorkerCommand = command ? { command: command.command, args: [...command.args] } : undefined;
}
function decodeStat(value) {
    if (!value || typeof value !== 'object')
        throw new Error('invalid_snapshot_ipc');
    const row = value;
    if (!['file', 'directory', 'symlink', 'other'].includes(row.kind))
        throw new Error('invalid_snapshot_ipc');
    const numbers = [row.dev, row.ino, row.mode, row.size, row.mtimeNs, row.ctimeNs];
    if (numbers.some(value => typeof value !== 'string' || !/^-?\d{1,40}$/.test(value)))
        throw new Error('invalid_snapshot_ipc');
    return {
        dev: BigInt(row.dev), ino: BigInt(row.ino), mode: BigInt(row.mode), size: BigInt(row.size),
        mtimeNs: BigInt(row.mtimeNs), ctimeNs: BigInt(row.ctimeNs),
        isFile: () => row.kind === 'file', isDirectory: () => row.kind === 'directory',
        isSymbolicLink: () => row.kind === 'symlink',
    };
}
async function beforeCleanupDeadline(operation, deadlineAt, message) {
    let timer;
    try {
        return await Promise.race([operation, new Promise((_, reject) => {
                timer = setTimeout(() => reject(new Error(message)), Math.max(0, deadlineAt - Date.now()));
            })]);
    }
    finally {
        clearTimeout(timer);
    }
}
/** No descriptor exists in this process. A failed close poisons the child and
 * blocks admission until its actual exit confirms kernel-wide fd cleanup. */
export class PosixSnapshotProcess {
    firstIpcDiagnostic = startContextReadStage('worker_first_ipc');
    bootstrapDiagnostic = startContextReadStage('worker_bootstrap');
    nativeDiagnostic;
    lstatDiagnostic;
    diagnosticInput = Buffer.alloc(0);
    diagnosticBytes = 0;
    diagnosticMarkers = new Set();
    child;
    finished;
    pending = new Map();
    serial = Promise.resolve();
    response = Buffer.alloc(0);
    nextId = 1;
    exited = false;
    closed = false;
    closing;
    closeFailure;
    abort;
    constructor(signal, override) {
        if (process.platform !== 'linux' && process.platform !== 'darwin')
            throw new Error('unsupported_snapshot_worker');
        const command = override ?? configuredWorkerCommand ?? {
            command: process.execPath,
            args: [fileURLToPath(new URL('./boundedSnapshotPosixWorker.js', import.meta.url)), '--run-posix-snapshot-worker'],
        };
        // No NODE_OPTIONS or caller-provided dynamic loader/preload state reaches the
        // descriptor owner. It needs only PATH for runtime-native dependencies.
        this.child = spawn(command.command, [...command.args], {
            stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true,
            env: { PATH: process.env.PATH ?? '', ...(process.platform === 'darwin' ? { HOME: process.env.HOME ?? '' } : {}),
                ...(this.bootstrapDiagnostic ? { EVOLVER_SNAPSHOT_TIMING_DIAGNOSTICS: '1' } : {}) },
        });
        let resolveExit;
        this.finished = new Promise(resolve => { resolveExit = resolve; });
        const exit = (error) => {
            if (this.exited)
                return;
            this.exited = true;
            this.closed = true;
            this.bootstrapDiagnostic?.('rejected');
            this.nativeDiagnostic?.('rejected');
            this.lstatDiagnostic?.('rejected');
            signal.removeEventListener('abort', this.abort);
            for (const pending of this.pending.values())
                pending.reject(error ?? new Error('snapshot_worker_exited'));
            this.pending.clear();
            resolveExit();
        };
        this.child.on('error', error => {
            // A spawn failure cannot have acquired a descriptor. A later kill/write
            // error does not prove exit and must never free the root admission slot.
            if (this.child.pid === undefined)
                exit(error);
            else
                this.poison(error);
        });
        this.child.on('close', () => exit());
        this.child.stdin.on('error', error => this.poison(error));
        this.child.stdout.on('data', (part) => {
            if (this.exited || this.closed)
                return;
            this.response = Buffer.concat([this.response, part]);
            if (this.response.length > 100 * 1024) {
                this.poison(new Error('invalid_snapshot_ipc'));
                return;
            }
            let boundary;
            while ((boundary = this.response.indexOf(10)) >= 0) {
                const line = this.response.subarray(0, boundary).toString('utf8');
                this.response = this.response.subarray(boundary + 1);
                let value;
                try {
                    value = JSON.parse(line);
                }
                catch {
                    this.poison(new Error('invalid_snapshot_ipc'));
                    return;
                }
                if (!value || typeof value !== 'object' || Array.isArray(value)) {
                    this.poison(new Error('invalid_snapshot_ipc'));
                    return;
                }
                const message = value;
                const pending = Number.isSafeInteger(message.id) ? this.pending.get(message.id) : undefined;
                if (!pending || typeof message.ok !== 'boolean') {
                    this.poison(new Error('invalid_snapshot_ipc'));
                    return;
                }
                this.pending.delete(message.id);
                if (message.ok && message.value && typeof message.value === 'object' && !Array.isArray(message.value))
                    pending.resolve(message.value);
                else if (!message.ok && typeof message.error === 'string')
                    pending.reject(new Error(message.error));
                else {
                    pending.reject(new Error('invalid_snapshot_ipc'));
                    this.poison(new Error('invalid_snapshot_ipc'));
                    return;
                }
            }
        });
        this.child.stderr.on('data', (part) => this.diagnostic(part));
        this.abort = () => { this.child.kill('SIGKILL'); };
        signal.addEventListener('abort', this.abort, { once: true });
        if (signal.aborted)
            this.abort();
    }
    diagnostic(part) {
        if (!this.bootstrapDiagnostic || this.exited || this.diagnosticBytes >= 1024)
            return;
        this.diagnosticBytes += part.length;
        if (this.diagnosticBytes > 1024) {
            this.diagnosticInput = Buffer.alloc(0);
            return;
        }
        this.diagnosticInput = Buffer.concat([this.diagnosticInput, part]);
        let boundary;
        while ((boundary = this.diagnosticInput.indexOf(10)) >= 0) {
            const line = this.diagnosticInput.subarray(0, boundary).toString('utf8');
            this.diagnosticInput = this.diagnosticInput.subarray(boundary + 1);
            if (line.length > 80 || this.diagnosticMarkers.has(line))
                continue;
            const prefix = 'snapshot-worker-timing ';
            if (line === prefix + 'bootstrap') {
                this.bootstrapDiagnostic('fulfilled');
            }
            else if (!this.diagnosticMarkers.has(prefix + 'bootstrap'))
                continue;
            else if (line === prefix + 'native_start')
                this.nativeDiagnostic = startContextReadStage('worker_native_ready');
            else if (line === prefix + 'native_ready' && this.diagnosticMarkers.has(prefix + 'native_start'))
                this.nativeDiagnostic?.('fulfilled');
            else if (line === prefix + 'lstat_start')
                this.lstatDiagnostic = startContextReadStage('worker_lstat');
            else if (line === prefix + 'lstat_done' && this.diagnosticMarkers.has(prefix + 'lstat_start'))
                this.lstatDiagnostic?.('fulfilled');
            else if (line === prefix + 'lstat_rejected' && this.diagnosticMarkers.has(prefix + 'lstat_start'))
                this.lstatDiagnostic?.('rejected');
            else
                continue;
            this.diagnosticMarkers.add(line);
        }
        if (this.diagnosticInput.length > 80)
            this.diagnosticInput = Buffer.alloc(0);
    }
    poison(error) {
        // A child may exit between accepting an IPC command and the pipe write.
        // A write callback does not consume the stream's separate error event.
        // Keep the root slot owned until the child's close confirms fd cleanup.
        const firstFailure = !this.closed;
        this.closed = true;
        this.response = Buffer.alloc(0);
        for (const pending of this.pending.values())
            pending.reject(error);
        this.pending.clear();
        // kill() may itself emit error synchronously; a second poison must not recurse.
        if (firstFailure && !this.exited)
            this.child.kill('SIGKILL');
    }
    request(op, fields = {}) {
        if (this.closing || this.closed || this.exited)
            return Promise.reject(new Error('snapshot_worker_exited'));
        const dispatch = () => {
            if (this.closed || this.exited)
                throw new Error('snapshot_worker_exited');
            const id = this.nextId++;
            const line = JSON.stringify({ id, op, ...fields }) + '\n';
            if (Buffer.byteLength(line) > 8192)
                throw new Error('invalid_snapshot_ipc');
            const response = new Promise((resolve, reject) => {
                this.pending.set(id, { resolve, reject });
                this.child.stdin.write(line, error => {
                    if (error)
                        this.poison(error);
                });
            });
            if (id !== 1 || !this.firstIpcDiagnostic)
                return response;
            return response.then(value => { this.firstIpcDiagnostic?.('fulfilled'); return value; }, error => { this.firstIpcDiagnostic?.('rejected'); throw error; });
        };
        const task = this.serial.then(dispatch);
        this.serial = task.catch(() => undefined);
        return task;
    }
    async lstat(path) {
        const value = await this.request('lstat', { path });
        return value['missing'] === true ? null : decodeStat(value['stat']);
    }
    owned(descriptor) {
        let closed = false;
        let closing;
        return {
            fd: descriptor,
            stat: async () => {
                if (closed)
                    throw new Error('snapshot_closed');
                return decodeStat((await this.request('fstat', { descriptor }))['stat']);
            },
            read: async (buffer) => {
                if (closed || buffer.length > 64 * 1024)
                    throw new Error('snapshot_closed');
                const data = (await this.request('read', { descriptor, maximum: buffer.length }))['data'];
                if (typeof data !== 'string' || data.length > 90_000 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(data))
                    throw new Error('invalid_snapshot_ipc');
                const bytes = Buffer.from(data, 'base64');
                if (bytes.length > buffer.length)
                    throw new Error('invalid_snapshot_ipc');
                bytes.copy(buffer);
                return bytes.length;
            },
            close: () => {
                if (!closing) {
                    closed = true;
                    closing = (async () => {
                        try {
                            await this.request('close', { descriptor });
                        }
                        catch (error) {
                            try {
                                await this.terminate();
                            }
                            catch (cleanup) {
                                throw new AggregateError([error, cleanup], 'snapshot_cleanup_unconfirmed');
                            }
                            throw error;
                        }
                    })();
                }
                return closing;
            },
        };
    }
    async openRoot(path) {
        const value = await this.request('openRoot', { path });
        if (!Number.isSafeInteger(value['descriptor']))
            throw new Error('invalid_snapshot_ipc');
        return this.owned(value['descriptor']);
    }
    async openChild(parent, name, directory = false) {
        const value = await this.request('openChild', { parent, name, directory });
        if (!Number.isSafeInteger(value['descriptor']))
            throw new Error('invalid_snapshot_ipc');
        return this.owned(value['descriptor']);
    }
    async terminate() {
        await this.terminateBefore(Date.now() + 5000);
    }
    async terminateBefore(deadlineAt) {
        this.closed = true;
        if (!this.exited)
            this.child.kill('SIGKILL');
        await beforeCleanupDeadline(this.finished, deadlineAt, 'snapshot_cleanup_unconfirmed');
    }
    close() {
        if (this.closing)
            return this.closing;
        const closing = measureContextReadStage('worker_close', async () => {
            const deadlineAt = Date.now() + 5000;
            if (!this.closed && !this.exited) {
                // Graceful shutdown shares the serial queue but cannot hold cleanup
                // forever. Reserve the remainder of this one budget for actual exit.
                try {
                    await beforeCleanupDeadline(this.request('shutdown'), Math.min(deadlineAt, Date.now() + 1000), 'snapshot_shutdown_timeout');
                }
                catch (error) {
                    this.closeFailure ??= error;
                }
            }
            try {
                await this.terminateBefore(deadlineAt);
            }
            catch (cleanup) {
                throw new AggregateError(this.closeFailure ? [this.closeFailure, cleanup] : [cleanup], 'snapshot_cleanup_unconfirmed');
            }
            if (this.closeFailure)
                throw new PosixSnapshotExitConfirmedError(this.closeFailure);
        });
        this.closing = closing;
        void closing.catch(error => {
            // Only actual exit can release the root owner. An unconfirmed cleanup
            // can be retried on this same ChildProcess; never resend a numeric fd.
            if (!(error instanceof PosixSnapshotExitConfirmedError) && this.closing === closing)
                this.closing = undefined;
        });
        return closing;
    }
}