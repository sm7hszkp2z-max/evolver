import type { AssembledGeneContext, GeneContextContentMode, GeneContextSection, GeneContextOmission } from '../assetstore/geneContext.js';
/** Separate from value.inject/value.recall: delivery is neither task success nor observed reuse. */
export declare const GENE_CONTEXT_DELIVERY_EVENT = "value.gene_context_delivery";
export declare const GENE_CONTEXT_OBSERVATION_EVENT = "value.gene_context_observation";
export declare const GENE_CONTEXT_RECEIPT_MAX_BYTES = 2800;
/** Stable source-event identity, not merely a reusable session/sequence/content tuple. */
export declare function geneContextDeliveryIdentity(event: {
    eventId?: unknown;
    ts?: unknown;
    seq?: unknown;
}, sessionId: string, receiptDigest: string): string;
export interface GeneContextDeliveryReceipt {
    schema: 'gene-context-delivery.v1';
    contentMode: GeneContextContentMode;
    digest: string;
    geneAssetIds: string[];
    capsuleAssetIds: string[];
    sections: GeneContextSection[];
    omissions: GeneContextOmission[];
    qualificationRefs: {
        assetId: string;
        evidenceDigest: string;
    }[];
    /** Metadata may be shortened, never silently represented as complete. Digest still binds the full final text. */
    truncated: boolean;
}
export declare function geneContextDeliveryReceipt(context: AssembledGeneContext): GeneContextDeliveryReceipt;
/** Strict read boundary; malformed/oversized/unknown-version receipts are not delivery evidence. */
export declare function readGeneContextDeliveryReceipt(value: unknown): GeneContextDeliveryReceipt | undefined;