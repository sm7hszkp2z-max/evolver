'use strict';
// protocol-drift-monitor -- detect protocol drift in the GEP asset stores.
//
// The GEP protocol (src/gep/prompt.js) defines five mandatory evolution
// objects (Mutation, PersonalityState, EvolutionEvent, Gene, Capsule). Nothing
// checks that the objects persisted in assets/gep/ still match that contract:
// a payload that drifts (missing field, wrong type, incompatible
// schema_version) is written, hashed, and re-read by the prompt assembler as
// if it were still valid.
//
// Local adaptation of the Hub asset
// sha256:b6154ce3ae23469879589a75c8115c57ef6104d527b7b34baa43d1e7bf6bb2d4
// (Ajv + MQTT.js + better-sqlite3): same five components and public names,
// each external dependency replaced locally -- Ajv -> the built-in validator,
// MQTT -> the repo's own protocol surface (assets/gep/*), better-sqlite3 ->
// an append-only JSONL recorder with 14-day retention, Prometheus -> a plain
// text exposition function, kubectl repair -> a guarded, read-mostly,
// dry-run-by-default repair. Node built-ins only; no network, no deps.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// The skill may be copied out of the repo; resolve repo modules defensively
// so an isolated copy still loads (reconcile then reports "unavailable").
function detectRepoRoot() {
  const cands = [process.env.EVOLVER_REPO_ROOT, path.resolve(__dirname, '..', '..'), process.cwd()];
  for (const c of cands) {
    if (!c) continue;
    try {
      if (fs.existsSync(path.join(c, 'src', 'gep', 'assetStore.js'))) return c;
    } catch (e) { /* ignore */ }
  }
  return path.resolve(__dirname, '..', '..');
}

const REPO_ROOT = detectRepoRoot();
function requireRepo(rel) { return require(path.join(REPO_ROOT, rel)); }

let repoPaths = null;
let repoContentHash = null;
let repoAssetStore = null;
try { repoPaths = requireRepo('src/gep/paths'); } catch (e) { /* isolated copy */ }
try { repoContentHash = requireRepo('src/gep/contentHash'); } catch (e) { /* isolated */ }
try { repoAssetStore = requireRepo('src/gep/assetStore'); } catch (e) { /* isolated */ }

const SCHEMA_VERSION = (repoContentHash && repoContentHash.SCHEMA_VERSION) || '1.6.0';
const DRIFT_ALERT_THRESHOLD = 0.08; // the Hub asset used the same threshold.
const ASSET_FILES = ['genes.json', 'capsules.json', 'events.jsonl'];

// Baseline schema of the five mandatory GEP evolution objects.
// Compact DSL, one space-separated token per field:
//   name:type        s=string n=number n01=number in [0,1] sa=string array
//   name:type?       nullable (required but may be null)
//   name:type~       schema_version field (major must match the baseline)
//   name:type!a|b|c  enum of allowed values
//   name:{f:t ...}  nested object with its own field list
const PERSONALITY = 'type:s!PersonalityState rigor:n01 creativity:n01 verbosity:n01 ' +
  'risk_tolerance:n01 obedience:n01';
const GEP_OBJECT_SCHEMA = {
  Mutation: 'type:s!Mutation id:s category:s!repair|optimize|innovate trigger_signals:sa ' +
    'target:s expected_effect:s risk_level:s!low|medium|high',
  PersonalityState: PERSONALITY,
  EvolutionEvent: 'type:s!EvolutionEvent schema_version:s~ id:s parent:s? ' +
    'intent:s!repair|optimize|innovate signals:sa genes_used:sa mutation_id:s? ' +
    'personality_state:{' + PERSONALITY + '} blast_radius:{files:n lines:n} ' +
    'outcome:{status:s!success|failed score:n01}',
  Gene: 'type:s!Gene schema_version:s~ id:s category:s!repair|optimize|innovate ' +
    'signals_match:sa preconditions:sa strategy:sa ' +
    'constraints:{max_files:n forbidden_paths:sa} validation:sa',
  Capsule: 'type:s!Capsule schema_version:s~ id:s trigger:sa gene:s? summary:s ' +
    'confidence:n01 blast_radius:{files:n lines:n}'
};

// Tiny dependency-free validator (Ajv replacement).
const RE_VERSION = /^\d+\.\d+\.\d+$/;

function typeOk(v, code) {
  switch (code) {
    case 's': return typeof v === 'string';
    case 'n': return typeof v === 'number' && Number.isFinite(v);
    case 'n01': return typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 1;
    case 'o': return !!v && typeof v === 'object' && !Array.isArray(v);
    case 'sa': return Array.isArray(v) && v.every(function (x) { return typeof x === 'string'; });
    default: return true;
  }
}

