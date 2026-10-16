import { events, ops, assetstore } from '@evomap/evolver-core';
export interface AutoRecallDeps {
    /** Native session identity, when it is explicitly supplied by a runtime adapter. */
    sessionId?: string;
    /** Newly connected runtime sources must not opt into legacy lexical reward feedback. */
    contextOnly?: boolean;
    /** A single bounded root-log scan shared by every session in the production ingest tick. */
    contextIndex?: ops.GeneContextObservationIndex;
    /** Isolated event root for direct callers; production derives it from the ingestor. */
    eventsPath?: string;
    /** Read root_events. Default: live root log; observation writes require a matching durable sink path. */
    readEvents?: (eventsPath?: string) => events.ReportEvent[];
    /** Resolve injected geneIds to Gene records. Default: live local store. */
    store?: Pick<assetstore.AssetStoreProvider, 'get' | 'list'>;
    /** Sink for the emitted `value.recall` events. */
    ingestor: {
        readonly path?: string;
        /** Versioned terminal operation. Legacy callbacks are refused before dispatch. */
        beginContextObservationV1?(raw: {
            type: string;
            human: {
                title: string;
                detail?: string;
            };
            payload?: Record<string, unknown>;
        }, attempt: ops.ContextObservationAttempt): ops.ContextObservationOperationV1;
        ingest?(raw: {
            type: string;
            human: {
                title: string;
                detail?: string;
            };
            payload?: Record<string, unknown>;
        }, attempt?: ops.ContextObservationAttempt): unknown;
    };
    observationWait?: ops.ContextObservationWait;
}
/**
 * Derive + emit `value.recall` for ONE session transcript. Returns the number of verdicts emitted (0 when there is
 * no matching inject, no resolvable gene, or the session was already recalled). Idempotent: a session whose
 * `value.recall` already exists is skipped, so a polling daemon never re-emits. Best-effort: failures retain the
 * acknowledged prefix count (0 if none); an unconfirmed append is never counted as successful.
 */
export declare function emitSessionRecall(transcriptPath: string, turns: readonly ops.RecallTurn[], deps: AutoRecallDeps): Promise<number>;