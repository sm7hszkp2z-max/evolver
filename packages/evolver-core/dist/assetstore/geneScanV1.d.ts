import type { GeneReadSnapshot } from './boundedSnapshot.js';
import type { AssetRecord } from './provider.js';
/** Versioned, single-owner authority scan. A page reports raw Gene rows examined,
 * including rows filtered from the result. A snapshot is authoritative only on a
 * complete page and after close() confirms settlement. */
export interface GeneScanPageV1 {
    version: 1;
    sourceId: string;
    epoch: string;
    scanned: number;
    bytes: number;
    /** Raw rows examined on this page, including ineligible and duplicate rows.
     * These are not an executable authority snapshot until complete and close. */
    rawRows: readonly AssetRecord[];
    complete: boolean;
    continuation: string | null;
    snapshot?: GeneReadSnapshot;
}
export interface GeneScanSessionV1 {
    next(options: {
        maxRecords: number;
        maxBytes: number;
        continuation?: string;
    }): Promise<GeneScanPageV1>;
    /** Idempotent only after actual reader/adapter cleanup has finished. */
    close(): Promise<void>;
}