// Parse the compact DSL into {field, type, nullable, version, enum, nested}.
function parseReq(req) {
  const out = [];
  const tokens = [];
  let token = ""; let depth = 0;
  for (const ch of String(req || "")) {
    if (ch === "{") depth += 1;
    if (ch === "}") depth -= 1;
    if (/\s/.test(ch) && depth === 0) { if (token) tokens.push(token); token = ""; }
    else token += ch;
  }
  if (token) tokens.push(token);
  for (const token of tokens) {
    const i = token.indexOf(":");
    if (i === -1) continue;
    const e = { field: token.slice(0, i), type: "", nullable: false, version: false, enum: null, nested: null };
    let rest = token.slice(i + 1);
    if (rest.charAt(0) === "{") { e.type = "o"; e.nested = parseReq(rest.slice(1, -1)); }
    else {
      const kind = ["n01", "sa", "s", "n", "o"].find(k => rest.startsWith(k));
      e.type = kind || rest.charAt(0); rest = rest.slice(e.type.length);
      if (rest.charAt(0) === "?") { e.nullable = true; rest = rest.slice(1); }
      if (rest.charAt(0) === "~") { e.version = true; rest = rest.slice(1); }
      if (rest.charAt(0) === "!") e.enum = rest.slice(1).split("|");
    }
    out.push(e);
  }
  return out;
}

const PARSED_SCHEMA = {};
for (const t of Object.keys(GEP_OBJECT_SCHEMA)) PARSED_SCHEMA[t] = parseReq(GEP_OBJECT_SCHEMA[t]);

function validateFields(obj, fields, prefix, out, baseline) {
  for (const e of fields) {
    const value = obj[e.field];
    const p = prefix ? prefix + '.' + e.field : e.field;
    if (value === undefined || value === null) {
      if (e.nullable) continue;
      out.push({ field: p, code: e.field === 'schema_version' ? 'missing_schema_version' : 'missing_field',
        message: 'missing required field "' + e.field + '"' });
      continue;
    }
    if (e.version) {
      if (typeof value !== 'string' || !RE_VERSION.test(value)) {
        out.push({ field: p, code: 'bad_schema_version', message: 'schema_version must be major.minor.patch' });
      } else {
        const major = parseInt(value.split('.')[0], 10);
        const baseMajor = parseInt(baseline.split('.')[0], 10);
        if (Number.isFinite(major) && Number.isFinite(baseMajor) && major !== baseMajor) {
          out.push({ field: p, code: 'schema_version_major_mismatch',
            message: 'schema_version ' + value + ' is incompatible with baseline ' + baseline });
        }
      }
      continue;
    }
    if (e.type !== 'o' && !typeOk(value, e.type)) {
      const got = value === null ? 'null' : (Array.isArray(value) ? 'array' : typeof value);
      out.push({ field: p, code: 'wrong_type', message: 'expected ' + e.type + ', got ' + got });
      continue;
    }
    if (e.enum && e.enum.indexOf(value) === -1) {
      out.push({ field: p, code: 'bad_enum', message: 'expected one of ' + e.enum.join('|') });
    }
    if (e.nested) validateFields(value, e.nested, p, out, baseline);
  }
}

/**
 * Validate one GEP protocol payload against the baseline schema.
 * @param {object} payload              a Gene / Capsule / EvolutionEvent record
 * @param {{ baselineVersion?: string }} [options]
 * @returns {{type: string|null, valid: boolean, skipped: boolean, violations: Array}}
 */
function validatePayload(payload, options) {
  const opts = options || {};
  const baseline = String(opts.baselineVersion || SCHEMA_VERSION);
  const out = { type: null, valid: true, skipped: false, violations: [] };
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    out.valid = false;
    out.violations.push({ field: '$', code: 'not_an_object', message: 'payload is not a JSON object' });
    return out;
  }
  const type = typeof payload.type === 'string' ? payload.type : null;
  out.type = type;
  const fields = type ? PARSED_SCHEMA[type] : null;
  if (!fields) {
    // Not one of the five mandatory objects (e.g. a ValidationReport row):
    // out of scope for the drift baseline, so skip instead of reporting drift.
    out.skipped = true;
    return out;
  }
  validateFields(payload, fields, '', out.violations, baseline);
  if (out.violations.length > 0) out.valid = false;
  return out;
}

class ProtocolDriftMonitor {
  constructor(options = {}) {
    this.windowMs = options.windowMs || 60000;
    this.maxSamples = options.maxSamples || 200;
    this.baselineVersion = options.baselineVersion || SCHEMA_VERSION;
    this.samples = [];
    this.fieldViolations = new Map();
  }
  record(payload, now = Date.now()) {
    const result = validatePayload(payload, { baselineVersion: this.baselineVersion });
    if (result.skipped) return result;
    this.samples.push({ at: now, mismatch: !result.valid });
    this.samples = this.samples.filter(s => now - s.at <= this.windowMs).slice(-this.maxSamples);
    for (const v of result.violations) {
      const key = `${v.field}:${v.code}`;
      this.fieldViolations.set(key, (this.fieldViolations.get(key) || 0) + 1);
    }
    return result;
  }
  getDriftScore(now = Date.now()) {
    this.samples = this.samples.filter(s => now - s.at <= this.windowMs).slice(-this.maxSamples);
    return this.samples.length ? this.samples.filter(s => s.mismatch).length / this.samples.length : 0;
  }
}

