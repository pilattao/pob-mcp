import { handleFindWeightedTradeItems } from '../../src/handlers/tradeHandlers';
import { TradeApiClient } from '../../src/services/tradeClient';

// Compact metadata from .local/logs/core-trade2-{filters,stats,leagues}.json.
const metadata = {
  leagues: { result: [{ id: 'Forbidden Rites', realm: 'poe2' }, { id: 'Standard', realm: 'poe2' }] },
  filters: { result: [
    { id: 'status_filters', filters: [{ id: 'status', option: { options: ['online', 'any', 'available', 'securable', 'onlineleague'].map(id => ({ id })) } }] },
    { id: 'type_filters', filters: [{ id: 'category', option: { options: [{ id: 'accessory.ring' }] } }, { id: 'rarity', option: { options: [{ id: 'nonunique' }] } }] },
    { id: 'misc_filters', filters: [{ id: 'mirrored', option: { options: [{ id: 'true' }, { id: 'false' }] } }] },
    { id: 'trade_filters', filters: [{ id: 'price', option: { options: [{ id: 'divine' }, { id: 'exalted' }, { id: null }] } },
      { id: 'sale_type', option: { options: [{ id: null }, { id: 'any' }, { id: 'priced_with_info' }, { id: 'unpriced' }] } }] },
    { id: 'req_filters', filters: [{ id: 'lvl' }] },
    { id: 'equipment_filters', filters: [{ id: 'rune_sockets' }] },
  ] },
  stats: { result: [{ label: 'Explicit', entries: [
    { id: 'explicit.stat_3299347043', text: '# to maximum Life' },
    { id: 'explicit.stat_4080418644', text: '# to Strength' },
    { id: 'explicit.stat_3372524247', text: '#% to Fire Resistance' },
  ] }] },
};

function nativeQuery(): any {
  return { engine: 'new', query: { status: [], // Native PoB2 encodes its unset selector this way.
    filters: {
      type_filters: { filters: { category: { option: 'accessory.ring' }, rarity: { option: 'nonunique' } } },
      misc_filters: { disabled: false, filters: { mirrored: false } },
      trade_filters: { filters: { price: { min: 0, max: 10, option: 'divine' }, sale_type: { option: 'priced' } } },
      req_filters: { filters: { lvl: { max: 90 } } },
      equipment_filters: { filters: { rune_sockets: { min: 0 } } },
    },
    stats: [
      { type: 'weight', value: { min: -5, max: 200 }, filters: [
        { id: 'explicit.stat_3299347043', value: { weight: 0.4427, min: 0 } },
        { id: 'explicit.stat_4080418644', value: { weight: -0.5 }, disabled: false },
      ] },
      { type: 'and', filters: [{ id: 'explicit.stat_3372524247', value: { min: 15, max: 40 } }] },
      { type: 'not', filters: [], disabled: true },
    ] }, sort: { 'statgroup.0': 'desc' } };
}

const row = (id: string, league = 'Forbidden Rites', price: any = { amount: 2, currency: 'divine' }): any => ({ id,
  item: { id, league, name: `Test Ring ${id}`, typeLine: 'Gold Ring', ilvl: 80, explicitMods: ['+80 to maximum Life'] },
  listing: { indexed: '2026-09-15T10:00:00Z', price, account: { name: 'fixture' } } });
