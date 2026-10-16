const retainedSequences = new WeakSet();
/** An opaque rejected await has no recoverable JavaScript continuation. */
export class AuditCleanupContinuationRequiredError extends Error {
    failure;
    constructor(failure) {
        super('audit cleanup continuation unavailable; use an explicit retained cleanup sequence', { cause: failure });
        this.failure = failure;
        this.name = 'AuditCleanupContinuationRequiredError';
    }
}
function nestedCleanupErrors(error, seen = new Set()) {
    if (seen.has(error))
        return [];
    seen.add(error);
    if (error instanceof AuditCleanupError)
        return [error];
    return error instanceof AggregateError ? error.errors.flatMap(value => nestedCleanupErrors(value, seen)) : [];
}
async function recoverNestedCleanup(error) {
    for (const nested of nestedCleanupErrors(error))
        await nested.retryCleanup();
}
/**
 * Keeps write/operation evidence separate from resource cleanup failure. Never retry the
 * original operation: only this retained cleanup capability may be retried. A failed
 * operation may have submitted bytes; failure is not proof that nothing was written.
 */
export class AuditCleanupError extends AggregateError {
    operation;
    cleanupError;
    cleanup;
    cleanupConfirmed;
    cleanupAttempt;
    cleaned = false;
    pendingCleanupError;
    constructor(operation, cleanupError, cleanup, 
    /** Read-only confirmation from this same retained resource owner, never a caller timeout. */
    cleanupConfirmed) {
        super(operation.status === 'failed' ? [operation.error, cleanupError] : [cleanupError], 'audit cleanup failed; do not retry the operation');
        this.operation = operation;
        this.cleanupError = cleanupError;
        this.cleanup = cleanup;
        this.cleanupConfirmed = cleanupConfirmed;
        this.name = 'AuditCleanupError';
        this.pendingCleanupError = cleanupError;
    }
    get cleanupComplete() { return this.cleaned || this.cleanupConfirmed?.() === true; }
    get lastCleanupError() { return this.pendingCleanupError; }
    retryCleanup() {
        if (this.cleanupComplete) {
            this.cleaned = true;
            return Promise.resolve();
        }
        if (!this.cleanupAttempt) {
            this.cleanupAttempt = Promise.resolve().then(async () => {
                // Nested file/lock failures keep both capabilities. Finish the inner resource
                // before retrying its outer cleanup, without ever invoking the write callback.
                if (this.operation.status === 'failed')
                    await recoverNestedCleanup(this.operation.error);
                if (!retainedSequences.has(this.cleanup)) {
                    await recoverNestedCleanup(this.pendingCleanupError);
                    // Any rejected opaque callback may already have completed effects before
                    // its ordinary or nested error. JavaScript cannot resume its unknown tail.
                    throw new AuditCleanupContinuationRequiredError(this.pendingCleanupError);
                }
                try {
                    await this.cleanup();
                }
                catch (error) {
                    this.pendingCleanupError = error;
                    throw error;
                }
                this.cleaned = true;
            }).finally(() => { this.cleanupAttempt = undefined; });
        }
        return this.cleanupAttempt;
    }
}
/**
 * Retains explicit cleanup steps and their pending tail. A completed step operation
 * is never replayed to recover its cleanup. Failed operations require an explicit
 * idempotence declaration (or another retained sequence), never an inferred retry.
 * A step's cleanup has the same rule: use a retained sequence or explicitly declare
 * its atomic/state-retaining retry contract with retryFailedCleanup.
 * Create a sequence per resource owner; it must not be reused for new acquisitions.
 */
export function auditCleanupSequence(steps) {
    const plan = steps.map(step => {
        // Structural steps may keep methods on a prototype and state on their
        // receiver. Capture methods without losing registered sequence identity.
        const bind = (run) => retainedSequences.has(run) ? run : run.bind(step);
        return {
            run: bind(step.run),
            ...(step.cleanup ? { cleanup: step.retryFailedCleanup
                    ? auditCleanupSequence([{ run: bind(step.cleanup), retryFailedOperation: true }])
                    : bind(step.cleanup) } : {}),
            ...(step.retryFailedOperation === undefined ? {} : { retryFailedOperation: step.retryFailedOperation }),
        };
    });
    const states = [];
    let cursor = 0;
    let attempt;
    const sequence = () => attempt ??= Promise.resolve().then(async () => {
        while (cursor < plan.length) {
            const step = plan[cursor];
            const state = states[cursor] ??= {};
            if (state.operation) {
                if (state.cleanupFailure) {
                    await state.cleanupFailure.retryCleanup();
                    delete state.cleanupFailure;
                }
                else if (state.operation.status === 'failed')
                    await recoverNestedCleanup(state.operation.error);
                if (state.operation.status === 'completed') {
                    cursor++;
                    continue;
                }
                if (!step.retryFailedOperation && !retainedSequences.has(step.run))
                    throw state.operation.error;
                delete state.operation;
            }
            try {
                state.operation = { status: 'completed', value: await step.run() };
            }
            catch (error) {
                state.operation = { status: 'failed', error };
            }
            const cleanup = step.cleanup ?? (async () => { });
            try {
                await cleanup();
            }
            catch (error) {
                state.cleanupFailure = new AuditCleanupError(state.operation, error, cleanup);
                throw state.cleanupFailure;
            }
            if (state.operation.status === 'failed')
                throw state.operation.error;
            cursor++;
        }
    }).finally(() => { attempt = undefined; });
    retainedSequences.add(sequence);
    return sequence;
}
/** Await cleanup on every path without letting finally erase the callback's outcome. */
export async function withAuditCleanup(run, cleanup) {
    let operation;
    try {
        operation = { status: 'completed', value: await run() };
    }
    catch (error) {
        operation = { status: 'failed', error };
    }
    try {
        await cleanup();
    }
    catch (error) {
        throw new AuditCleanupError(operation, error, cleanup);
    }
    if (operation.status === 'failed')
        throw operation.error;
    return operation.value;
}