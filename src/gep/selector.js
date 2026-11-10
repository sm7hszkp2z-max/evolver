function matchPatternToSignals(pattern, signals) {
  if (!pattern || !signals || signals.length === 0) return false;
  const p = String(pattern);
  const sig = signals.map(s => String(s));

  // Regex pattern: /body/flags
  const regexLike = p.length >= 2 && p.startsWith('/') && p.lastIndexOf('/') > 0;
  if (regexLike) {
    const lastSlash = p.lastIndexOf('/');
    const body = p.slice(1, lastSlash);
    const flags = p.slice(lastSlash + 1);
    try {
      const re = new RegExp(body, flags || 'i');
      return sig.some(s => re.test(s));
    } catch (e) {
      // fallback to substring
    }
  }

  // Multi-language alias: "en_term|zh_term|ja_term" -- any branch matching = hit
  if (p.includes('|') && !p.startsWith('/')) {
    const branches = p.split('|').map(b => b.trim().toLowerCase()).filter(Boolean);
    return branches.some(needle => sig.some(s => s.toLowerCase().includes(needle)));
  }

  const needle = p.toLowerCase();
  return sig.some(s => s.toLowerCase().includes(needle));
}

function scoreGene(gene, signals) {
  if (!gene || gene.type !== 'Gene') return 0;
  const patterns = Array.isArray(gene.signals_match) ? gene.signals_match : [];
  if (patterns.length === 0) return 0;
  let score = 0;
  for (const pat of patterns) {
    if (matchPatternToSignals(pat, signals)) score += 1;
  }
  return score;
}

// Population-size-dependent drift intensity.
// In population genetics, genetic drift is stronger in small populations (Ne).
// driftIntensity: 0 = pure selection, 1 = pure drift (random).
// Formula: intensity = 1 / sqrt(Ne) where Ne = effective population size.
// This replaces the binary driftEnabled flag with a continuous spectrum.
function computeDriftIntensity(opts) {
  // If explicitly enabled/disabled, use that as the baseline
  var driftEnabled = !!(opts && opts.driftEnabled);

  // Effective population size: active gene count in the pool
  var effectivePopulationSize = opts && Number.isFinite(Number(opts.effectivePopulationSize))
    ? Number(opts.effectivePopulationSize)
    : null;

  // If no Ne provided, fall back to gene pool size
  var genePoolSize = opts && Number.isFinite(Number(opts.genePoolSize))
    ? Number(opts.genePoolSize)
    : null;

  var ne = effectivePopulationSize || genePoolSize || null;

  if (driftEnabled) {
    // Explicit drift: use moderate-to-high intensity
    return ne && ne > 1 ? Math.min(1, 1 / Math.sqrt(ne) + 0.3) : 0.7;
  }

  if (ne != null && ne > 0) {
    // Population-dependent drift: small population = more drift
    // Ne=1: intensity=1.0 (pure drift), Ne=25: intensity=0.2, Ne=100: intensity=0.1
    return Math.min(1, 1 / Math.sqrt(ne));
  }

  return 0; // No drift info available, pure selection
}