let query: any, ctx: any, transport: jest.SpyInstance;
let ids: string[], fetched: any[] | undefined;
beforeEach(() => {
  query = nativeQuery(); ids = Array.from({ length: 30 }, (_, i) => `listing-${i}`); fetched = undefined;
  ctx = { tradeClient: new TradeApiClient({ game: 'poe2', requestsPerSecond: 10000 }),
    ensureLuaClient: jest.fn().mockResolvedValue(undefined),
    getLuaClient: () => ({ generateWeightedTradeQuery: async () => ({ query, warning: 'Native fixture warning' }) }) };
  transport = jest.spyOn(globalThis, 'fetch').mockImplementation(async url => {
    const path = new URL(String(url)).pathname;
    for (const [kind, data] of Object.entries(metadata)) if (path.endsWith(`/data/${kind}`)) return Response.json(data);
    if (path.includes('/search/')) return Response.json({ id: 'weighted-query-id', total: ids.length, result: ids });
    const selected = path.split('/fetch/')[1].split(',');
    return Response.json({ result: fetched ?? selected.map(id => row(id)) });
  });
});
afterEach(() => jest.restoreAllMocks());
const run = (extra: Record<string, any> = {}) => handleFindWeightedTradeItems(ctx, { league: 'Forbidden Rites', slot: 'Ring 1', ...extra });

it('executes the native weighted query without dropping weights, required stats, range zeros or filter semantics', async () => {
  const before = structuredClone(query);
  const text = (await run({ limit: 12 })).content[0].text;
  const request = transport.mock.calls.find(([url]) => String(url).includes('/search/'))!;
  const posted = JSON.parse(request[1].body);
  expect(posted.sort).toEqual({ 'statgroup.0': 'desc' });
  expect(posted.engine).toBe('new');
  expect(posted.query.stats).toEqual(before.query.stats);
  expect(posted.query.filters.trade_filters.filters).toEqual({ price: { min: 0, max: 10, option: 'divine' } });
  expect(posted.query.filters.misc_filters).toEqual({ disabled: false, filters: { mirrored: { option: 'false' } } });
  expect(posted.query.filters.equipment_filters).toEqual(before.query.filters.equipment_filters);
  expect(posted.query.filters.req_filters).toEqual(before.query.filters.req_filters);
  expect(query).toEqual(before);
  expect(text).toContain('Test Ring listing-11');
  expect(text).not.toContain('Test Ring listing-12');
  expect(text).toContain('+80 to maximum Life');
  expect(text).toContain('Native fixture warning');
  expect(text).toMatch(/denomination/i);
  expect(text).not.toMatch(/chaos equivalent|Best Value|DPS gain|best-in-slot/i);
});

it('fetches only the bounded IDs in sequential batches of ten with query identity', async () => {
  await run({ limit: 20 });
  const calls = transport.mock.calls.filter(([url]) => String(url).includes('/fetch/'));
  expect(calls).toHaveLength(2);
  expect(calls.map(call => new URL(String(call[0])).pathname.split('/fetch/')[1].split(','))).toEqual([ids.slice(0, 10), ids.slice(10, 20)]);
  for (const [url, init] of calls) {
    expect(new URL(String(url)).searchParams.get('query')).toBe('weighted-query-id');
    expect(new URL(String(url)).searchParams.get('realm')).toBe('poe2');
    expect((init.headers as any).Cookie).toBeUndefined();
    expect((init.headers as any).Authorization).toBeUndefined();
  }
});

it('uses five by default, retains actual league and emits source/query identity and retrieval time', async () => {
  const text = (await run()).content[0].text;
  const calls = transport.mock.calls.filter(([url]) => String(url).includes('/fetch/'));
  expect(calls).toHaveLength(1);
  expect(String(calls[0][0])).toContain(ids.slice(0, 5).join(','));
  expect(text).toContain('Forbidden Rites');
  expect(text).toContain('Query ID: weighted-query-id');
  expect(text).toContain('/api/trade2/search/poe2/Forbidden%20Rites');
  expect(text).toContain('/trade2/search/poe2/Forbidden%20Rites/weighted-query-id');
  expect(text).toMatch(/Read at:/);
});

it('keeps source ranking while excluding missing, duplicate and wrong-league listings', async () => {
  ids = ['a', 'b', 'c', 'd']; fetched = [row('d'), row('b', 'Standard'), row('a'), row('a'), null];
  const text = (await run()).content[0].text;
  expect(text.indexOf('Test Ring a')).toBeLessThan(text.indexOf('Test Ring d'));
  expect(text.match(/Test Ring a/g)).toHaveLength(1);
  expect(text).not.toContain('Test Ring b');
  expect(text).toMatch(/unavailable|excluded/i);
});

