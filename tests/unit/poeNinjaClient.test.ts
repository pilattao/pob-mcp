import { PoeNinjaClient, withCurrencyAliases } from '../../src/services/poeNinjaClient';
import { exchangeFixture, jsonResponse, poe1Fixture, stashFixture } from './poeNinjaFixtures';

const league = 'Forbidden Rites';
let client: PoeNinjaClient;
let request: jest.SpyInstance;
beforeEach(() => {
  client = new PoeNinjaClient({ game: 'poe2' });
  request = jest.spyOn(globalThis, 'fetch').mockImplementation(async url => {
    const parsed = new URL(String(url));
    if (parsed.pathname.endsWith('/leagues')) return jsonResponse([{ id: league, name: league }, { id: 'Standard', name: 'Standard' }]);
    return jsonResponse(parsed.pathname.includes('/stash/') ? stashFixture() : exchangeFixture());
  });
});
afterEach(() => jest.restoreAllMocks());

it('converts divine primary values into actual chaos units for existing trade consumers', async () => {
  const map = await client.getCurrencyExchangeMap(league);
  expect(map.get('Divine Orb')).toBe(10);
  expect(map.get('Chaos Orb')).toBe(1);
  expect(map.get('Exalted Orb')).toBe(0.025);
  expect(map.get('Orb of Alchemy')).toBe(0.05);
  expect(request.mock.calls.every(call => String(call[0]).includes('/poe2/'))).toBe(true);
});

it('keeps the raw public currency interface and adds provenance', async () => {
  const data = await client.getCurrencyRates(league);
  expect(data.core.primary).toBe('divine');
  expect(data.lines[2].primaryValue).toBe(0.005);
  expect(data.provenance).toMatchObject({ game: 'poe2', league, category: 'Currency', sourceAgeSeconds: null, sourceUpdatedAt: null });
});

it('uses plural PoE2 fragment and stash categories with separate response conversion rates', async () => {
  await client.getFragmentRates(league);
  await client.getCurrencyRates(league);
  const overview = await client.getEconomyOverview(league, 'UniqueAccessories');
  expect(overview.rows[0]).toMatchObject({ id: '360', name: 'The Gnashing Sash',
    primaryCurrency: 'divine', primaryValue: 749.5, values: { chaos: 7082.775, divine: 749.5 },
    baseType: 'Wide Belt', listingCount: 6, corrupted: false, sourceKind: 'stash-estimate' });
  expect(overview.rows[1]).toMatchObject({ corrupted: true, variant: 'corrupted variant' });
  expect(overview.rows).toHaveLength(2);
  const urls = request.mock.calls.map(call => new URL(String(call[0])));
  expect(urls.some(url => url.searchParams.get('type') === 'Fragments')).toBe(true);
  expect(urls.some(url => url.pathname.includes('/stash/current/item/') && url.searchParams.get('type') === 'UniqueAccessories')).toBe(true);
});

it('preserves aggregate volume units without inventing listing counts or quotes', async () => {
  const overview = await client.getEconomyOverview(league);
  expect(overview.rows.find(row => row.id === 'exalted')).toMatchObject({ volumePrimaryValue: 800, primaryCurrency: 'divine' });
  expect(overview.rows.find(row => row.id === 'exalted')?.listingCount).toBeUndefined();
  expect(overview.quoteEvidence).toBe('missing-directional-quotes');
});

it('does not require chaos conversion for a primary-currency overview, but refuses a mislabeled chaos map', async () => {
  const data = exchangeFixture();
  delete (data.core.rates as Record<string, number>).chaos;
  request.mockImplementation(async url => String(url).endsWith('/leagues') ? jsonResponse([{ id: league }]) : jsonResponse(data));
  expect((await client.getEconomyOverview(league)).rows[0].values.chaos).toBeUndefined();
  await expect(client.getCurrencyExchangeMap(league)).rejects.toThrow(/chaos.*conversion|conversion.*chaos/i);
});