function selectGene(genes, signals, opts) {
  const genesList = Array.isArray(genes) ? genes : [];
  const bannedGeneIds = opts && opts.bannedGeneIds ? opts.bannedGeneIds : new Set();
  const driftEnabled = !!(opts && opts.driftEnabled);
  const preferredGeneId = opts && typeof opts.preferredGeneId === 'string' ? opts.preferredGeneId : null;
  const history = opts && Array.isArray(opts.history) ? opts.history : [];
  const repeatThreshold = opts && Number(opts.repeatThreshold) > 0 ? Number(opts.repeatThreshold) : REPEAT_THRESHOLD;

  // Compute continuous drift intensity based on effective population size
  var driftIntensity = computeDriftIntensity({
    driftEnabled: driftEnabled,
    effectivePopulationSize: opts && opts.effectivePopulationSize,
    genePoolSize: genesList.length,
  });
  var useDrift = driftEnabled || driftIntensity > 0.15;

  var DISTILLED_PREFIX = 'gene_distilled_';
  var DISTILLED_SCORE_FACTOR = 0.8;

  const scored = genesList
    .map(g => {
      var s = scoreGene(g, signals);
      if (s > 0 && g.id && String(g.id).startsWith(DISTILLED_PREFIX)) s *= DISTILLED_SCORE_FACTOR;
      return { gene: g, score: s };
    })
    .filter(x => x.score > 0)
    .sort((a, b) => b.score - a.score);

  if (scored.length === 0) return { selected: null, alternatives: [], driftIntensity: driftIntensity };

  // --- Repetition gate ---------------------------------------------------------
  // Demote candidates that already ran in >= threshold recent cycles with the SAME
  // intent and overlapping signals. The gate only bites while at least one
  // non-repeating candidate exists, so an all-repeating pool never empties.
  const repeatCounts = computeRepeatCounts(history, signals, {
    windowSize: REPEAT_WINDOW,
    overlapMin: REPEAT_OVERLAP_MIN,
  });
  const repeatSuppressed = applyRepetitionGate({
    candidates: scored,
    counts: repeatCounts,
    threshold: repeatThreshold,
  });
  const nonRepeating = scored.filter(x => x.gene && !repeatSuppressed.has(x.gene.id));
  const gateActive = repeatSuppressed.size > 0 && nonRepeating.length > 0;
  const repeatInfo = {
    active: gateActive,
    suppressed: Array.from(repeatSuppressed.values()),
  };

  // Memory graph preference: only override when the preferred gene is already a match candidate.
  if (preferredGeneId) {
    const preferred = scored.find(x => x.gene && x.gene.id === preferredGeneId);
    // A suppressed (repeating) preferred gene must NOT bypass the repetition gate.
    const preferredSuppressed = repeatSuppressed.has(preferredGeneId);
    if (preferred && !(gateActive && preferredSuppressed) && (useDrift || !bannedGeneIds.has(preferredGeneId))) {
      const rest = scored.filter(x => x.gene && x.gene.id !== preferredGeneId);
      const filteredRest = useDrift ? rest : rest.filter(x => x.gene && !bannedGeneIds.has(x.gene.id));
      return {
        selected: preferred.gene,
        alternatives: filteredRest.slice(0, 4).map(x => x.gene),
        driftIntensity: driftIntensity,
        repeatSuppression: repeatInfo,
      };
    }
  }

  // Low-efficiency suppression: do not repeat low-confidence paths unless drift is active.
  const filtered = useDrift ? scored : scored.filter(x => x.gene && !bannedGeneIds.has(x.gene.id));
  if (filtered.length === 0) return { selected: null, alternatives: scored.slice(0, 4).map(x => x.gene), driftIntensity: driftIntensity };

  // Apply the repetition gate to the candidate pool. If every remaining candidate
  // repeats, keep the current behaviour (no empty selection).
  const gatedPool = gateActive ? filtered.filter(x => x.gene && !repeatSuppressed.has(x.gene.id)) : filtered;
  const pool = gatedPool.length > 0 ? gatedPool : filtered;

  // Stochastic selection under drift: with probability proportional to driftIntensity,
  // pick a random gene from the top candidates instead of always picking the best.
  var selectedIdx = 0;
  if (driftIntensity > 0 && pool.length > 1 && Math.random() < driftIntensity) {
    // Weighted random selection from top candidates (favor higher-scoring but allow lower)
    var topN = Math.min(pool.length, Math.max(2, Math.ceil(pool.length * driftIntensity)));
    selectedIdx = Math.floor(Math.random() * topN);
  }

  return {
    selected: pool[selectedIdx].gene,
    alternatives: pool.filter(function(_, i) { return i !== selectedIdx; }).slice(0, 4).map(x => x.gene),
    driftIntensity: driftIntensity,
    repeatSuppression: repeatInfo,
  };
}

function selectCapsule(capsules, signals) {
  const scored = (capsules || [])
    .map(c => {
      const triggers = Array.isArray(c.trigger) ? c.trigger : [];
      const score = triggers.reduce((acc, t) => (matchPatternToSignals(t, signals) ? acc + 1 : acc), 0);
      return { capsule: c, score };
    })
    .filter(x => x.score > 0)
    .sort((a, b) => b.score - a.score);
  return scored.length ? scored[0].capsule : null;
}

