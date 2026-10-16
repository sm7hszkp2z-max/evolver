import { readSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import { setTimeout } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';
import { configureProtectedAuditRpcChildCommand, requireProtectedAuditServiceForProcess, protectedAuditRpc } from './protectedAuditRpc.js';
export { configureProtectedAuditRpcChildCommand, requireProtectedAuditServiceForProcess };
/** Bound retained input before EOF; an oversized pipe never reaches RPC admission. */
export async function readProtectedAuditRpcInput(input) {
    const buffer = Buffer.allocUnsafe(1024 * 1024);
    let size = 0;
    for await (const part of input) {
        if (!(part instanceof Uint8Array) || part.byteLength > buffer.length - size)
            throw new Error('request_size_invalid');
        buffer.set(part, size);
        size += part.byteLength;
    }
    if (size < 1)
        throw new Error('request_size_invalid');
    return buffer.subarray(0, size);
}
async function* readProtectedAuditRpcStdin() {
    // Bun's sync-child stdin can be a memfd. Read its descriptor directly so an
    // eager Readable cannot discard buffered bytes during deferred worker import.
    const chunk = Buffer.allocUnsafe(64 * 1024);
    for (;;) {
        let size;
        try {
            size = readSync(0, chunk, 0, chunk.length, null);
        }
        catch (error) {
            const code = error.code;
            if (code === 'EINTR')
                continue;
            // An eager Node stdin makes pipes nonblocking. Yield only when the same
            // descriptor would block; the owning parent's deadline remains in force.
            if (code === 'EAGAIN' || code === 'EWOULDBLOCK') {
                await setTimeout(10);
                continue;
            }
            throw error;
        }
        if (size === 0)
            return;
        yield chunk.subarray(0, size);
    }
}
/** Private subprocess entrypoint for the legacy synchronous audit reader API. */
export async function runProtectedAuditRpcChild() {
    let reply;
    try {
        const input = await readProtectedAuditRpcInput(readProtectedAuditRpcStdin());
        let request;
        try {
            request = JSON.parse(input.toString('utf8'));
        }
        catch {
            throw new Error('request_invalid');
        } // JSON diagnostics must not echo request bodies.
        if (!request || typeof request !== 'object' || Array.isArray(request)
            || request.version !== 1 || typeof request.operationId !== 'string' || !request.operationId || typeof request.method !== 'string'
            || typeof request.path !== 'string' || !Number.isFinite(request.deadlineAt))
            throw new Error('request_invalid');
        const value = await protectedAuditRpc(request.method, request.path, request.payload, { operationId: request.operationId, deadlineAt: request.deadlineAt });
        reply = { ok: true, value };
    }
    catch (error) {
        reply = { ok: false, error: error instanceof Error ? error.message : 'unknown_error' };
    }
    process.stdout.write(JSON.stringify(reply));
    if (!reply.ok)
        process.exitCode = 1;
}
if (process.argv[1] && basename(process.argv[1]) === 'protectedAuditRpcChild.js'
    && process.argv[2] === '--internal-protected-audit-rpc-child' && process.argv.length === 3
    && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
    await runProtectedAuditRpcChild();
}