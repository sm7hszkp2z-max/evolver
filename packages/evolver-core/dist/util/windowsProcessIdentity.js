import { loadReferenceSystemLibrary } from '../benchmark/referenceNativeRuntime.js';
// Windows FILETIME is 100 ns since 1601-01-01; .NET UTC ticks start at 0001-01-01.
const FILETIME_EPOCH_TICKS = 504911232000000000n;
const MAX_DOTNET_TICKS = 3155378975999999999n;
const PROCESS_QUERY_LIMITED_INFORMATION = 0x1000;
let api;
let pendingClose;
let closeUnconfirmed = false;
function validHandle(value) {
    return typeof value === 'bigint' && value > 0n
        && value !== 0xffffffffn && value < 0xffffffffffffffffn;
}
function succeeded(value) {
    // BOOL is a signed 32-bit integer, not JS truthiness. Keep bigint results exact too;
    // reject zero, coercible values and anything outside the declared ABI's range.
    if (typeof value === 'bigint')
        return value !== 0n && value >= -0x80000000n && value <= 0x7fffffffn;
    return typeof value === 'number' && Number.isInteger(value) && value !== 0
        && value >= -0x8000_0000 && value <= 0x7fff_ffff;
}
function processApi() {
    if (api)
        return api;
    // Only fixed KnownDLL metadata calls through the existing version-checked Node/Bun loader.
    // No shell, caller-selected library/symbol, process mutation, or bulk synchronous I/O.
    const kernel = loadReferenceSystemLibrary('kernel32.dll');
    const open = kernel.func('void * __stdcall OpenProcess(uint32_t access, int inheritHandle, uint32_t pid)');
    const times = kernel.func('int __stdcall GetProcessTimes(void *handle, _Out_ void *creation, _Out_ void *exit, _Out_ void *kernel, _Out_ void *user)');
    const close = kernel.func('int __stdcall CloseHandle(void *handle)');
    api = { open, times, close };
    return api;
}
function closePending(native) {
    if (pendingClose === undefined)
        return;
    // A native binding may throw after CloseHandle has already released its numeric value.
    // Retrying that value could close an unrelated handle that Windows later reuses.
    if (closeUnconfirmed)
        throw new Error('process_identity_close_unconfirmed');
    try {
        if (!succeeded(native.close(pendingClose)))
            throw new Error('process_identity_close_failed');
    }
    catch (error) {
        closeUnconfirmed = true;
        throw error;
    }
    pendingClose = undefined;
}
/** Fresh process-generation metadata. Unknown observations are never cached here. */
export function readWindowsProcessStartTimeTicks(pid) {
    if (process.platform !== 'win32' || !['x64', 'arm64'].includes(process.arch)
        || !Number.isInteger(pid) || pid <= 0 || pid > 0xffff_ffff)
        return null;
    try {
        const native = processApi();
        // An unconfirmed close withholds the observation and any later probe. Retain at most one
        // uncertain owner without retrying its numeric value, which Windows may already have reused.
        closePending(native);
        const handle = native.open(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
        if (!validHandle(handle))
            return null;
        pendingClose = handle;
        try {
            const creation = Buffer.alloc(8);
            const exit = Buffer.alloc(8);
            const kernel = Buffer.alloc(8);
            const user = Buffer.alloc(8);
            if (!succeeded(native.times(handle, creation, exit, kernel, user)))
                return null;
            // Another handle may retain a terminated process object. Its creation time is
            // readable but is no longer evidence of a live owner generation.
            if (exit.readBigUInt64LE() !== 0n)
                return null;
            // Keep both DWORDs and the epoch conversion in BigInt: Number loses 100 ns precision.
            const fileTime = creation.readBigUInt64LE();
            const ticks = fileTime + FILETIME_EPOCH_TICKS;
            return fileTime > 0n && ticks <= MAX_DOTNET_TICKS ? ticks.toString() : null;
        }
        finally {
            closePending(native);
        }
    }
    catch {
        // Access denied, PID exit races, unavailable ABI and unconfirmed cleanup all fail closed.
        return null;
    }
}