it('leaves zero values visible but excludes them from conversion rates and never fabricates prices for an empty dataset', async () => {
  const data = exchangeFixture();
  data.lines[2].primaryValue = 0;
  request.mockImplementation(async url => String(url).endsWith('/leagues') ? jsonResponse([{ id: league }]) : jsonResponse(data));
  expect((await client.getEconomyOverview(league)).rows.find(row => row.id === 'alch')?.primaryValue).toBe(0);
  expect((await client.getCurrencyExchangeMap(league)).has('Orb of Alchemy')).toBe(false);
  client.clearCache();
  data.lines = [];
  expect((await client.getCurrencyExchangeMap(league)).size).toBe(0);
});

it.each([0, -1, 0.000000000000001])('never reports normalized ratios as arbitrage at threshold %s', async threshold => {
  expect(await client.findArbitrageOpportunities(league, threshold)).toEqual([]);
});

it.each(['', ' ', 'Not A League', 'forbidden-rites'])('rejects an absent or inexact league without requesting its overview: %s', async invalid => {
  await expect(client.getCurrencyRates(invalid)).rejects.toThrow(/league/i);
  expect(request.mock.calls.some(call => String(call[0]).includes('/overview'))).toBe(false);
});

it.each(['UniqueAccessory', 'Fragment', 'DivinationCard'])('rejects a PoE1 category in PoE2 mode: %s', async category => {
  await expect(client.getEconomyOverview(league, category)).rejects.toThrow(/category/i);
});

it.each([
  ['missing primary', (data: any) => { delete data.core.primary; }],
  ['PoE1 stash shape', (data: any) => { delete data.core; data.lines = [{ name: 'Example', chaosValue: 1 }]; }],
  ['nonfinite price', (data: any) => { data.lines[0].primaryValue = null; }],
  ['negative price', (data: any) => { data.lines[0].primaryValue = -1; }],
  ['invalid rate', (data: any) => { data.core.rates.chaos = '10'; }],
  ['missing name', (data: any) => { data.items = []; }],
])('rejects invalid overview data: %s', async (_, mutate) => {
  const data = exchangeFixture(); mutate(data);
  request.mockImplementation(async url => String(url).endsWith('/leagues') ? jsonResponse([{ id: league }]) : jsonResponse(data));
  await expect(client.getCurrencyRates(league)).rejects.toThrow(/schema|primary|rate|metadata|price/i);
});

it('reports cache age honestly and preserves original fetch time through cache hits', async () => {
  let now = Date.parse('2026-09-15T12:00:00Z');
  jest.spyOn(Date, 'now').mockImplementation(() => now);
  const initial = await client.getCurrencyRates(league);
  now += 60000;
  const cached = await client.getCurrencyRates(league);
  expect(cached.provenance.fetchedAt).toBe(initial.provenance.fetchedAt);
  expect(cached.provenance.cacheAgeSeconds).toBe(60);
  expect(cached.provenance.sourceAgeSeconds).toBeNull();
  expect(request.mock.calls.filter(call => String(call[0]).includes('/overview'))).toHaveLength(1);
});

it('fails a refresh visibly instead of returning expired data or falling back to PoE1', async () => {
  let now = Date.now(); jest.spyOn(Date, 'now').mockImplementation(() => now);
  await client.getCurrencyRates(league);
  now += 3600001;
  request.mockResolvedValue(new Response('', { status: 503 }));
  await expect(client.getCurrencyRates(league)).rejects.toThrow(/503/);
  expect(request.mock.calls.every(call => String(call[0]).includes('/poe2/'))).toBe(true);
});

it('keeps explicitly selected PoE1 currency and singular fragment support', async () => {
  client = new PoeNinjaClient({ game: 'poe1' });
  request.mockImplementation(async url => String(url).endsWith('/leagues') ? jsonResponse([{ id: 'Standard' }]) : jsonResponse(poe1Fixture()));
  expect((await client.getCurrencyExchangeMap('Standard')).get('Divine Orb')).toBe(200);
  await client.getFragmentRates('Standard');
  expect(request.mock.calls.every(call => String(call[0]).includes('/poe1/'))).toBe(true);
  expect(request.mock.calls.some(call => new URL(String(call[0])).searchParams.get('type') === 'Fragment')).toBe(true);
});

