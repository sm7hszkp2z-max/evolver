const { computeAssetId, SCHEMA_VERSION } = require('./contentHash');

/**
 * Format asset preview for prompt inclusion.
 * Handles stringified JSON, arrays, and error cases gracefully.
 */
function formatAssetPreview(preview) {
  if (!preview) return '(none)';
  if (typeof preview === 'string') {
      try {
          const parsed = JSON.parse(preview);
          if (Array.isArray(parsed) && parsed.length > 0) {
              return JSON.stringify(parsed, null, 2);
          }
          return preview; // Keep as string if not array or empty
      } catch (e) {
          return preview; // Keep as string if parse fails
      }
  }
  return JSON.stringify(preview, null, 2);
}

/**
 * Validate and normalize an asset object.
 * Ensures schema version and ID are present.
 */
function normalizeAsset(asset) {
  if (!asset || typeof asset !== 'object') return asset;
  if (!asset.schema_version) asset.schema_version = SCHEMA_VERSION;
  if (!asset.asset_id) {
    try { asset.asset_id = computeAssetId(asset); } catch (e) {}
  }
  return asset;
}

/**
 * Prompt-projection whitelist for Capsule assets.
 *
 * The stored capsule (assets/gep/capsules.json) is the audit trail and keeps
 * everything: diff, content, success_reason, env_fingerprint, ...
 * The GEP planning prompt does NOT need those: the Hand re-plans the change
 * every cycle and never reads the previous cycle's raw diff.
 *
 * Keeping the field list explicit here makes the projection auditable in one
 * place. The whitelist below is the ONLY thing the prompt preview exposes.
 */
const CAPSULE_PROMPT_FIELDS = [
    'id',
    'type',
    'schema_version',
    'gene',
    'trigger',
    'summary',
    'confidence',
    'blast_radius',
    'outcome',
    'success_streak',
    'source_type',
    'reused_asset_id',
];

/**
 * Prompt-projection whitelist for Gene assets.
 *
 * Drops machine-side bookkeeping the Hand never plans with:
 *   asset_id         - content hash, used for dedup by the asset store
 *   epigenetic_marks - selection boost history, consumed by the Selector
 *
 * The stored gene (assets/gep/genes.json) keeps both fields.
 */
const GENE_PROMPT_FIELDS = [
    'id',
    'type',
    'schema_version',
    'category',
    'signals_match',
    'preconditions',
    'strategy',
    'constraints',
    'validation',
];

/**
 * Project an asset down to an explicit whitelist of fields.
 * Fields absent on the source asset are simply skipped.
 */
function projectAssetForPrompt(asset, fields) {
    if (!asset || typeof asset !== 'object' || Array.isArray(asset)) return asset;
    const out = {};
    const list = Array.isArray(fields) ? fields : [];
    for (let i = 0; i < list.length; i++) {
        const key = list[i];
        if (Object.prototype.hasOwnProperty.call(asset, key)) out[key] = asset[key];
    }
    return out;
}

/** Project a capsule for prompt inclusion (whitelist: CAPSULE_PROMPT_FIELDS). */
function projectCapsuleForPrompt(capsule) {
    return projectAssetForPrompt(capsule, CAPSULE_PROMPT_FIELDS);
}

/** Project a gene for prompt inclusion (whitelist: GENE_PROMPT_FIELDS). */
function projectGeneForPrompt(gene) {
    return projectAssetForPrompt(gene, GENE_PROMPT_FIELDS);
}

/** Project a list of assets with the given projector. */
function projectAssetsForPrompt(list, projector) {
    if (!Array.isArray(list)) return [];
    const fn = typeof projector === 'function' ? projector : function (x) { return x; };
    return list.map(function (item) { return fn(item); });
}

module.exports = {
    formatAssetPreview,
    normalizeAsset,
    CAPSULE_PROMPT_FIELDS,
    GENE_PROMPT_FIELDS,
    projectAssetForPrompt,
    projectCapsuleForPrompt,
    projectGeneForPrompt,
    projectAssetsForPrompt,
};
