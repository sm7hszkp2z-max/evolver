import type { AssetRecord } from './provider.js';
import type { ProvenanceRecord } from './provenance.js';
import type { ReviewRecord } from './reviewLedger.js';
/** Local-only optional capability. No search/list/network fallback is permitted. */
export interface RelatedCapsuleQuery {
    genes: readonly {
        assetId: string;
        logicalId?: string;
    }[];
    /** Maximum records inspected per source, across all requested Genes. */
    maxRecords?: number;
    /** Maximum matching Capsules returned per source, NOT per Gene. */
    maxCapsules?: number;
    signal?: AbortSignal;
    /** Absolute deadline shared with the whole assembly; never restarted per source. */
    deadlineAt?: number;
}
export type RelatedSourceStatus = 'complete' | 'truncated' | 'unavailable' | 'aborted' | 'unsupported';
export interface RelatedCapsuleSource {
    /** Opaque stable namespace; never an on-disk path. Logical ids are source-scoped. */
    sourceId: string;
    status: RelatedSourceStatus;
    scanned: number;
    /** True only when all source Gene identities were inspected and retained. */
    identityComplete: boolean;
    genes: AssetRecord[];
    capsules: AssetRecord[];
    /** Own source sidecars. Absence means local-default, never another source's approval. */
    provenance: ReadonlyMap<string, ProvenanceRecord>;
    review: ReadonlyMap<string, ReviewRecord>;
}
export interface RelatedCapsuleResult {
    sources: RelatedCapsuleSource[];
}
export declare function relatedQueryLimits(query: RelatedCapsuleQuery): {
    maxRecords: number;
    maxCapsules: number;
};
export declare function captureRelatedGenes(value: RelatedCapsuleQuery['genes']): RelatedCapsuleQuery['genes'];
export declare function relatedQueryAborted(query: Pick<RelatedCapsuleQuery, 'signal' | 'deadlineAt'>): boolean;
export declare function emptyRelatedSource(sourceId: string, status: RelatedSourceStatus): RelatedCapsuleSource;
export declare function relatedSourceId(baseDir: string): string;
/** Shared Local/Foreign adapter. A read-only bounded snapshot, never Local.ensureFresh(). */
export declare function queryLocalRelatedCapsules(baseDir: string, query: RelatedCapsuleQuery): Promise<RelatedCapsuleResult>;