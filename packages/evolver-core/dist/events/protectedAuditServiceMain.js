import { startProtectedAuditService } from './protectedAuditService.js';
import { ProtectedAuditUnavailableError } from './protectedAuditRpc.js';
export { runProtectedAuditReady } from './protectedAuditReady.js';
const STARTUP_REASONS = new Set(['service_config_path_invalid', 'service_parent_untrusted',
    'service_config_untrusted', 'service_config_invalid', 'service_directory_untrusted',
    'socket_existing_untrusted', 'socket_already_running', 'socket_replaced', 'socket_publication_untrusted',
    'startup_owner_busy', 'startup_owner_untrusted', 'startup_parent_untrusted', 'startup_cleanup_unknown',
    'startup_runtime_unsupported', 'ready_config_untrusted', 'ready_config_changed', 'ready_executable_untrusted',
    'ready_executable_changed', 'ready_executable_short_read', 'ready_file_changed', 'ready_file_untrusted',
    'ready_file_short_read', 'ready_parent_untrusted', 'ready_runtime_unsupported']);
/** Internal entrypoint; the machine administrator supplies the immutable config path. */
export async function runProtectedAuditService(configPath) {
    const server = await startProtectedAuditService(configPath).catch((error) => {
        const reason = error instanceof ProtectedAuditUnavailableError && STARTUP_REASONS.has(error.reason)
            ? error.reason : 'service_startup_failed';
        process.stderr.write(`protected_audit_unavailable: ${reason}\n`);
        throw error;
    });
    await new Promise((resolve, reject) => {
        // The socket close event precedes disconnected storage settlement. The
        // service's bound close callback confirms index and startup-owner cleanup.
        server.once('close', () => { server.close(error => error ? reject(error) : resolve()); });
        server.once('error', reject);
    });
}