const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { selectGene, selectCapsule, selectGeneAndCapsule } = require('../src/gep/selector');

const GENES = [
  {
    type: 'Gene',
    id: 'gene_repair',
    category: 'repair',
    signals_match: ['error', 'exception', 'failed'],
    strategy: ['fix it'],
    validation: ['node -e "true"'],
  },
  {
    type: 'Gene',
    id: 'gene_optimize',
    category: 'optimize',
    signals_match: ['protocol', 'prompt', 'audit'],
    strategy: ['optimize it'],
    validation: ['node -e "true"'],
  },
  {
    type: 'Gene',
    id: 'gene_innovate',
    category: 'innovate',
    signals_match: ['user_feature_request', 'user_improvement_suggestion', 'capability_gap', 'stable_success_plateau'],
    strategy: ['build it'],
    validation: ['node -e "true"'],
  },
];

const CAPSULES = [
  {
    type: 'Capsule',
    id: 'capsule_1',
    trigger: ['log_error', 'exception'],
    gene: 'gene_repair',
    summary: 'Fixed an error',
    confidence: 0.9,
  },
  {
    type: 'Capsule',
    id: 'capsule_2',
    trigger: ['protocol', 'gep'],
    gene: 'gene_optimize',
    summary: 'Optimized prompt',
    confidence: 0.85,
  },
];

describe('selectGene', () => {
  it('selects the gene with highest signal match', () => {
    const result = selectGene(GENES, ['error', 'exception', 'failed'], {});
    assert.equal(result.selected.id, 'gene_repair');
  });

  it('returns null when no signals match', () => {
    const result = selectGene(GENES, ['completely_unrelated_signal'], {});
    assert.equal(result.selected, null);
  });

  it('returns alternatives when multiple genes match', () => {
    const result = selectGene(GENES, ['error', 'protocol'], {});
    assert.ok(result.selected);
    assert.ok(Array.isArray(result.alternatives));
  });

  it('includes drift intensity in result', () => {
    // Drift intensity is population-size-dependent; verify it is returned.
    const result = selectGene(GENES, ['error', 'exception'], {});
    assert.ok('driftIntensity' in result);
    assert.equal(typeof result.driftIntensity, 'number');
    assert.ok(result.driftIntensity >= 0 && result.driftIntensity <= 1);
  });

  it('respects preferred gene id from memory graph', () => {
    const result = selectGene(GENES, ['error', 'protocol'], {
      preferredGeneId: 'gene_optimize',
    });
    // gene_optimize matches 'protocol' so it qualifies as a candidate
    // With preference, it should be selected even if gene_repair scores higher
    assert.equal(result.selected.id, 'gene_optimize');
  });

  it('matches gene via baseName:snippet signal (user_feature_request:snippet)', () => {
    const result = selectGene(GENES, ['user_feature_request:add a dark mode toggle to the settings'], {});
    assert.ok(result.selected);
    assert.equal(result.selected.id, 'gene_innovate', 'innovate gene has signals_match user_feature_request');
  });

  it('matches gene via baseName:snippet signal (user_improvement_suggestion:snippet)', () => {
    const result = selectGene(GENES, ['user_improvement_suggestion:refactor the payment module and simplify the API'], {});
    assert.ok(result.selected);
    assert.equal(result.selected.id, 'gene_innovate', 'innovate gene has signals_match user_improvement_suggestion');
  });
});

describe('selectCapsule', () => {
  it('selects capsule matching signals', () => {
    const result = selectCapsule(CAPSULES, ['log_error', 'exception']);
    assert.equal(result.id, 'capsule_1');
  });

  it('returns null when no triggers match', () => {
    const result = selectCapsule(CAPSULES, ['unrelated']);
    assert.equal(result, null);
  });
});

describe('selectGeneAndCapsule', () => {
  it('returns selected gene, capsule candidates, and selector decision', () => {
    const result = selectGeneAndCapsule({
      genes: GENES,
      capsules: CAPSULES,
      signals: ['error', 'log_error'],
      memoryAdvice: null,
      driftEnabled: false,
    });
    assert.ok(result.selectedGene);
    assert.ok(result.selector);
    assert.ok(result.selector.selected);
    assert.ok(Array.isArray(result.selector.reason));
  });
});


