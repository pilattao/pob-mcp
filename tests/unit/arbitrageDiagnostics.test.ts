import { buildArbitrageDiagnostics } from '../../src/services/arbitrageDiagnostics';
import { findArbitrageCycles } from '../../src/services/currencyArbitrage';
import { book, quote, observedAt, referenceFixture } from './poe2ExchangeFixtures';

const scope = { startCurrency: 'divine', startAmount: 1, now: Date.parse(observedAt) };
function sample() {
  const quotes = book([quote('divine', 'exalted', 1, 400, 400, 'forward-a'),
    quote('divine', 'exalted', 1, 240, 240, 'forward-b'), quote('exalted', 'divine', 1, 1, 13, 'shared-one-to-one')]);
  return { quotes, calculation: findArbitrageCycles(quotes, scope) };
}

it('shows a directionally explicit 400x output-rate divergence without modifying the offers or cycle arithmetic', () => {
  const { quotes, calculation } = sample();
  const before = structuredClone({ quotes, calculation });
  const diagnostics = buildArbitrageDiagnostics(quotes, calculation, referenceFixture());
  expect(diagnostics.quoteComparisons.find(q => q.quoteId === 'shared-one-to-one')).toMatchObject({
    listingId: 'shared-one-to-one', unit: 'divine per exalted', status: 'compared',
    quoteRate: 1, referenceRate: 0.0025, quoteToReferenceRatio: 400,
    flagged: true, deviation: 'above-reference',
  });
  expect(diagnostics.quoteComparisons.find(q => q.quoteId === 'forward-b')).toMatchObject({
    unit: 'exalted per divine', quoteRate: 240, referenceRate: 400, quoteToReferenceRatio: 0.6, flagged: false,
  });
  expect(diagnostics.reference).toMatchObject({ status: 'available', deviationFactor: 2, provenance: { sourceAgeSeconds: null, fetchedAt: observedAt } });
  expect({ quotes, calculation }).toEqual(before);
});

it('identifies the exact shared outlier dependency and never adds alternative profits together', () => {
  const { quotes, calculation } = sample();
  const diagnostics = buildArbitrageDiagnostics(quotes, calculation, referenceFixture());
  expect(diagnostics.sharedQuoteDependencies).toEqual([expect.objectContaining({
    quoteId: 'shared-one-to-one', listingId: 'shared-one-to-one', candidateNumbers: [1, 2],
    advertisedStock: 13, stockCurrency: 'divine', flaggedByReference: true, quoteToReferenceRatio: 400,
  })]);
  expect(diagnostics.profitsAdditive).toBe(false);
  expect(diagnostics).not.toHaveProperty('totalProfit');
});

it('keeps dependency warnings when the optional reference source is unavailable', () => {
  const { quotes, calculation } = sample();
  const diagnostics = buildArbitrageDiagnostics(quotes, calculation, undefined, { unavailableReason: 'source temporarily unavailable' });
  expect(diagnostics.reference).toMatchObject({ status: 'unknown', reason: 'source temporarily unavailable' });
  expect(diagnostics.quoteComparisons.every(q => q.status === 'unknown' && q.referenceRate === null && q.quoteToReferenceRatio === null && q.flagged === null)).toBe(true);
  expect(diagnostics.sharedQuoteDependencies[0]).toMatchObject({ quoteId: 'shared-one-to-one', candidateNumbers: [1, 2], flaggedByReference: null });
});

it('does not compare references from another game, league or category', () => {
  const { quotes, calculation } = sample();
  for (const mismatch of [{ game: 'poe1' }, { league: 'Standard' }, { category: 'UniqueAccessories' }]) {
    const reference = referenceFixture(); Object.assign(reference.provenance, mismatch);
    const diagnostics = buildArbitrageDiagnostics(quotes, calculation, reference);
    expect(diagnostics.reference.status).toBe('unknown');
    expect(diagnostics.quoteComparisons.every(q => q.quoteToReferenceRatio === null)).toBe(true);
  }
});

it('leaves missing/invalid currency reference values unknown instead of using a default rate', () => {
  const { quotes, calculation } = sample();
  const reference = referenceFixture(); delete reference.rates.exalted;
  reference.rows[1].primaryValue = 0;
  expect(buildArbitrageDiagnostics(quotes, calculation, reference).quoteComparisons.every(q => q.status === 'unknown')).toBe(true);
  reference.rows[1].primaryValue = NaN;
  expect(buildArbitrageDiagnostics(quotes, calculation, reference).quoteComparisons.every(q => q.flagged === null)).toBe(true);
});

it('uses same-primary row valuations for currencies outside the core rate map and flags low reference ratios', () => {
  const quotes = book([quote('divine', 'alch', 1, 50, 50)]);
  const reference = referenceFixture();
  reference.rows.push({ id: 'alch', name: 'Orb of Alchemy', primaryCurrency: 'divine', primaryValue: 0.005, values: { divine: 0.005 }, sourceKind: 'exchange-valuation' });
  const calculation = findArbitrageCycles(quotes, scope);
  expect(buildArbitrageDiagnostics(quotes, calculation, reference).quoteComparisons[0]).toMatchObject({
    referenceRate: 200, quoteToReferenceRatio: 0.25, flagged: true, deviation: 'below-reference',
  });
});

it('includes shared dependencies spanning qualified and unvalued-residual candidates', () => {
  const quotes = book([quote('divine', 'exalted', 1, 400, 400, 'shared-forward'),
    quote('exalted', 'divine', 1, 1, 13, 'outlier'), quote('exalted', 'divine', 390, 1, 1, 'residue')]);
  const calculation = findArbitrageCycles(quotes, scope);
  expect(calculation.opportunities).toHaveLength(1); expect(calculation.residualCandidates).toHaveLength(1);
  expect(buildArbitrageDiagnostics(quotes, calculation, referenceFixture()).sharedQuoteDependencies[0]).toMatchObject({
    quoteId: 'shared-forward', candidateNumbers: [1, 2],
  });
});
