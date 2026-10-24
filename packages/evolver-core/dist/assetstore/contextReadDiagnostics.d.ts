export type ContextReadStage = 'worker_first_ipc' | 'worker_close' | 'gene_snapshot' | 'related_snapshot' | 'prompt_selection' | 'prompt_assembly' | 'delivery_prepare' | 'delivery_validate' | 'delivery_journal_open' | 'delivery_journal_transaction' | 'delivery_journal_close' | 'delivery_cleanup' | 'worker_bootstrap' | 'worker_native_ready' | 'worker_lstat' | 'snapshot_owned';
export type ContextDeliveryPrepareCode = 'prepared' | 'rejected' | 'invalid_capability' | 'deadline' | 'timeout' | 'not_configured' | 'transport_timeout_unknown' | 'transport_aborted_unknown' | 'transport_closed_unknown' | 'admission_expired' | 'request_expired' | 'request_invalid_or_expired' | 'cancelled_or_expired';
export type ContextSnapshotReadCode = 'snapshot_aborted' | 'snapshot_rejected';
/** Initial prepare only. Tuples are [elapsed milliseconds, actual settlement]. */
export type ContextDeliveryTransactionTiming = Partial<Record<'begin' | 'body' | 'commit' | 'rollback', readonly [number, 'fulfilled' | 'rejected']>>;
export type ContextSnapshotOwnedTiming = {
    kind: 'gene' | 'related';
} & Partial<Record<'root' | 'assets' | 'metadata' | 'verify' | 'cleanup', readonly [number, 'fulfilled' | 'rejected']>>;
export interface ContextReadStageTiming {
    phase: ContextReadStage;
    durationMs: number;
    /** Promise settlement, not a successful context/host acknowledgement. */
    outcome: 'fulfilled' | 'rejected';
    /** Fixed preparation or snapshot rejection classification; never an error message or path. */
    code?: ContextDeliveryPrepareCode | ContextSnapshotReadCode;
    /** Compact detail, not extra stages that could displace delivery_prepare. */
    transaction?: ContextDeliveryTransactionTiming;
    /** One anonymous owned call, never merged with another call's segments. */
    snapshot?: ContextSnapshotOwnedTiming;
}
export interface ContextReadDiagnosticReport {
    schema: 'evolver.context-read-timing.v1';
    stages: readonly ContextReadStageTiming[];
    truncated: boolean;
    /** Started phases that have not actually settled when the invocation ends. */
    pendingStages: number;
}
/** Classify only known typed failures; arbitrary service/error text never enters diagnostics. */
export declare function contextDeliveryRejectionCode(error: unknown): ContextDeliveryPrepareCode;
/** Opt-in invocation diagnostics contain timings only, never records, paths or errors.
 * The observer runs after the operation and cannot spend its selection deadline. */
export declare function withContextReadDiagnostics<T>(enabled: boolean, run: () => Promise<T>, report: (value: ContextReadDiagnosticReport) => unknown): Promise<T>;
export declare function startContextReadStage(phase: ContextReadStage): ((outcome: ContextReadStageTiming['outcome'], code?: ContextDeliveryPrepareCode | ContextSnapshotReadCode, transaction?: ContextDeliveryTransactionTiming, snapshot?: ContextSnapshotOwnedTiming) => void) | undefined;
export declare function measureContextReadStage<T>(phase: ContextReadStage, run: () => Promise<T>): Promise<T>;