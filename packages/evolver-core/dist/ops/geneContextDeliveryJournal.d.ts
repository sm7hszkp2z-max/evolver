import type { RawEvent } from '../events/eventSchema.js';
import { type AuditWriteOptions } from '../events/boundedAudit.js';
export interface ContextDeliveryStatus {
    confirmedPending: number;
    outputUnknown: number;
    projectionUnknown: number;
    projected: number;
    busy: boolean;
    reasons: Partial<Record<ContextDeliveryReason | 'cleanup_pending', number>>;
}
export type ContextDeliveryReason = 'output_unconfirmed' | 'target_changed' | 'history_missing' | 'metadata_invalid' | 'append_unconfirmed';
export interface PreparedContextDelivery {
    readonly operationId: string;
    /** Only the original actual output callback may use this once-only capability. */
    confirmOutput(): void;
    outputUnknown(): void;
    project(options?: AuditWriteOptions): Promise<'projected' | 'pending' | 'unknown'>;
    /** Releases completed ownership; does not abandon a pending confirmation or projection. */
    release(): void;
}
export interface DeliveryProjectionPlan {
    line: string;
    offset: number;
    identity: string;
    archive?: string;
    previous?: {
        archive?: string;
        offset: number;
        identity: string;
    };
}
export interface DeliveryProjectionAuthority {
    readonly operationId: string;
    read(): {
        state: string;
        raw: RawEvent;
        plan?: DeliveryProjectionPlan;
        targetIdentity: string | null;
    };
    plan(value: DeliveryProjectionPlan): void;
    projected(): void;
    notDispatched(): void;
    unknown(reason?: ContextDeliveryReason): void;
}
/** Corrupt persisted metadata is distinct from unavailable journal authority. */
export declare class DeliveryMetadataInvalidError extends Error {
}
type Project = (path: string, authority: DeliveryProjectionAuthority, options: AuditWriteOptions) => Promise<'projected' | 'pending' | 'unknown'>;
/** Snapshot a strict metadata whitelist. Arbitrary RawEvent fields can never reach this sidecar. */
export declare function snapshotContextDelivery(raw: RawEvent, operationId: string): RawEvent;
/** Called only after Ingestor validation. No event-log writes happen in the outbox. */
export declare function prepareContextDelivery(raw: RawEvent, path: string, project: Project, options?: AuditWriteOptions): PreparedContextDelivery;
/** Final synchronous append admission; no SQLite read can erase actual ownership. */
export declare function contextDeliveryRootOwned(path: string): boolean;
export declare function contextDeliveryStatus(path: string): ContextDeliveryStatus;
export declare function recoverContextDeliveries(path: string, project: Project, options?: AuditWriteOptions): Promise<ContextDeliveryStatus>;
/** Archiver already owns the root writer lock. Publish exact locators before replacing the active log. */
export declare function relocateContextDeliveryProjections(path: string, locate: (line: string) => {
    archive?: string;
    offset: number;
    identity: string;
} | undefined, targets: {
    before: string;
    after: string;
}): void;
export {};