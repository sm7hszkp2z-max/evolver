export { runProtectedAuditReady } from './protectedAuditReady.js';
/** Internal entrypoint; the machine administrator supplies the immutable config path. */
export declare function runProtectedAuditService(configPath: string): Promise<void>;