function computeSignalOverlap(signalsA, signalsB) {
  if (!Array.isArray(signalsA) || !Array.isArray(signalsB)) return 0;
  if (signalsA.length === 0 || signalsB.length === 0) return 0;
  var setB = new Set(signalsB.map(function (s) { return String(s).toLowerCase(); }));
  var hits = 0;
  for (var i = 0; i < signalsA.length; i++) {
    if (setB.has(String(signalsA[i]).toLowerCase())) hits++;
  }
  return hits / Math.max(signalsA.length, 1);
}

// --- Repetition gate ---------------------------------------------------------
// The GEP prompt forbids repeating the same intent+signal+gene across cycles,
// but that rule only existed as prompt text injected AFTER the selector had
// already committed to a gene. This gate enforces it in code: a candidate gene
// that already ran in >= REPEAT_THRESHOLD recent cycles with the SAME intent and
// overlapping signals is demoted, as long as a non-repeating candidate exists.
var REPEAT_THRESHOLD = 3;      // N: same gene + same intent + overlapping signals
var REPEAT_WINDOW = 10;        // how many recent cycles are scanned
var REPEAT_OVERLAP_MIN = 0.6;  // minimum signal overlap between current + past cycle

// Counts, per gene, how many recent cycles used it with each intent.
// Returns Map<gene_id, { gene_id, by_intent: { intent: count }, total }>.
function computeRepeatCounts(history, signals, opts) {
  const options = opts || {};
  const windowSize = Number(options.windowSize) > 0 ? Number(options.windowSize) : REPEAT_WINDOW;
  const overlapMin = Number.isFinite(Number(options.overlapMin)) ? Number(options.overlapMin) : REPEAT_OVERLAP_MIN;
  const events = (Array.isArray(history) ? history : []).slice(-windowSize);
  const counts = new Map();
  for (const ev of events) {
    if (!ev || typeof ev !== 'object') continue;
    const genes = Array.isArray(ev.genes_used) ? ev.genes_used : [];
    if (genes.length === 0) continue;
    const intent = ev.intent ? String(ev.intent) : null;
    if (!intent) continue;
    const evSignals = Array.isArray(ev.signals) ? ev.signals : [];
    // Only count the past cycle when the current signal profile is largely covered by it.
    if (computeSignalOverlap(signals, evSignals) < overlapMin) continue;
    for (const g of genes) {
      const gid = g ? String(g) : '';
      if (!gid) continue;
      let rec = counts.get(gid);
      if (!rec) { rec = { gene_id: gid, by_intent: {} }; counts.set(gid, rec); }
      rec.by_intent[intent] = (rec.by_intent[intent] || 0) + 1;
      rec.total = (rec.total || 0) + 1;
    }
  }
  return counts;
}

// Returns Map<gene_id, { gene_id, count, intent }> for every candidate that repeats
// too often with the same intent. Candidates that are absent stay eligible.
function applyRepetitionGate({ candidates, counts, threshold }) {
  const suppressed = new Map();
  if (!counts || typeof counts.get !== 'function') return suppressed;
  const limit = Number(threshold) > 0 ? Number(threshold) : REPEAT_THRESHOLD;
  for (const c of Array.isArray(candidates) ? candidates : []) {
    const gene = c && c.gene ? c.gene : null;
    const gid = gene && gene.id ? String(gene.id) : null;
    if (!gid) continue;
    const rec = counts.get(gid);
    if (!rec || !rec.by_intent) continue;
    let best = null;
    for (const key of Object.keys(rec.by_intent)) {
      const n = rec.by_intent[key];
      if (!best || n > best.count) best = { gene_id: gid, count: n, intent: key };
    }
    if (best && best.count >= limit) suppressed.set(gid, best);
  }
  return suppressed;
}

var FAILED_CAPSULE_BAN_THRESHOLD = 2;
var FAILED_CAPSULE_OVERLAP_MIN = 0.6;

