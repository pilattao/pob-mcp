import { handleFindArbitrage } from '../../src/handlers/poeNinjaHandlers';
import { book, quote, observedAt, referenceFixture } from './poe2ExchangeFixtures';

const args = { league: 'Forbidden Rites', currencies: ['divine', 'exalted'], start_currency: 'divine', start_amount: 1, max_steps: 2 as const, max_quotes_per_pair: 5 };
beforeEach(() => jest.spyOn(Date, 'now').mockReturnValue(Date.parse(observedAt)));
afterEach(() => jest.restoreAllMocks());
function context() {
  return { ninjaClient: { game: 'poe2', getEconomyOverview: jest.fn().mockRejectedValue(new Error('Reference unavailable in this fixture')) } as any,
    exchangeClient: { getQuoteBook: jest.fn().mockResolvedValue(book([
      quote('divine', 'exalted', 1, 400, 400), quote('exalted', 'divine', 200, 1, 2),
    ])) } };
}

it('reports gross candidates with actual quoted lots, stock and provenance, leaving fees and net profit unknown', async () => {
  const ctx = context();
  const result = await handleFindArbitrage(ctx, args);
  expect(ctx.exchangeClient.getQuoteBook).toHaveBeenCalledWith({ league: 'Forbidden Rites', currencies: ['divine', 'exalted'], maxOffersPerPair: 5 });
  expect(result).toMatchObject({ structuredContent: { game: 'poe2', league: 'Forbidden Rites',
    opportunities: [{ grossProfit: 1, netProfit: null, fillsGuaranteed: false }] } });
  expect(result.content[0].text).toMatch(/400 exalted/);
  expect(result.content[0].text).toMatch(/stock/i);
  expect(result.content[0].text).toMatch(/fees.*unknown|unknown.*fees/i);
  expect(result.content[0].text).toContain('/trade2/exchange/poe2/');
  expect(result.content[0].text).not.toMatch(/guaranteed profit|passive income|act quickly|verbatim/i);
});

it('reports an evaluated quote sample with no positive cycle without declaring the market efficient', async () => {
  const ctx = context();
  ctx.exchangeClient.getQuoteBook.mockResolvedValue(book([quote('divine', 'exalted', 1, 240, 2044), quote('exalted', 'divine', 359, 1, 10)]));
  const result = await handleFindArbitrage(ctx, args);
  expect(result).toMatchObject({ structuredContent: { opportunities: [], status: 'evaluated' } });
  expect(result.content[0].text).toMatch(/No positive gross cycle/);
  expect(result.content[0].text).not.toMatch(/Assessment unavailable|market is efficient|balanced rates/i);
});

it('preserves source access errors without requesting reference valuations or fabricating an empty book', async () => {
  const ctx = context();
  ctx.exchangeClient.getQuoteBook.mockRejectedValue(new Error('HTTP 401: Authentication required'));
  await expect(handleFindArbitrage(ctx, args)).rejects.toThrow(/401.*Authentication required/);
  expect(ctx.ninjaClient.getEconomyOverview).not.toHaveBeenCalled();
});

it('annotates and prominently identifies a shared divergent quote while preserving every candidate and profit', async () => {
  const ctx = context();
  const quotes = book([quote('divine', 'exalted', 1, 400, 400, 'forward-a'),
    quote('divine', 'exalted', 1, 240, 240, 'forward-b'), quote('exalted', 'divine', 1, 1, 13, 'shared-one-to-one'),
    quote('exalted', 'divine', 390, 1, 1, 'unvalued-change')]);
  ctx.exchangeClient.getQuoteBook.mockResolvedValue(quotes);
  ctx.ninjaClient.getEconomyOverview.mockResolvedValue(referenceFixture());
  const withoutReference = { ...args, reference_diagnostic: false };
  const baseline = structuredClone((await handleFindArbitrage(ctx, withoutReference)).structuredContent);
  expect(ctx.ninjaClient.getEconomyOverview).not.toHaveBeenCalled();
  const result = await handleFindArbitrage(ctx, args);
  expect(ctx.ninjaClient.getEconomyOverview).toHaveBeenCalledWith('Forbidden Rites', 'Currency');
  const data = result.structuredContent as any;
  expect(data.opportunities).toEqual(baseline!.opportunities);
  expect(data.residualCandidates).toEqual(baseline!.residualCandidates);
  expect(data.residualCandidates).toHaveLength(1);
  expect(data.diagnostics.sharedQuoteDependencies.find((row: any) => row.quoteId === 'shared-one-to-one')).toMatchObject({
    quoteId: 'shared-one-to-one', candidateNumbers: [1, 2], flaggedByReference: true, quoteToReferenceRatio: 400,
  });
  const text = result.content[0].text;
  expect(text).toContain('quote/reference 400');
  expect(text).toContain('divine per exalted');
  expect(text).toContain('shared-one-to-one');
  expect(text).toContain('candidates 1, 2');
  expect(text).toMatch(/do not sum.*profits/i);
  expect(text.indexOf('shared-one-to-one')).toBeLessThan(text.indexOf('Quoted scenario:'));
  expect(text).not.toMatch(/fraud|scam|fake|guaranteed profit/i);
});

it('reports unknown reference diagnostics on lookup failure without losing the quoted result', async () => {
  const ctx = context();
  const result = await handleFindArbitrage(ctx, args);
  expect(result).toMatchObject({ structuredContent: {
    opportunities: [{ grossProfit: 1 }], diagnostics: { reference: { status: 'unknown' } },
  } });
  expect(result.content[0].text).toMatch(/Reference diagnostic: unknown/);
  expect(result.content[0].text).toContain('Reference unavailable in this fixture');
});

it('can disable the optional reference read while retaining normal cycle evaluation', async () => {
  const ctx = context();
  const options = { ...args, reference_diagnostic: false };
  const result = await handleFindArbitrage(ctx, options);
  expect(ctx.ninjaClient.getEconomyOverview).not.toHaveBeenCalled();
  expect(result).toMatchObject({ structuredContent: { opportunities: [{ grossProfit: 1 }], diagnostics: { reference: { status: 'disabled' } } } });
});

it.each([NaN, -1, Infinity])('rejects an invalid gross profit threshold %s before requesting quotes', async threshold => {
  const ctx = context();
  await expect(handleFindArbitrage(ctx, { ...args, min_profit_percent: threshold })).rejects.toThrow(/profit/i);
  expect(ctx.exchangeClient.getQuoteBook).not.toHaveBeenCalled();
});

it.each([{ currencies: null }, { currencies: ['divine'] }, { currencies: ['divine', 'divine'] },
  { start_currency: 'chaos' }, { start_amount: 0 }, { max_steps: 4 }])('rejects invalid scope before requesting quotes: %j', async invalid => {
  const ctx = context();
  await expect(handleFindArbitrage(ctx, { ...args, ...invalid } as any)).rejects.toThrow(/currenc|start_amount|max_steps/i);
  expect(ctx.exchangeClient.getQuoteBook).not.toHaveBeenCalled();
});

it('rejects a quote source returning another league instead of changing the requested league', async () => {
  const ctx = context();
  const other = book([quote('divine', 'exalted', 1, 400, 400), quote('exalted', 'divine', 200, 1, 2)]);
  other.league = 'Standard'; other.quotes.forEach(q => { q.league = 'Standard'; });
  ctx.exchangeClient.getQuoteBook.mockResolvedValue(other);
  await expect(handleFindArbitrage(ctx, args)).rejects.toThrow(/requested league/i);
});
