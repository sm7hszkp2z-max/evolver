import { type ContextObservationAttempt, type ContextObservationWait, type ContextObservationOperationV1 } from './contextObservationSettlement.js';
export interface ContextIndexProgress {
    status: 'complete' | 'catching_up' | 'unknown';
    bytesRead: number;
    indexedThroughSeq: number;
    reason?: 'history_gap' | 'invalid_row' | 'partial_tail' | 'unavailable' | 'busy' | 'unsupported_sink';
}
export interface ContextObservationSink {
    /** Durable observations require the canonical target of the actual writer. */
    readonly path?: string;
    /** Versioned terminal ownership. Legacy ingest callbacks cannot prove that a
     * timed-out operation stopped and are refused before dispatch. */
    beginContextObservationV1?(raw: {
        type: string;
        human: {
            title: string;
        };
        payload: Record<string, unknown>;
    }, attempt: ContextObservationAttempt): ContextObservationOperationV1;
    /** Legacy shape retained for source compatibility only; never dispatched by observeSession. */
    ingest?(raw: {
        type: string;
        human: {
            title: string;
        };
        payload: Record<string, unknown>;
    }, attempt?: ContextObservationAttempt): unknown;
}
export interface ContextSessionObservation {
    emitted: number;
    hasDelivery: boolean;
    historyComplete: boolean;
    pending?: boolean;
}
export declare class ContextObservationFailure extends Error {
    readonly emitted: number;
    constructor(cause: unknown, emitted: number);
}
/** Durable, disposable read model. Only delivery/observation identity and counts are stored, never prompt bodies.
 * Each tick has one bounded scan across archive + active bytes, then indexed per-session queries. The external
 * pid-aware non-waiting lock covers scan and admission. Independent durable intents retain unknown appends
 * after the bounded wait ends, allowing the tick to close without replaying those deliveries.
 * On crash after the event append but before the local marker, the next scan ingests that observation before
 * allowing emission. Incomplete catch-up therefore never means "no delivery", nor permits lexical rewards.
 */
export declare class GeneContextObservationIndex {
    private readonly db;
    private readonly lockPath;
    private locked;
    private owner;
    private observing;
    private readonly historyIdentities;
    private tickBudget;
    private progress;
    readonly eventsPath: string;
    private readonly identityPath;
    private readonly protectedClient;
    private protectedToken;
    constructor(eventsPath: string, indexPath?: string, identityPath?: string);
    /** Returns false rather than blocking the event loop behind another (possibly same-process) tick. */
    beginTick(maxBytes?: number): ContextIndexProgress;
    endTick(): void;
    close(): void;
    private getState;
    private setState;
    private resetHistory;
    private advance;
    private indexEvent;
    private markObserved;
    /** A caller without the durable tick must not reserve session work from its owner. */
    get observationReady(): boolean;
    /** Includes catch-up/unknown changes after beginTick; callers must not report its initial snapshot as final. */
    get currentProgress(): ContextIndexProgress;
    observeSession(sessionId: string, sink: ContextObservationSink, limit?: number, options?: ContextObservationWait): Promise<ContextSessionObservation>;
}