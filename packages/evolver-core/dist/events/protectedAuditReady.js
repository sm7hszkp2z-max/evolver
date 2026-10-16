import { createHash, randomUUID } from 'node:crypto';
import { closeSync, constants, fstatSync, lstatSync, openSync, readSync, realpathSync } from 'node:fs';
import { createConnection } from 'node:net';
import { dirname, isAbsolute, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { ProtectedAuditFrameReceiver } from './protectedAuditFrame.js';
import { ProtectedAuditUnavailableError } from './protectedAuditRpc.js';
const digest = /^[a-f0-9]{64}$/;
const nonce = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const same = (a, b) => a.dev === b.dev && a.ino === b.ino && a.mode === b.mode
    && a.uid === b.uid && a.gid === b.gid && a.nlink === b.nlink && a.size === b.size
    && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs;
const fail = (reason) => { throw new ProtectedAuditUnavailableError(reason); };
function canonical(path) {
    return typeof path === 'string' && isAbsolute(path) && resolve(path) === path && path.length <= 4096 && !path.includes('\0');
}
function ancestors(path, serviceUid = 0) {
    for (let current = resolve(path);;) {
        const stat = lstatSync(current);
        if (!stat.isDirectory() || stat.isSymbolicLink() || ![0, serviceUid].includes(stat.uid)
            || (stat.mode & 0o022) !== 0)
            fail('ready_parent_untrusted');
        const parent = dirname(current);
        if (parent === current)
            return;
        current = parent;
    }
}
function readBoundFile(path, maxBytes, check) {
    const named = lstatSync(path);
    if (named.isSymbolicLink())
        fail('ready_file_untrusted');
    check(named);
    const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
        const before = fstatSync(fd);
        check(before);
        if (!same(named, before) || before.size > maxBytes || before.size < 1)
            fail('ready_file_changed');
        const bytes = Buffer.alloc(before.size);
        let offset = 0;
        while (offset < bytes.length) {
            const count = readSync(fd, bytes, offset, bytes.length - offset, offset);
            if (count < 1)
                fail('ready_file_short_read');
            offset += count;
        }
        if (!same(before, fstatSync(fd)) || !same(before, lstatSync(path)))
            fail('ready_file_changed');
        return bytes;
    }
    finally {
        closeSync(fd);
    }
}
/** Root-only, bounded, nofollow plan admission independent of unpublished client config. */
export function readProtectedAuditReadyPlan(path) {
    if (!['linux', 'darwin'].includes(process.platform) || process.getuid?.() !== 0)
        fail('ready_admin_required');
    if (!canonical(path))
        fail('ready_plan_path_invalid');
    ancestors(dirname(path));
    const bytes = readBoundFile(path, 4096, stat => {
        if (!stat.isFile() || stat.uid !== 0 || (stat.mode & 0o7777) !== 0o600 || stat.nlink !== 1 || stat.size > 4096) {
            fail('ready_plan_untrusted');
        }
    });
    let value;
    try {
        value = JSON.parse(bytes.toString('utf8'));
    }
    catch {
        fail('ready_plan_invalid');
    }
    return validateProtectedAuditReadyPlan(value);
}
export function validateProtectedAuditReadyPlan(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value))
        fail('ready_plan_invalid');
    const plan = value;
    const keys = ['version', 'serviceUid', 'clientGid', 'socketPath', 'configSha256', 'executableSha256', 'timeoutMs'].sort();
    if (JSON.stringify(Object.keys(plan).sort()) !== JSON.stringify(keys) || plan.version !== 1
        || !Number.isSafeInteger(plan.serviceUid) || plan.serviceUid < 1
        || !Number.isSafeInteger(plan.clientGid) || plan.clientGid < 1 || !canonical(plan.socketPath)
        || typeof plan.configSha256 !== 'string' || !digest.test(plan.configSha256)
        || typeof plan.executableSha256 !== 'string' || !digest.test(plan.executableSha256) || plan.timeoutMs !== 5000) {
        fail('ready_plan_invalid');
    }
    return Object.freeze({ ...plan });
}
/** Captured before listening. A replaced live pathname cannot change this process receipt. */
export function captureProtectedAuditHealth(configPath, config) {
    ancestors(dirname(configPath));
    const configBytes = readBoundFile(configPath, 4096, stat => {
        if (!stat.isFile() || stat.uid !== 0 || stat.nlink !== 1 || (stat.mode & 0o137) !== 0)
            fail('ready_config_untrusted');
    });
    const parsed = JSON.parse(configBytes.toString('utf8'));
    // Bind the captured bytes to the exact configuration already admitted by the service.
    if (JSON.stringify(parsed) !== JSON.stringify(config))
        fail('ready_config_changed');
    if (!['linux', 'darwin'].includes(process.platform))
        fail('ready_runtime_unsupported');
    const executable = process.platform === 'linux' ? '/proc/self/exe' : realpathSync(process.execPath);
    if (process.platform === 'darwin')
        ancestors(dirname(executable));
    // /proc/self/exe is an intentional kernel-owned running-image handle, not a caller-selected symlink.
    const fd = openSync(executable, constants.O_RDONLY | constants.O_NONBLOCK
        | (process.platform === 'darwin' ? constants.O_NOFOLLOW : 0));
    let executableSha256;
    try {
        const before = fstatSync(fd);
        if (!before.isFile() || before.uid !== 0 || (before.mode & 0o022) !== 0
            || before.size < 1 || before.size > 1024 * 1024 * 1024)
            fail('ready_executable_untrusted');
        const hash = createHash('sha256'), bytes = Buffer.alloc(64 * 1024);
        let offset = 0;
        while (offset < before.size) {
            const count = readSync(fd, bytes, 0, Math.min(bytes.length, before.size - offset), offset);
            if (count < 1)
                fail('ready_executable_short_read');
            hash.update(bytes.subarray(0, count));
            offset += count;
        }
        if (!same(before, fstatSync(fd)) || (process.platform === 'darwin' && !same(before, lstatSync(executable)))) {
            fail('ready_executable_changed');
        }
        executableSha256 = hash.digest('hex');
    }
    finally {
        closeSync(fd);
    }
    return Object.freeze({ version: 1, ready: true, serviceUid: config.serviceUid, clientGid: config.clientGid,
        socketPath: config.socketPath, configSha256: createHash('sha256').update(configBytes).digest('hex'),
        executableSha256, pid: process.pid, processStartedAt: performance.timeOrigin, processNonce: randomUUID() });
}
function readySocket(plan) {
    ancestors(dirname(plan.socketPath), plan.serviceUid);
    const parent = lstatSync(dirname(plan.socketPath));
    if (parent.uid !== plan.serviceUid || parent.gid !== plan.clientGid || (parent.mode & 0o007) !== 0)
        fail('ready_socket_parent_untrusted');
    const socket = lstatSync(plan.socketPath);
    if (!socket.isSocket() || socket.uid !== plan.serviceUid)
        fail('ready_socket_untrusted');
    // bind(2) happens before chown/chmod. With the service's umask, Linux may
    // expose that same owned socket briefly as 0700; this is still private and
    // must be retried until the client-group 0660 publication is complete.
    // Neither state authorizes success.
    if ([0o600, 0o700].includes(socket.mode & 0o7777))
        fail('ready_publication_pending');
    if (socket.gid !== plan.clientGid || (socket.mode & 0o7777) !== 0o660)
        fail('ready_socket_untrusted');
    return socket;
}
function verifySocket(plan, expected) {
    const actual = readySocket(plan);
    if (!same(actual, expected))
        fail('ready_socket_replaced');
}
export function validateProtectedAuditHealth(value, plan) {
    if (!value || typeof value !== 'object' || Array.isArray(value))
        fail('ready_health_invalid');
    const health = value;
    const keys = ['version', 'ready', 'serviceUid', 'clientGid', 'socketPath', 'configSha256', 'executableSha256',
        'pid', 'processStartedAt', 'processNonce'].sort();
    if (JSON.stringify(Object.keys(health).sort()) !== JSON.stringify(keys) || health.version !== 1 || health.ready !== true
        || health.serviceUid !== plan.serviceUid || health.clientGid !== plan.clientGid || health.socketPath !== plan.socketPath
        || health.configSha256 !== plan.configSha256 || health.executableSha256 !== plan.executableSha256
        || !Number.isSafeInteger(health.pid) || health.pid < 1 || !Number.isFinite(health.processStartedAt)
        || health.processStartedAt <= 0 || health.processStartedAt > Date.now()
        || typeof health.processNonce !== 'string' || !nonce.test(health.processNonce))
        fail('ready_health_mismatch');
    return health;
}
/** One read-only request. Settlement waits for this owned socket's actual close. */
export function protectedAuditReadyRpc(plan, deadlineAt, operationId = randomUUID()) {
    const expected = readySocket(plan);
    if (!Number.isFinite(deadlineAt) || deadlineAt <= Date.now())
        fail('ready_deadline_expired');
    if (!/^[-\w]{1,128}$/.test(operationId) || deadlineAt - Date.now() > 5000)
        fail('ready_request_invalid');
    const request = { version: 1, operationId, method: 'health', path: plan.socketPath,
        payload: null, deadlineAt };
    const bytes = Buffer.from(JSON.stringify(request)), frame = Buffer.alloc(bytes.length + 4);
    frame.writeUInt32BE(bytes.length);
    bytes.copy(frame, 4);
    return new Promise((resolveResult, rejectResult) => {
        const socket = createConnection(plan.socketPath), receiver = new ProtectedAuditFrameReceiver(4096);
        let done = false, failure, health;
        const finish = (error, value) => {
            if (done)
                return;
            done = true;
            failure = error;
            health = value;
            clearTimeout(timer);
            socket.destroy();
        };
        const timer = setTimeout(() => finish(new ProtectedAuditUnavailableError('ready_transport_timeout_unknown')), Math.max(1, deadlineAt - Date.now()));
        socket.once('connect', () => { try {
            verifySocket(plan, expected);
            socket.write(frame);
        }
        catch (error) {
            finish(error);
        } });
        socket.on('data', chunk => {
            try {
                const body = receiver.feed(chunk);
                if (!body)
                    return;
                const reply = JSON.parse(body.toString('utf8'));
                if (reply.version !== 1 || reply.operationId !== operationId || typeof reply.ok !== 'boolean')
                    fail('ready_response_identity_invalid');
                if (!reply.ok) {
                    if (reply.error === 'protected_audit_unavailable: service_starting')
                        fail('ready_publication_pending');
                    fail('ready_service_refused');
                }
                const value = validateProtectedAuditHealth(reply.value, plan);
                if (Date.now() >= deadlineAt)
                    fail('ready_deadline_expired');
                verifySocket(plan, expected);
                finish(undefined, value);
            }
            catch (error) {
                finish(error);
            }
        });
        socket.once('error', error => finish(error));
        socket.once('close', () => {
            if (!done)
                finish(new ProtectedAuditUnavailableError('ready_transport_closed_unknown'));
            if (failure !== undefined)
                rejectResult(failure);
            else
                resolveResult(health);
        });
    });
}
export async function runProtectedAuditReady(planPath) {
    try {
        const startedAt = performance.now(), deadlineAt = Date.now() + 5000;
        const plan = readProtectedAuditReadyPlan(planPath), operationId = randomUUID();
        for (;;) {
            if (performance.now() - startedAt >= 5000)
                fail('ready_deadline_expired');
            try {
                await protectedAuditReadyRpc(plan, deadlineAt, operationId);
                return;
            }
            catch (error) {
                const code = error?.code;
                const pending = error instanceof ProtectedAuditUnavailableError && error.reason === 'ready_publication_pending';
                if (!pending && code !== 'ENOENT' && code !== 'ECONNREFUSED')
                    throw error;
                const remaining = Math.min(deadlineAt - Date.now(), 5000 - (performance.now() - startedAt));
                if (remaining <= 0)
                    fail('ready_deadline_expired');
                await new Promise(resolveWait => setTimeout(resolveWait, Math.min(25, remaining)));
            }
        }
    }
    catch (error) {
        const reason = error instanceof ProtectedAuditUnavailableError ? error.reason : 'ready_probe_unknown';
        process.stderr.write(`protected_audit_unavailable: ${reason}\n`);
        throw error;
    }
}