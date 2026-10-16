import { createHash } from 'node:crypto';
/** Separate from value.inject/value.recall: delivery is neither task success nor observed reuse. */
export const GENE_CONTEXT_DELIVERY_EVENT = 'value.gene_context_delivery';
export const GENE_CONTEXT_OBSERVATION_EVENT = 'value.gene_context_observation';
export const GENE_CONTEXT_RECEIPT_MAX_BYTES = 2800;
/** Stable source-event identity, not merely a reusable session/sequence/content tuple. */
export function geneContextDeliveryIdentity(event, sessionId, receiptDigest) {
    const hash = (value) => createHash('sha256').update(value).digest('hex');
    return hash(JSON.stringify([event.eventId, event.ts, event.seq, hash(sessionId), receiptDigest]));
}
const ID = /^sha256:[a-f0-9]{64}$/;
const KINDS = new Set(['summary', 'strategy', 'preconditions', 'validation_plan', 'example']);
const REASONS = new Set(['privacy_off', 'privacy_shadow', 'cancelled', 'timeout', 'unsupported_provider', 'source_unavailable', 'query_truncated', 'invalid_identity', 'ambiguous_relation', 'unbound_relation', 'not_success', 'reference_only', 'trust_rejected', 'review_rejected', 'qualification_rejected', 'qualification_unavailable', 'unsafe_or_oversize_field', 'preconditions_rejected', 'empty_content', 'method_budget', 'example_budget', 'example_limit']);
/** Whitelist only bounded IDs, enums, offsets and digests. No bodies, paths, source records or verification claims. */
function boundedReceipt(context) {
    if (!ID.test(context.digest) || !['summary', 'strategy', 'context'].includes(context.contentMode))
        throw new Error('invalid_gene_context_receipt');
    const ids = (values) => [...new Set(values.filter((id) => ID.test(id)))].slice(0, 64);
    const receipt = {
        schema: 'gene-context-delivery.v1', contentMode: context.contentMode, digest: context.digest,
        geneAssetIds: ids(context.geneAssetIds), capsuleAssetIds: ids(context.capsuleAssetIds),
        sections: context.sections.slice(0, 128).filter((s) => ID.test(s.geneAssetId) && ID.test(s.digest)
            && KINDS.has(s.kind) && Number.isSafeInteger(s.start) && Number.isSafeInteger(s.end) && s.start >= 0 && s.end > s.start
            && s.end <= Math.min(context.text.length, 128000) && (!s.capsuleAssetId || ID.test(s.capsuleAssetId)))
            .map((s) => ({ geneAssetId: s.geneAssetId, ...(s.capsuleAssetId ? { capsuleAssetId: s.capsuleAssetId } : {}),
            kind: s.kind, start: s.start, end: s.end, digest: s.digest,
            ...(Number.isSafeInteger(s.itemIndex) && s.itemIndex >= 0 ? { itemIndex: s.itemIndex } : {}) })),
        qualificationRefs: context.qualificationRefs.slice(0, 64).filter((item) => ID.test(item.assetId) && ID.test(item.evidenceDigest))
            .map(({ assetId, evidenceDigest }) => ({ assetId, evidenceDigest })),
        omissions: context.omissions.slice(0, 64).filter((s) => REASONS.has(s.reason)).map((s) => ({
            ...(s.geneAssetId && ID.test(s.geneAssetId) ? { geneAssetId: s.geneAssetId } : {}),
            ...(s.capsuleAssetId && ID.test(s.capsuleAssetId) ? { capsuleAssetId: s.capsuleAssetId } : {}), reason: s.reason,
        })), truncated: context.truncated === true,
    };
    receipt.truncated ||= receipt.geneAssetIds.length !== context.geneAssetIds.length || receipt.capsuleAssetIds.length !== context.capsuleAssetIds.length
        || receipt.sections.length !== context.sections.length || receipt.omissions.length !== context.omissions.length
        || receipt.qualificationRefs.length !== context.qualificationRefs.length;
    while (Buffer.byteLength(JSON.stringify(receipt), 'utf8') > GENE_CONTEXT_RECEIPT_MAX_BYTES) {
        receipt.truncated = true;
        if (receipt.omissions.length)
            receipt.omissions.pop();
        else if (receipt.sections.length)
            receipt.sections.pop();
        else if (receipt.qualificationRefs.length)
            receipt.qualificationRefs.pop();
        else if (receipt.capsuleAssetIds.length)
            receipt.capsuleAssetIds.pop();
        else
            receipt.geneAssetIds.pop();
    }
    return receipt;
}
export function geneContextDeliveryReceipt(context) {
    return boundedReceipt({ ...context, qualificationRefs: context.qualifications.flatMap((item) => item.evidenceDigest ? [{ assetId: item.assetId, evidenceDigest: item.evidenceDigest }] : []) });
}
/** Strict read boundary; malformed/oversized/unknown-version receipts are not delivery evidence. */
export function readGeneContextDeliveryReceipt(value) {
    if (!value || typeof value !== 'object')
        return undefined;
    try {
        if (Buffer.byteLength(JSON.stringify(value), 'utf8') > GENE_CONTEXT_RECEIPT_MAX_BYTES)
            return undefined;
        const r = value;
        if (r.schema !== 'gene-context-delivery.v1' || !ID.test(r.digest) || !['summary', 'strategy', 'context'].includes(r.contentMode)
            || typeof r.truncated !== 'boolean' || !Array.isArray(r.geneAssetIds) || !Array.isArray(r.capsuleAssetIds)
            || ![...r.geneAssetIds, ...r.capsuleAssetIds].every((id) => typeof id === 'string' && ID.test(id))
            || !Array.isArray(r.sections) || !Array.isArray(r.omissions) || !Array.isArray(r.qualificationRefs))
            return undefined;
        // Reuse the producer whitelist, then require an exact structural round-trip (including unknown-field rejection).
        const normalized = boundedReceipt({ ...r, text: ' '.repeat(Math.min(128000, Math.max(0, ...r.sections.map((s) => s.end)))) });
        normalized.truncated = r.truncated;
        const canonical = (x) => JSON.stringify(x, Object.keys((x ?? {})).sort());
        if (Object.keys(r).sort().join() !== Object.keys(normalized).sort().join())
            return undefined;
        if (r.sections.some((s, i) => canonical(s) !== canonical(normalized.sections[i]))
            || r.omissions.some((s, i) => canonical(s) !== canonical(normalized.omissions[i]))
            || r.qualificationRefs.some((s, i) => canonical(s) !== canonical(normalized.qualificationRefs[i]))
            || r.geneAssetIds.length !== normalized.geneAssetIds.length || r.capsuleAssetIds.length !== normalized.capsuleAssetIds.length)
            return undefined;
        return normalized;
    }
    catch {
        return undefined;
    }
}