it('preserves an explicit status and sale type and keeps missing price unknown', async () => {
  query.query.status = { option: 'securable' };
  query.query.filters.trade_filters.filters.sale_type.option = 'unpriced';
  ids = ['a']; fetched = [row('a', 'Forbidden Rites', undefined)]; delete fetched[0].listing.price;
  const text = (await run()).content[0].text;
  const request = transport.mock.calls.find(([url]) => String(url).includes('/search/'))!;
  expect(JSON.parse(request[1].body).query).toMatchObject({ status: { option: 'securable' }, filters: { trade_filters: { filters: { sale_type: { option: 'unpriced' } } } } });
  expect(text).toMatch(/Price: (not listed|unavailable)/);
  expect(text).not.toContain('Price: 0');
});

it('returns query identity and warning even when the source finds no matches', async () => {
  ids = [];
  const text = (await run()).content[0].text;
  expect(text).toMatch(/No matching listings/);
  expect(text).toContain('weighted-query-id');
  expect(text).toContain('Native fixture warning');
  expect(transport.mock.calls.some(([url]) => String(url).includes('/fetch/'))).toBe(false);
});

it.each([0, -1, 1.5, 21, NaN, Infinity, '5'])('rejects invalid limit %s before touching the build or network', async limit => {
  await expect(run({ limit })).rejects.toThrow(/limit/i);
  expect(ctx.ensureLuaClient).not.toHaveBeenCalled();
  expect(transport).not.toHaveBeenCalled();
});

it.each([
  ['nonfinite weight', (q: any) => { q.query.stats[0].filters[0].value.weight = Infinity; }],
  ['nonnumeric weight', (q: any) => { q.query.stats[0].filters[0].value.weight = '1'; }],
  ['reversed bounds', (q: any) => { q.query.stats[0].value = { min: 5, max: 1 }; }],
  ['nonfinite price', (q: any) => { q.query.filters.trade_filters.filters.price.max = NaN; }],
  ['unweighted query', (q: any) => { q.query.stats = [{ type: 'and', filters: [] }]; }],
  ['empty weights', (q: any) => { q.query.stats[0].filters = []; }],
])('rejects %s before search execution', async (_, mutate) => {
  mutate(query);
  await expect(run()).rejects.toThrow(/must be finite|nonzero weighted|min exceeds max/i);
  expect(transport.mock.calls.some(([url]) => String(url).includes('/search/'))).toBe(false);
});

it.each([{ maxPrice: NaN }, { maxPrice: -1 }, { maxLevel: Infinity }, { statWeights: [{ weightMult: Infinity }] }])('rejects invalid generator options %j before transport', async options => {
  await expect(run({ options })).rejects.toThrow(/finite|nonnegative|options/i);
  expect(ctx.ensureLuaClient).not.toHaveBeenCalled();
});

it('does not rewrite unknown leagues or unsupported stats into a broader search', async () => {
  await expect(run({ league: 'Unknown League' })).rejects.toThrow(/league/i);
  query.query.stats[0].filters[0].id = 'explicit.invalid';
  await expect(run()).rejects.toThrow(/stat/i);
  expect(transport.mock.calls.some(([url]) => String(url).includes('/search/'))).toBe(false);
});

it('propagates listing fetch failure instead of claiming a successful empty result', async () => {
  transport.mockImplementation(async url => {
    const path = new URL(String(url)).pathname;
    for (const [kind, data] of Object.entries(metadata)) if (path.endsWith(`/data/${kind}`)) return Response.json(data);
    if (path.includes('/search/')) return Response.json({ id: 'q', total: 1, result: ['a'] });
    return Response.json({}, { status: 503 });
  });
  await expect(run()).rejects.toThrow(/503/);
});
