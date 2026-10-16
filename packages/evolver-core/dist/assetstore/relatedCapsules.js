import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { checkedSnapshotAssets, readLocalSnapshot, withSnapshotDeadline } from './boundedSnapshot.js';
export function relatedQueryLimits(query) {
    const bounded = (value, fallback, max) => {
        if (value === undefined)
            return fallback;
        if (!Number.isInteger(value) || value < 0 || value > max)
            throw new Error('invalid_related_capsule_budget');
        return value;
    };
    if (query.genes.length > 64 || (query.deadlineAt !== undefined && !Number.isFinite(query.deadlineAt)))
        throw new Error('invalid_related_capsule_query');
    return { maxRecords: bounded(query.maxRecords, 10000, 100000), maxCapsules: bounded(query.maxCapsules, 128, 1024) };
}
export function captureRelatedGenes(value) {
    if (!Array.isArray(value) || value.length > 64)
        throw new Error('invalid_related_capsule_query');
    const genes = [];
    for (let index = 0; index < value.length; index++) {
        if (!Object.hasOwn(value, index))
            throw new Error('invalid_related_capsule_query');
        const gene = value[index];
        if (!gene || typeof gene !== 'object' || Array.isArray(gene)
            || ![Object.prototype, null].includes(Object.getPrototypeOf(gene)))
            throw new Error('invalid_related_capsule_query');
        // Inspect data properties once, before dispatch. Getters and inherited IDs
        // would let a caller change which Gene a later source is asked to inspect.
        const assetId = Object.getOwnPropertyDescriptor(gene, 'assetId');
        const logicalId = Object.getOwnPropertyDescriptor(gene, 'logicalId');
        if (!assetId || !('value' in assetId) || typeof assetId.value !== 'string' || !assetId.value
            || (logicalId && (!('value' in logicalId) || (logicalId.value !== undefined && typeof logicalId.value !== 'string')))
            || (!logicalId && 'logicalId' in gene))
            throw new Error('invalid_related_capsule_query');
        genes.push(Object.freeze({ assetId: assetId.value,
            ...(logicalId?.value !== undefined ? { logicalId: logicalId.value } : {}) }));
    }
    return Object.freeze(genes);
}
export function relatedQueryAborted(query) {
    return query.signal?.aborted === true || (query.deadlineAt !== undefined && Date.now() >= query.deadlineAt);
}
export function emptyRelatedSource(sourceId, status) {
    return { sourceId, status, scanned: 0, identityComplete: false, genes: [], capsules: [], provenance: new Map(), review: new Map() };
}
export function relatedSourceId(baseDir) {
    return `local:${createHash('sha256').update(resolve(baseDir)).digest('hex')}`;
}
/** Shared Local/Foreign adapter. A read-only bounded snapshot, never Local.ensureFresh(). */
export async function queryLocalRelatedCapsules(baseDir, query) {
    const input = { ...query };
    const genes = captureRelatedGenes(input.genes);
    const boundedQuery = { ...input, genes };
    const limits = relatedQueryLimits(boundedQuery);
    const sourceId = relatedSourceId(baseDir);
    if (genes.length === 0)
        return { sources: [] };
    try {
        return await withSnapshotDeadline(boundedQuery, async (signal) => {
            const activeQuery = { ...boundedQuery, signal };
            const snapshot = await readLocalSnapshot(baseDir, { ...activeQuery, maxRecords: limits.maxRecords,
                maxFileBytes: 8 * 1024 * 1024, maxTotalBytes: 40 * 1024 * 1024 }, true);
            const out = emptyRelatedSource(sourceId, 'complete');
            out.identityComplete = true;
            const ids = new Set(genes.map((gene) => gene.assetId));
            const logicalIds = new Set(genes.flatMap((gene) => gene.logicalId && gene.logicalId !== 'ad-hoc' ? [gene.logicalId] : []));
            // Share the Gene-only authority check: no earlier duplicate may hide a
            // content or execution-eligibility conflict, even after result caps fill.
            const checked = await checkedSnapshotAssets([...snapshot.genes, ...snapshot.capsules], snapshot.referenceScope, activeQuery);
            // An asset-ID-only request can discover its logical ID only in this source.
            // Finish discovery before filtering so earlier versions remain ambiguity evidence.
            const implicitIds = new Set(genes.filter(gene => !gene.logicalId).map(gene => gene.assetId));
            if (implicitIds.size > 0) {
                let inspected = 0;
                for (const { asset } of checked) {
                    if (relatedQueryAborted(activeQuery))
                        throw new Error('snapshot_aborted');
                    if (++inspected % 32 === 0)
                        await new Promise((resolve) => setImmediate(resolve));
                    if (asset.type === 'Gene' && implicitIds.has(asset.asset_id) && typeof asset['id'] === 'string'
                        && asset['id'] && asset['id'] !== 'ad-hoc')
                        logicalIds.add(asset['id']);
                }
            }
            out.scanned = snapshot.scanned;
            let selected = 0;
            for (const { asset, executionEligible } of checked) {
                if (relatedQueryAborted(activeQuery))
                    throw new Error('snapshot_aborted');
                if (++selected % 32 === 0)
                    await new Promise((resolve) => setImmediate(resolve));
                if (asset.type === 'Gene' && (ids.has(asset.asset_id) || logicalIds.has(String(asset['id'])))) {
                    if (out.genes.length < 256)
                        out.genes.push(asset);
                    else {
                        out.identityComplete = false;
                        out.status = 'truncated';
                    }
                }
                if (asset.type === 'Capsule' && typeof asset['gene'] === 'string' && asset['gene'] !== 'ad-hoc'
                    && (ids.has(asset['gene']) || logicalIds.has(asset['gene'])) && executionEligible) {
                    if (out.capsules.length < limits.maxCapsules)
                        out.capsules.push(asset);
                    else
                        out.status = 'truncated';
                }
            }
            if (relatedQueryAborted(activeQuery))
                throw new Error('snapshot_aborted');
            out.provenance = snapshot.provenance;
            out.review = snapshot.review;
            return { sources: [out] };
        });
    }
    catch (error) {
        const message = error instanceof Error ? error.message : '';
        const status = message === 'snapshot_aborted' || relatedQueryAborted(boundedQuery) ? 'aborted'
            : message === 'snapshot_record_limit' ? 'truncated' : 'unavailable';
        const source = emptyRelatedSource(sourceId, status);
        if (status === 'truncated')
            source.scanned = limits.maxRecords;
        return { sources: [source] };
    }
}