it('shares simultaneous requests and keeps league caches separate', async () => {
  await Promise.all([client.getCurrencyExchangeMap(league), client.getCurrencyRates(league)]);
  expect(request.mock.calls.filter(call => String(call[0]).endsWith('/leagues'))).toHaveLength(1);
  expect(request.mock.calls.filter(call => String(call[0]).includes('/overview'))).toHaveLength(1);
  const original = request.getMockImplementation()!;
  request.mockImplementation(async (url: unknown) => {
    if (String(url).includes('league=Standard')) {
      const data = exchangeFixture(); data.core.rates.chaos = 20;
      return jsonResponse(data);
    }
    return original(url);
  });
  expect((await client.getCurrencyExchangeMap('Standard')).get('Divine Orb')).toBe(20);
  expect((await client.getCurrencyExchangeMap(league)).get('Divine Orb')).toBe(10);
});

it('conditionally revalidates no-cache responses without changing the original retrieval time on 304', async () => {
  let now = Date.parse('2026-09-15T12:00:00Z');
  jest.spyOn(Date, 'now').mockImplementation(() => now);
  request.mockImplementation(async url => {
    if (String(url).endsWith('/leagues')) return jsonResponse([{ id: league }]);
    return jsonResponse(exchangeFixture(), { 'cache-control': 'no-cache', etag: '"currency-v1"',
      'last-modified': 'Tue, 15 Sep 2026 10:00:00 GMT' });
  });
  const first = await client.getCurrencyRates(league);
  now += 60000;
  request.mockResolvedValue(new Response(null, { status: 304 }));
  const second = await client.getCurrencyRates(league);
  expect(second.provenance.fetchedAt).toBe(first.provenance.fetchedAt);
  expect(second.provenance.checkedAt).toBe('2026-09-15T12:01:00.000Z');
  expect(second.provenance.sourceUpdatedAt).toBeNull();
  expect(second.provenance.httpLastModified).toBe('Tue, 15 Sep 2026 10:00:00 GMT');
  expect(request.mock.calls.at(-1)![1].headers['If-None-Match']).toBe('"currency-v1"');
});

it('does not retain no-store responses', async () => {
  request.mockImplementation(async url => String(url).endsWith('/leagues') ? jsonResponse([{ id: league }]) :
    jsonResponse(exchangeFixture(), { 'cache-control': 'no-store' }));
  await client.getCurrencyRates(league);
  await client.getCurrencyRates(league);
  expect(request.mock.calls.filter(call => String(call[0]).includes('/overview'))).toHaveLength(2);
});

it('respects cache max-age and upstream Age before revalidation', async () => {
  let now = Date.now(); jest.spyOn(Date, 'now').mockImplementation(() => now);
  request.mockImplementation(async url => String(url).endsWith('/leagues') ? jsonResponse([{ id: league }]) :
    jsonResponse(exchangeFixture(), { 'cache-control': 'max-age=120', age: '90' }));
  await client.getCurrencyRates(league);
  now += 31000;
  await client.getCurrencyRates(league);
  expect(request.mock.calls.filter(call => String(call[0]).includes('/overview'))).toHaveLength(2);
});

it('honors Retry-After across categories without retrying or falling back to another game', async () => {
  let now = Date.now(); jest.spyOn(Date, 'now').mockImplementation(() => now);
  request.mockResolvedValueOnce(new Response('', { status: 429, headers: { 'retry-after': '120' } }));
  await expect(client.getCurrencyRates(league)).rejects.toThrow(/429/);
  now += 119000;
  await expect(client.getFragmentRates(league)).rejects.toThrow(/429/);
  expect(request).toHaveBeenCalledTimes(1);
  now += 2000;
  expect((await client.getCurrencyExchangeMap(league)).get('Divine Orb')).toBe(10);
});

it('rejects invalid game selection without network access', () => {
  expect(() => new PoeNinjaClient({ game: 'poe3' as 'poe2' })).toThrow(/game/);
  expect(request).not.toHaveBeenCalled();
});

