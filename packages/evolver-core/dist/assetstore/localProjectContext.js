import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { readUtf8Regular, replaceUtf8Durable } from './assetStoreStorage.js';
const MAX_CONTEXT_BYTES = 64 * 1024 * 1024;
const CONTEXT_SCHEMA = 'evolver.local-project-context.v1';
const ASSET_ID = /^sha256:[a-f0-9]{64}$/;
export function validateLocalProjectContext(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value))
        throw new Error('local_project_context_invalid');
    const row = value;
    if (Object.keys(row).some((key) => !['version', 'capsuleAssetId', 'geneAssetId', 'notes', 'projectFingerprint'].includes(key))
        || row['version'] !== 1 || typeof row['capsuleAssetId'] !== 'string' || !ASSET_ID.test(row['capsuleAssetId'])
        || typeof row['geneAssetId'] !== 'string' || !ASSET_ID.test(row['geneAssetId'])
        || !Array.isArray(row['notes']) || row['notes'].length === 0 || row['notes'].some((note) => typeof note !== 'string' || !note.trim())
        || (row['projectFingerprint'] !== undefined && (typeof row['projectFingerprint'] !== 'string' || !/^project:[a-f0-9]{32}$/.test(row['projectFingerprint'])))) {
        throw new Error('local_project_context_invalid');
    }
    return { version: 1, capsuleAssetId: row['capsuleAssetId'], geneAssetId: row['geneAssetId'], notes: [...row['notes']],
        ...(typeof row['projectFingerprint'] === 'string' ? { projectFingerprint: row['projectFingerprint'] } : {}) };
}
export function isBoundLocalContext(context, assets) {
    const capsule = assets.find((asset) => asset?.type === 'Capsule' && asset.asset_id === context.capsuleAssetId);
    const gene = assets.find((asset) => asset?.type === 'Gene' && asset.asset_id === context.geneAssetId);
    return Boolean(capsule && gene && capsule['gene'] === gene.asset_id);
}
export function assertLocalContextBundle(context, assets) {
    if (!isBoundLocalContext(context, assets))
        throw new Error('local_project_context_bundle_mismatch');
}
/** Caller holds the asset-store lock; these are local metadata, never wire assets. */
export function readLocalProjectContexts(baseDir) {
    const raw = readUtf8Regular(join(baseDir, '.local-project-context.json'), MAX_CONTEXT_BYTES);
    if (raw === null)
        return [];
    let value;
    try {
        value = JSON.parse(raw);
    }
    catch {
        throw new Error('local_project_context_corrupt');
    }
    if (!value || typeof value !== 'object' || Array.isArray(value))
        throw new Error('local_project_context_corrupt');
    const data = value;
    if (Object.keys(data).some((key) => !['schema', 'contexts'].includes(key))
        || data['schema'] !== CONTEXT_SCHEMA || !Array.isArray(data['contexts']))
        throw new Error('local_project_context_corrupt');
    return data['contexts'].map(validateLocalProjectContext);
}
export function mergeLocalProjectContexts(baseDir, incoming) {
    const rows = new Map();
    for (const context of [...readLocalProjectContexts(baseDir), ...incoming]) {
        const row = validateLocalProjectContext(context);
        rows.set(createHash('sha256').update(JSON.stringify(row)).digest('hex'), row);
    }
    const body = `${JSON.stringify({ schema: CONTEXT_SCHEMA, contexts: [...rows.values()] })}\n`;
    if (Buffer.byteLength(body) > MAX_CONTEXT_BYTES)
        throw new Error('local_project_context_store_full');
    return body;
}
export function writeLocalProjectContexts(baseDir, body) {
    replaceUtf8Durable(join(baseDir, '.local-project-context.json'), body);
}