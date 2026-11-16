const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  buildMutation,
  normalizeMutation,
  geneCategoryOf,
  resolveMutationCategory,
} = require('../src/gep/mutation');

describe('geneCategoryOf', () => {
  it('returns the gene category when it is valid', () => {
    assert.equal(geneCategoryOf({ id: 'g1', category: 'optimize' }), 'optimize');
  });

  it('returns null for missing or invalid categories', () => {
    assert.equal(geneCategoryOf({ id: 'g1' }), null);
    assert.equal(geneCategoryOf(null), null);
    assert.equal(geneCategoryOf({ id: 'g1', category: 'destroy' }), null);
  });
});

describe('resolveMutationCategory', () => {
  it('keeps the context category when the gene has no category', () => {
    const r = resolveMutationCategory({ contextCategory: 'innovate', geneCategory: null });
    assert.equal(r.category, 'innovate');
    assert.equal(r.override, null);
  });

  it('keeps the context category when it already matches the gene', () => {
    const r = resolveMutationCategory({ contextCategory: 'optimize', geneCategory: 'optimize' });
    assert.equal(r.category, 'optimize');
    assert.equal(r.override, null);
  });

  it('aligns an innovate context category to the targeted optimize gene', () => {
    const r = resolveMutationCategory({ contextCategory: 'innovate', geneCategory: 'optimize' });
    assert.equal(r.category, 'optimize');
    assert.equal(r.override.reason, 'gene_category_alignment');
    assert.equal(r.override.context_category, 'innovate');
    assert.equal(r.override.gene_category, 'optimize');
  });

  it('keeps repair when error signals demand it and records the override', () => {
    const r = resolveMutationCategory({ contextCategory: 'repair', geneCategory: 'optimize' });
    assert.equal(r.category, 'repair');
    assert.equal(r.override.reason, 'error_signals_take_precedence');
  });
});

describe('buildMutation category alignment', () => {
  it('aligns the mutation category with the targeted gene category', () => {
    const m = buildMutation({
      signals: ['perf_bottleneck'],
      selectedGene: { id: 'gene_gep_optimize_prompt_and_assets', category: 'optimize' },
    });
    assert.equal(m.category, 'optimize');
    assert.equal(m.category_override.reason, 'gene_category_alignment');
    assert.ok(m.trigger_signals.some(s => s.indexOf('align:mutation_category') === 0));
  });

  it('leaves the context category untouched when no gene category is known', () => {
    const m = buildMutation({ signals: ['perf_bottleneck'], selectedGene: { id: 'gene_x' } });
    assert.equal(m.category, 'innovate');
    assert.equal(m.category_override, undefined);
  });

  it('keeps the mutation valid and the risk low after alignment', () => {
    const m = buildMutation({
      signals: ['perf_bottleneck'],
      selectedGene: { id: 'g', category: 'optimize' },
    });
    assert.ok(['repair', 'optimize', 'innovate'].includes(m.category));
    assert.ok(m.expected_effect);
    assert.equal(m.risk_level, 'low');
  });

  it('keeps repair when error signals demand it', () => {
    const m = buildMutation({
      signals: ['log_error'],
      selectedGene: { id: 'g', category: 'optimize' },
    });
    assert.equal(m.category, 'repair');
    assert.equal(m.category_override.reason, 'error_signals_take_precedence');
  });
});

describe('normalizeMutation keeps category_override', () => {
  it('preserves the override record', () => {
    const m = normalizeMutation({
      id: 'mut_x',
      category: 'optimize',
      trigger_signals: ['perf_bottleneck'],
      target: 'gene:g',
      expected_effect: 'x',
      risk_level: 'low',
      category_override: { reason: 'gene_category_alignment' },
    });
    assert.equal(m.category_override.reason, 'gene_category_alignment');
  });
});