it('adds trade currency aliases without changing units, mutating input or assigning unknown currencies a value', async () => {
  const original = await client.getCurrencyExchangeMap(league);
  const aliased = withCurrencyAliases(original);
  expect(aliased.get('divine')).toBe(10);
  expect(aliased.get('exalted')).toBe(0.025);
  expect(aliased.get('ex')).toBe(0.025);
  expect(aliased.get('alch')).toBe(0.05);
  expect(aliased.get('chaos')).toBe(1);
  expect(aliased.get('Missing Orb')).toBeUndefined();
  expect(original.has('divine')).toBe(false);
  expect(withCurrencyAliases(new Map([['Divine Orb', NaN], ['Chaos Orb', 0]])).size).toBe(0);
  const native = withCurrencyAliases(new Map([['Example Currency', 2]]), [
    { id: 'native-currency-id', name: 'Example Currency' }, { id: 'unpriced-id', name: 'Unknown' },
  ]);
  expect(native.get('native-currency-id')).toBe(2);
  expect(native.has('unpriced-id')).toBe(false);
});

it('returns separate priced variants and source evidence instead of selecting an arbitrary unique price', async () => {
  const result = await client.getItemPrice(league, 'The Gnashing Sash', { category: 'UniqueAccessories' });
  expect(result.status).toBe('ambiguous');
  expect(result.price).toBeNull();
  expect(result.matches).toHaveLength(2);
  expect(result.matches[0]).toMatchObject({ chaosValue: 7082.775, divineValue: 749.5,
    baseType: 'Wide Belt', corrupted: false, provenance: { game: 'poe2', league, category: 'UniqueAccessories' } });
});

it('selects an exact unique name and requested variant including corrupted=false', async () => {
  const result = await client.getItemPrice(league, 'the gnashing sash', { category: 'UniqueAccessories', corrupted: false, baseType: 'Wide Belt' });
  expect(result.status).toBe('priced');
  expect(result.price).toMatchObject({ chaosValue: 7082.775, name: 'The Gnashing Sash', listingCount: 6 });
  expect(result.searchedCategories).toEqual(['UniqueAccessories']);
  const selected = await client.getItemPrice(league, 'The Gnashing Sash', { category: 'UniqueAccessories', variant: 'corrupted variant' });
  expect(selected.price?.corrupted).toBe(true);
});

it('finds a unique without a category and stops after collecting its category variants', async () => {
  const result = await client.getItemPrice(league, 'The Gnashing Sash');
  expect(result.status).toBe('ambiguous');
  expect(result.matches).toHaveLength(2);
  expect(result.searchedCategories).toEqual(['Currency', 'UniqueAccessories']);
  expect(request.mock.calls.filter(call => String(call[0]).includes('/overview'))).toHaveLength(2);
});

it('returns not-found with searched-source evidence for an unknown item or absent variant', async () => {
  const result = await client.getItemPrice(league, 'The Gnashing', { category: 'UniqueAccessories' });
  expect(result).toMatchObject({ status: 'not-found', price: null, matches: [], searchedCategories: ['UniqueAccessories'] });
  expect(result.sources[0].source).toContain('type=UniqueAccessories');
  const absent = await client.getItemPrice(league, 'The Gnashing Sash', { category: 'UniqueAccessories', variant: 'not present' });
  expect(absent.status).toBe('not-found');
});

it('does not report zero chaos when a unique response lacks chaos conversion', async () => {
  const data = stashFixture(); delete (data.core.rates as Record<string, number>).chaos;
  request.mockImplementation(async url => String(url).endsWith('/leagues') ? jsonResponse([{ id: league }]) : jsonResponse(data));
  const result = await client.getItemPrice(league, 'The Gnashing Sash', { category: 'UniqueAccessories', corrupted: false });
  expect(result.price).toMatchObject({ chaosValue: null, divineValue: 749.5, primaryCurrency: 'divine' });
});

it('fails blank item searches without fetching the whole economy', async () => {
  await expect(client.getItemPrice(league, ' ')).rejects.toThrow(/item name/i);
  expect(request).not.toHaveBeenCalled();
});
