import { findArbitrageCycles } from '../../src/services/currencyArbitrage';
import { book, quote, observedAt } from './poe2ExchangeFixtures';

const options = { startCurrency: 'divine', startAmount: 1, now: Date.parse(observedAt) };

it('finds a profitable cycle from two independent directional offers with actual quantities', () => {
  const result = findArbitrageCycles(book([quote('divine', 'exalted', 1, 400, 800), quote('exalted', 'divine', 200, 1, 10)]), options);
  expect(result.opportunities).toHaveLength(1);
  expect(result.opportunities[0]).toMatchObject({ currencies: ['divine', 'exalted', 'divine'], startAmount: 1,
    endAmount: 2, grossProfit: 1, grossProfitPercent: 100, netProfit: null, fees: null, fillsGuaranteed: false });
  expect(result.opportunities[0].steps.map(s => [s.from, s.to, s.paid, s.received])).toEqual([
    ['divine', 'exalted', 1, 400], ['exalted', 'divine', 400, 2],
  ]);
});

it('does not invent reciprocal quotes or claim profit from an ordinary bid/ask spread', () => {
  expect(findArbitrageCycles(book([quote('divine', 'exalted', 1, 240, 2044)]), options).opportunities).toEqual([]);
  const sample = book([quote('divine', 'exalted', 1, 240, 2044), quote('exalted', 'divine', 359, 1, 10)]);
  expect(findArbitrageCycles(sample, { ...options, startAmount: 100, minProfitPercent: 0 }).opportunities).toEqual([]);
});

it('finds a three-currency cycle only when all three directed legs exist', () => {
  const sample = book([quote('divine', 'exalted', 1, 2, 2), quote('exalted', 'chaos', 2, 3, 3), quote('chaos', 'divine', 3, 2, 2)]);
  const result = findArbitrageCycles(sample, options);
  expect(result.opportunities[0]).toMatchObject({ currencies: ['divine', 'exalted', 'chaos', 'divine'], grossProfit: 1 });
  expect(findArbitrageCycles(sample, { ...options, maxSteps: 2 }).opportunities).toEqual([]);
});

it('respects advertised output stock and keeps undeployed starting currency separate', () => {
  const sample = book([quote('divine', 'exalted', 1, 400, 400), quote('exalted', 'divine', 200, 1, 2)]);
  const result = findArbitrageCycles(sample, { ...options, startAmount: 10 });
  expect(result.opportunities[0]).toMatchObject({ startAmount: 1, availableStartAmount: 10, unusedStartAmount: 9, endAmount: 2, grossProfit: 1 });
  for (const step of result.opportunities[0].steps) expect(step.received).toBeLessThanOrEqual(step.quote.stock!);
});

it('keeps integer lots and reports unvalued intermediate leftovers', () => {
  const sample = book([quote('divine', 'exalted', 2, 5, 10), quote('exalted', 'divine', 3, 2, 6)]);
  const result = findArbitrageCycles(sample, { ...options, startAmount: 4 });
  expect(result.opportunities[0]).toMatchObject({ startAmount: 4, endAmount: 6, grossProfit: 2,
    leftovers: [{ currency: 'exalted', amount: 1 }] });
});

it('reports a recovered principal plus extra currency without inventing a percentage valuation for that residue', () => {
  const sample = book([quote('divine', 'exalted', 1, 400, 400), quote('exalted', 'divine', 390, 1, 1)]);
  const result = findArbitrageCycles(sample, options);
  expect(result.opportunities).toEqual([]);
  expect(result.residualCandidates[0]).toMatchObject({ startAmount: 1, endAmount: 1, grossProfit: 0,
    gainType: 'unvalued-residual', meetsRequestedProfitPercent: null, netProfit: null,
    leftovers: [{ currency: 'exalted', amount: 10 }] });
});

it('does not miss a smaller profitable size when the largest size is break-even after rounding', () => {
  const sample = book([quote('divine', 'exalted', 4, 3, 100), quote('exalted', 'divine', 5, 7, 100)]);
  expect(findArbitrageCycles(sample, { ...options, startAmount: 28 }).opportunities[0]).toMatchObject({ startAmount: 20, endAmount: 21, grossProfit: 1 });
});

it('scales fractional quoted amounts into whole currency lots without rounding the price in our favor', () => {
  const sample = book([quote('divine', 'exalted', 1, 2, 8), quote('exalted', 'divine', 1, 0.75, 6)]);
  expect(findArbitrageCycles(sample, { ...options, startAmount: 4 }).opportunities[0]).toMatchObject({ startAmount: 4, endAmount: 6, grossProfit: 2 });
  expect(findArbitrageCycles(sample, options).opportunities).toEqual([]);
});

it('requires observed stock and rejects stale observations without treating listing index time as quote freshness', () => {
  const forward = quote('divine', 'exalted', 1, 400, null);
  const reverse = quote('exalted', 'divine', 200, 1, 10);
  expect(findArbitrageCycles(book([forward, reverse]), options).opportunities).toEqual([]);
  forward.stock = 800;
  forward.provenance.indexedAt = '2020-01-01T00:00:00Z';
  expect(findArbitrageCycles(book([forward, reverse]), options).opportunities).toHaveLength(1);
  const stale = findArbitrageCycles(book([forward, reverse]), { ...options, now: options.now + 301000 });
  expect(stale.opportunities).toEqual([]);
  expect(stale.excludedQuotes).toBe(2);
});

it.each([0, -1, 1.2, NaN, Infinity])('rejects invalid starting currency quantity %s', startAmount => {
  expect(() => findArbitrageCycles(book([quote('divine', 'exalted', 1, 2, 4)]), { ...options, startAmount })).toThrow(/amount/i);
});

it('rejects mixed games/leagues and invalid prices instead of producing a cross-market cycle', () => {
  const first = quote('divine', 'exalted', 1, 400, 800), second = quote('exalted', 'divine', 200, 1, 2);
  second.league = 'Standard';
  expect(() => findArbitrageCycles(book([first, second]), options)).toThrow(/league/i);
  second.league = first.league; second.payAmount = NaN;
  expect(() => findArbitrageCycles(book([first, second]), options)).toThrow(/amount|price/i);
});

it('marks bounded quantity exploration incomplete instead of claiming exhaustive detection', () => {
  const result = findArbitrageCycles(book([quote('divine', 'exalted', 1, 2, 200), quote('exalted', 'divine', 1, 1, 200)]),
    { ...options, startAmount: 100, maxScenarios: 1 });
  expect(result.searchComplete).toBe(false);
  expect(result.sizingScenarios).toBe(1);
  expect(result.opportunities[0].fillsGuaranteed).toBe(false);
});