function banGenesFromFailedCapsules(failedCapsules, signals, existingBans) {
  var bans = existingBans instanceof Set ? new Set(existingBans) : new Set();
  if (!Array.isArray(failedCapsules) || failedCapsules.length === 0) return bans;
  var geneFailCounts = {};
  for (var i = 0; i < failedCapsules.length; i++) {
    var fc = failedCapsules[i];
    if (!fc || !fc.gene) continue;
    var overlap = computeSignalOverlap(signals, fc.trigger || []);
    if (overlap < FAILED_CAPSULE_OVERLAP_MIN) continue;
    var gid = String(fc.gene);
    geneFailCounts[gid] = (geneFailCounts[gid] || 0) + 1;
  }
  var keys = Object.keys(geneFailCounts);
  for (var j = 0; j < keys.length; j++) {
    if (geneFailCounts[keys[j]] >= FAILED_CAPSULE_BAN_THRESHOLD) {
      bans.add(keys[j]);
    }
  }
  return bans;
}

function selectGeneAndCapsule({ genes, capsules, signals, memoryAdvice, driftEnabled, failedCapsules, history }) {
  const bannedGeneIds =
    memoryAdvice && memoryAdvice.bannedGeneIds instanceof Set ? memoryAdvice.bannedGeneIds : new Set();
  const preferredGeneId = memoryAdvice && memoryAdvice.preferredGeneId ? memoryAdvice.preferredGeneId : null;

  var effectiveBans = banGenesFromFailedCapsules(
    Array.isArray(failedCapsules) ? failedCapsules : [],
    signals,
    bannedGeneIds
  );

  const { selected, alternatives, driftIntensity, repeatSuppression } = selectGene(genes, signals, {
    bannedGeneIds: effectiveBans,
    preferredGeneId,
    driftEnabled: !!driftEnabled,
    history: Array.isArray(history) ? history : [],
  });
  const capsule = selectCapsule(capsules, signals);
  const selector = buildSelectorDecision({
    gene: selected,
    capsule,
    signals,
    alternatives,
    memoryAdvice,
    driftEnabled,
    driftIntensity,
    repeatSuppression,
  });
  return {
    selectedGene: selected,
    capsuleCandidates: capsule ? [capsule] : [],
    selector,
    driftIntensity,
  };
}

function buildSelectorDecision({ gene, capsule, signals, alternatives, memoryAdvice, driftEnabled, driftIntensity, repeatSuppression }) {
  const reason = [];
  if (gene) reason.push('signals match gene.signals_match');
  if (capsule) reason.push('capsule trigger matches signals');
  if (!gene) reason.push('no matching gene found; new gene may be required');
  if (signals && signals.length) reason.push(`signals: ${signals.join(', ')}`);

  if (memoryAdvice && Array.isArray(memoryAdvice.explanation) && memoryAdvice.explanation.length) {
    reason.push(`memory_graph: ${memoryAdvice.explanation.join(' | ')}`);
  }
  if (driftEnabled) {
    reason.push('random_drift_override: true');
  }
  if (Number.isFinite(driftIntensity) && driftIntensity > 0) {
    reason.push(`drift_intensity: ${driftIntensity.toFixed(3)}`);
  }

  // Repetition gate: record exactly which gene was suppressed and why.
  if (repeatSuppression && Array.isArray(repeatSuppression.suppressed) && repeatSuppression.suppressed.length > 0) {
    for (const s of repeatSuppression.suppressed) {
      reason.push('repeat_suppression: ' + s.gene_id + ' (' + s.count + ' recent cycles, intent=' + s.intent + ')');
    }
    const repairRepeat = repeatSuppression.suppressed.find(s => s.intent === 'repair');
    if (repairRepeat) {
      reason.push('intent_switch_recommended: repair->innovate (' + repairRepeat.count + ' recent repair cycles with ' + repairRepeat.gene_id + ')');
    }
  }

  return {
    selected: gene ? gene.id : null,
    reason,
    alternatives: Array.isArray(alternatives) ? alternatives.map(g => g.id) : [],
  };
}

module.exports = {
  selectGeneAndCapsule,
  selectGene,
  selectCapsule,
  buildSelectorDecision,
  matchPatternToSignals,
  computeRepeatCounts,
  applyRepetitionGate,
  computeSignalOverlap,
  REPEAT_THRESHOLD,
  REPEAT_WINDOW,
  REPEAT_OVERLAP_MIN,
};

