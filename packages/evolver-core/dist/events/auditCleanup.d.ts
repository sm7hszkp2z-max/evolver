/** A completed callback is not a successful API receipt until its cleanup also succeeds. */
export type AuditOperationOutcome<T> = {
    readonly status: 'completed';
    readonly value: T;
} | {
    readonly status: 'failed';
    readonly error: unknown;
};
/** An opaque rejected await has no recoverable JavaScript continuation. */
export declare class AuditCleanupContinuationRequiredError extends Error {
    readonly failure: unknown;
    constructor(failure: unknown);
}
/**
 * Keeps write/operation evidence separate from resource cleanup failure. Never retry the
 * original operation: only this retained cleanup capability may be retried. A failed
 * operation may have submitted bytes; failure is not proof that nothing was written.
 */
export declare class AuditCleanupError<T = unknown> extends AggregateError {
    readonly operation: AuditOperationOutcome<T>;
    readonly cleanupError: unknown;
    private readonly cleanup;
    /** Read-only confirmation from this same retained resource owner, never a caller timeout. */
    private readonly cleanupConfirmed?;
    private cleanupAttempt?;
    private cleaned;
    private pendingCleanupError;
    constructor(operation: AuditOperationOutcome<T>, cleanupError: unknown, cleanup: () => Promise<void>, 
    /** Read-only confirmation from this same retained resource owner, never a caller timeout. */
    cleanupConfirmed?: (() => boolean) | undefined);
    get cleanupComplete(): boolean;
    get lastCleanupError(): unknown;
    retryCleanup(): Promise<void>;
}
export interface AuditCleanupStep {
    run(): Promise<unknown>;
    cleanup?(): Promise<void>;
    /** Only resource-owner operations known to be idempotent may restart after failure. */
    retryFailedOperation?: boolean;
    /** Declare only an atomic/state-retaining resource cleanup, never an opaque multi-step callback. */
    retryFailedCleanup?: boolean;
}
/**
 * Retains explicit cleanup steps and their pending tail. A completed step operation
 * is never replayed to recover its cleanup. Failed operations require an explicit
 * idempotence declaration (or another retained sequence), never an inferred retry.
 * A step's cleanup has the same rule: use a retained sequence or explicitly declare
 * its atomic/state-retaining retry contract with retryFailedCleanup.
 * Create a sequence per resource owner; it must not be reused for new acquisitions.
 */
export declare function auditCleanupSequence(steps: readonly AuditCleanupStep[]): () => Promise<void>;
/** Await cleanup on every path without letting finally erase the callback's outcome. */
export declare function withAuditCleanup<T>(run: () => Promise<T>, cleanup: () => Promise<void>): Promise<T>;