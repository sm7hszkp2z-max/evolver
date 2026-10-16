import { configureProtectedAuditRpcChildCommand, requireProtectedAuditServiceForProcess } from './protectedAuditRpc.js';
export { configureProtectedAuditRpcChildCommand, requireProtectedAuditServiceForProcess };
/** Bound retained input before EOF; an oversized pipe never reaches RPC admission. */
export declare function readProtectedAuditRpcInput(input: AsyncIterable<Uint8Array> | Iterable<Uint8Array>): Promise<Buffer>;
/** Private subprocess entrypoint for the legacy synchronous audit reader API. */
export declare function runProtectedAuditRpcChild(): Promise<void>;