class SchemaRegistrySnapshot {
  constructor(options = {}) {
    this.assetsDir = options.assetsDir || (repoPaths ? repoPaths.getGepAssetsDir() : path.join(REPO_ROOT, 'assets', 'gep'));
    this.files = options.files || ASSET_FILES;
    this.digests = {};
    this.watcher = null;
    this.reload();
  }
  reload() {
    const next = {};
    for (const file of this.files) {
      const full = path.join(this.assetsDir, file);
      next[file] = fs.existsSync(full) ? crypto.createHash('md5').update(fs.readFileSync(full)).digest('hex') : null;
    }
    const changed = this.files.filter(file => this.digests[file] !== undefined && this.digests[file] !== next[file]);
    this.digests = next;
    return changed;
  }
  watch(onChange) {
    if (this.watcher) return this.watcher;
    this.watcher = fs.watch(this.assetsDir, (_event, filename) => {
      if (!filename || !this.files.includes(String(filename))) return;
      const changed = this.reload();
      if (changed.length && onChange) onChange(changed, { ...this.digests });
    });
    return this.watcher;
  }
  close() { if (this.watcher) this.watcher.close(); this.watcher = null; }
}

class DriftScoreRecorder {
  constructor(options = {}) {
    const assetsDir = repoPaths ? repoPaths.getGepAssetsDir() : path.join(REPO_ROOT, 'assets', 'gep');
    this.file = options.file || path.join(assetsDir, 'drift_scores.jsonl');
    this.retentionMs = options.retentionMs || 14 * 24 * 60 * 60 * 1000;
  }
  record(row, now = Date.now()) {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const value = { window_start: row.window_start || new Date(now).toISOString(), mismatch_ratio: Number(row.mismatch_ratio), schema_version: row.schema_version || SCHEMA_VERSION };
    fs.appendFileSync(this.file, JSON.stringify(value) + '\n');
    this.prune(now);
    return value;
  }
  prune(now = Date.now()) {
    if (!fs.existsSync(this.file)) return 0;
    const rows = fs.readFileSync(this.file, 'utf8').split('\n').filter(Boolean).map(line => { try { return JSON.parse(line); } catch (_) { return null; } }).filter(Boolean);
    const kept = rows.filter(row => { const t = Date.parse(row.window_start); return Number.isFinite(t) && now - t <= this.retentionMs; });
    if (kept.length !== rows.length) {
      const temp = `${this.file}.tmp`;
      fs.writeFileSync(temp, kept.map(row => JSON.stringify(row)).join('\n') + (kept.length ? '\n' : ''));
      fs.renameSync(temp, this.file);
    }
    return rows.length - kept.length;
  }
}

function collectDriftMetrics(monitor, options = {}) {
  const score = monitor.getDriftScore(options.now || Date.now());
  const threshold = options.threshold === undefined ? 0.08 : Number(options.threshold);
  return [
    '# HELP protocol_drift_score Ratio of invalid GEP protocol payloads in the current window.',
    '# TYPE protocol_drift_score gauge',
    `protocol_drift_score ${score}`,
    '# HELP protocol_drift_alert Whether protocol drift exceeds the configured threshold.',
    '# TYPE protocol_drift_alert gauge',
    `protocol_drift_alert ${score > threshold ? 1 : 0}`
  ].join('\n') + '\n';
}

function reconcileProtocolDrift(options = {}) {
  const dryRun = options.dryRun !== false;
  if (!repoAssetStore) return { dryRun, missing: [], repaired: [], unavailable: true };
  const candidates = [...repoAssetStore.loadGenes(), ...repoAssetStore.loadCapsules()];
  const missing = candidates.filter(obj => obj && (obj.type === 'Gene' || obj.type === 'Capsule') && !obj.schema_version);
  const repaired = [];
  if (!dryRun) {
    for (const original of missing) {
      const copy = { ...original };
      repoAssetStore.ensureSchemaFields(copy);
      if (copy.type === 'Gene') repoAssetStore.upsertGene(copy);
      else repoAssetStore.upsertCapsule(copy);
      repaired.push(copy.id);
    }
  }
  return { dryRun, missing: missing.map(obj => ({ type: obj.type, id: obj.id })), repaired };
}

module.exports = { ProtocolDriftMonitor, SchemaRegistrySnapshot, DriftScoreRecorder, collectDriftMetrics, reconcileProtocolDrift };