describe('repetition gate', () => {
  const REPEAT_HISTORY = [
    { type: 'EvolutionEvent', id: 'evt_r1', intent: 'repair', signals: ['error', 'protocol'], genes_used: ['gene_repair'], outcome: { status: 'success', score: 0.85 } },
    { type: 'EvolutionEvent', id: 'evt_r2', intent: 'repair', signals: ['error', 'protocol'], genes_used: ['gene_repair'], outcome: { status: 'success', score: 0.85 } },
    { type: 'EvolutionEvent', id: 'evt_r3', intent: 'repair', signals: ['error', 'protocol'], genes_used: ['gene_repair'], outcome: { status: 'success', score: 0.85 } },
  ];

  it('demotes a gene repeated 3 times with the same intent and picks a non-repeating alternative', () => {
    const result = selectGeneAndCapsule({
      genes: GENES,
      capsules: CAPSULES,
      signals: ['error', 'protocol'],
      memoryAdvice: {
        preferredGeneId: 'gene_repair',
        bannedGeneIds: new Set(),
        explanation: ['memory_prefer:gene_repair'],
      },
      driftEnabled: false,
      history: REPEAT_HISTORY,
    });
    assert.ok(result.selectedGene);
    assert.equal(result.selectedGene.id, 'gene_optimize', 'repeated gene must be demoted');
    const reasons = result.selector.reason.join(' | ');
    assert.ok(reasons.indexOf('repeat_suppression') >= 0, 'reason must mention the suppression: ' + reasons);
    assert.ok(reasons.indexOf('gene_repair') >= 0, 'reason must name the suppressed gene: ' + reasons);
    assert.ok(reasons.indexOf('intent=repair') >= 0, 'reason must mention the repeated intent: ' + reasons);
  });

  it('keeps the memory-graph preferred gene when there is no repeating history', () => {
    const result = selectGeneAndCapsule({
      genes: GENES,
      capsules: CAPSULES,
      signals: ['error', 'protocol'],
      memoryAdvice: {
        preferredGeneId: 'gene_repair',
        bannedGeneIds: new Set(),
        explanation: ['memory_prefer:gene_repair'],
      },
      driftEnabled: false,
    });
    assert.ok(result.selectedGene);
    assert.equal(result.selectedGene.id, 'gene_repair', 'no history means no behaviour change');
    assert.equal(result.selector.reason.join(' ').indexOf('repeat_suppression'), -1);
  });

  it('leaves selection unchanged with an empty history', () => {
    const result = selectGeneAndCapsule({
      genes: GENES,
      capsules: CAPSULES,
      signals: ['error', 'exception', 'failed'],
      memoryAdvice: null,
      driftEnabled: false,
      history: [],
    });
    assert.ok(result.selectedGene);
    assert.equal(result.selectedGene.id, 'gene_repair');
    assert.equal(result.selector.reason.join(' ').indexOf('repeat_suppression'), -1);
  });

  it('still selects a gene when every candidate repeats (no empty selection)', () => {
    const allRepeat = [
      { type: 'EvolutionEvent', id: 'evt_a1', intent: 'repair', signals: ['error', 'protocol'], genes_used: ['gene_repair'], outcome: { status: 'success', score: 0.85 } },
      { type: 'EvolutionEvent', id: 'evt_a2', intent: 'repair', signals: ['error', 'protocol'], genes_used: ['gene_repair'], outcome: { status: 'success', score: 0.85 } },
      { type: 'EvolutionEvent', id: 'evt_a3', intent: 'repair', signals: ['error', 'protocol'], genes_used: ['gene_repair'], outcome: { status: 'success', score: 0.85 } },
      { type: 'EvolutionEvent', id: 'evt_b1', intent: 'optimize', signals: ['error', 'protocol'], genes_used: ['gene_optimize'], outcome: { status: 'success', score: 0.85 } },
      { type: 'EvolutionEvent', id: 'evt_b2', intent: 'optimize', signals: ['error', 'protocol'], genes_used: ['gene_optimize'], outcome: { status: 'success', score: 0.85 } },
      { type: 'EvolutionEvent', id: 'evt_b3', intent: 'optimize', signals: ['error', 'protocol'], genes_used: ['gene_optimize'], outcome: { status: 'success', score: 0.85 } },
    ];
    const result = selectGeneAndCapsule({
      genes: GENES,
      capsules: CAPSULES,
      signals: ['error', 'protocol'],
      memoryAdvice: null,
      driftEnabled: false,
      history: allRepeat,
    });
    assert.ok(result.selectedGene, 'a gene must still be selected when all candidates repeat');
    assert.ok(['gene_repair', 'gene_optimize'].indexOf(result.selectedGene.id) >= 0);
  });

  it('computeRepeatCounts counts same-gene + same-intent cycles only', () => {
    const { computeRepeatCounts } = require('../src/gep/selector');
    const history = [
      { intent: 'repair', signals: ['error'], genes_used: ['gene_repair'] },
      { intent: 'repair', signals: ['error'], genes_used: ['gene_repair'] },
      { intent: 'optimize', signals: ['error'], genes_used: ['gene_repair'] },
      { intent: 'repair', signals: ['totally', 'different'], genes_used: ['gene_repair'] },
    ];
    const counts = computeRepeatCounts(history, ['error'], {});
    const rec = counts.get('gene_repair');
    assert.ok(rec);
    assert.equal(rec.by_intent.repair, 2, 'only overlapping same-intent cycles count');
    assert.equal(rec.by_intent.optimize, 1);
  });
});
