import { Ingestor } from '../events/ingest.js';
import type { RawEvent } from '../events/eventSchema.js';
export interface ContextObservationAttempt {
    readonly operationId: string;
    readonly signal: AbortSignal;
    /** Absolute admission deadline; timers cannot interrupt synchronous validation or append setup. */
    readonly deadlineAt?: number;
}
export interface ContextObservationWait {
    signal?: AbortSignal;
    deadlineAt?: number;
}
/** Only an explicit, identity-bound no-commit receipt permits replay after dispatch. */
export interface ContextObservationReceipt {
    operationId: string;
    outcome: 'committed' | 'not_committed' | 'unknown';
}
/** A terminal receipt attests that the adapter cannot perform any further write for this operation.
 * AbortSignal alone is not such an attestation. Implementations must own their worker/I/O
 * through cancellation, acknowledgement and cleanup before resolving either promise. */
export interface ContextObservationOperationV1 {
    readonly version: 1;
    readonly result: Promise<ContextObservationReceipt>;
    cancelAndSettle(): Promise<ContextObservationReceipt>;
}
/** Synchronous admission returns the operation owner before any asynchronous write starts. */
export interface ContextObservationDispatchV1 {
    readonly version: 1;
    begin(attempt: ContextObservationAttempt): ContextObservationOperationV1;
}
export declare function builtInContextObservationDispatch(ingestor: Ingestor, raw: RawEvent, expectedPath: string): ContextObservationDispatchV1;
export declare class ContextObservationNotCommittedError extends Error {
    readonly operationId: string;
    constructor(operationId: string);
}
export interface ObservationIntentStore {
    /** No mutation or reservation. Missing/stale committed rows require fresh admission.
     * Legacy adapters without lookup remain supported, but cannot be queried at full capacity. */
    lookup?(key: string): 'pending' | 'committed' | undefined;
    reserve(key: string): 'new' | 'pending' | 'committed';
    /** Pending retains the exact owned settlement capability for a later retry.
     * Legacy void completion continues to mean successful settlement. */
    settle(key: string, outcome: 'committed' | 'not_committed'): void | 'pending';
}
/** Recovery state, separate from the disposable index. Never delete it when rebuilding that index. */
export declare function durableObservationIntents(eventsPath: string): ObservationIntentStore;
/** A proved history rewind invalidates settled acknowledgements, never unknown in-flight intents. */
export declare function resetObservationAcknowledgements(eventsPath: string): void;
/** Pathless adapters have no invented durable path; their owner must provide cross-process persistence. */
export declare function memoryObservationIntents(owner: object): ObservationIntentStore;
/** Deadline ends waiting, not ownership of an unknown append. Its durable intent prevents replay. */
export declare function settleContextObservation(store: ObservationIntentStore, identity: string, dispatch: ContextObservationDispatchV1, options?: ContextObservationWait, 
/** Internal batch budget: starts after the first durable reservation, then caps every row together. */
sharedWait?: {
    deadlineAt?: number;
}): Promise<'committed' | 'pending' | 'already_committed'>;