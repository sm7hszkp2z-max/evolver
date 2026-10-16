import { AsyncLocalStorage } from 'node:async_hooks';
import { performance } from 'node:perf_hooks';
import { AuditWriteSkipped } from '../events/boundedAudit.js';
import { ProtectedAuditUnavailableError } from '../events/protectedAuditRpc.js';
const diagnostic = new AsyncLocalStorage();
const MAX_STAGES = 16;
const phases = new Set(['worker_first_ipc', 'worker_close', 'gene_snapshot',
    'related_snapshot', 'prompt_selection', 'prompt_assembly', 'delivery_prepare',
    'delivery_validate', 'delivery_journal_open', 'delivery_journal_transaction',
    'delivery_journal_close', 'delivery_cleanup', 'worker_bootstrap', 'worker_native_ready', 'worker_lstat']);
const rejectionCodes = new Map([
    ['transport_timeout_unknown', 'transport_timeout_unknown'], ['transport_aborted_unknown', 'transport_aborted_unknown'],
    ['transport_closed_unknown', 'transport_closed_unknown'], ['admission_expired', 'admission_expired'],
    ['request_expired', 'request_expired'], ['request_invalid_or_expired', 'request_invalid_or_expired'],
    ['cancelled_or_expired', 'cancelled_or_expired'],
]);
const preparationCodes = new Set(['prepared', 'rejected', 'invalid_capability', 'deadline', 'timeout', 'not_configured',
    ...rejectionCodes.values()]);
const snapshotCodes = new Set(['snapshot_aborted', 'snapshot_rejected']);
/** Classify only known typed failures; arbitrary service/error text never enters diagnostics. */
export function contextDeliveryRejectionCode(error) {
    try {
        if (error instanceof AuditWriteSkipped)
            return error.reason === 'cancelled_or_expired' ? 'cancelled_or_expired' : 'rejected';
        if (error instanceof ProtectedAuditUnavailableError) {
            const reason = error.reason;
            if (typeof reason !== 'string' || reason.length > 100)
                return 'rejected';
            if (reason === 'audit skipped: cancelled_or_expired')
                return 'cancelled_or_expired';
            const prefix = 'protected_audit_unavailable: ';
            return rejectionCodes.get(reason) ?? (reason.startsWith(prefix) ? rejectionCodes.get(reason.slice(prefix.length)) : undefined) ?? 'rejected';
        }
    }
    catch { /* Diagnostic access cannot replace the original preparation outcome. */ }
    return 'rejected';
}
function contextSnapshotRejectionCode(error) {
    try {
        return error instanceof Error && error.message === 'snapshot_aborted' ? 'snapshot_aborted' : 'snapshot_rejected';
    }
    catch {
        return 'snapshot_rejected';
    }
}
/** Opt-in invocation diagnostics contain timings only, never records, paths or errors.
 * The observer runs after the operation and cannot spend its selection deadline. */
export function withContextReadDiagnostics(enabled, run, report) {
    if (!enabled)
        return run();
    const collector = { stages: [], truncated: false, pendingStages: 0 };
    return (async () => {
        try {
            return await diagnostic.run(collector, run);
        }
        finally {
            try {
                void Promise.resolve(report({ schema: 'evolver.context-read-timing.v1',
                    stages: collector.stages.map(stage => ({ ...stage })), truncated: collector.truncated, pendingStages: collector.pendingStages })).catch(() => undefined);
            }
            catch { /* A diagnostic observer must not replace the operation's outcome. */ }
        }
    })();
}
export function startContextReadStage(phase) {
    const collector = diagnostic.getStore();
    if (!collector || !phases.has(phase))
        return undefined;
    collector.pendingStages++;
    const started = performance.now();
    let recorded = false;
    return (outcome, code) => {
        if (recorded)
            return;
        recorded = true;
        collector.pendingStages--;
        if (collector.stages.length >= MAX_STAGES) {
            collector.truncated = true;
            return;
        }
        const allowedCode = code && ((phase === 'delivery_prepare' && preparationCodes.has(code))
            || ((phase === 'gene_snapshot' || phase === 'related_snapshot') && outcome === 'rejected' && snapshotCodes.has(code)));
        collector.stages.push({ phase, durationMs: Math.round(Math.max(0, performance.now() - started) * 100) / 100, outcome,
            ...(allowedCode ? { code } : {}) });
    };
}
export function measureContextReadStage(phase, run) {
    if (!diagnostic.getStore())
        return run();
    const finish = startContextReadStage(phase);
    if (!finish)
        return run();
    try {
        // Preserve the original dispatch scheduling; do not defer the reader into a new microtask.
        return run().then(value => { finish('fulfilled'); return value; }, error => {
            finish('rejected', phase === 'gene_snapshot' || phase === 'related_snapshot'
                ? contextSnapshotRejectionCode(error) : undefined);
            throw error;
        });
    }
    catch (error) {
        finish('rejected', phase === 'gene_snapshot' || phase === 'related_snapshot' ? contextSnapshotRejectionCode(error) : undefined);
        throw error;
    }
}