import { ItemRecommendationEngine, UpgradeContext } from '../../src/services/itemRecommendationEngine.js';
import { TradeApiClient } from '../../src/services/tradeClient.js';
import { StatMapper } from '../../src/services/statMapper.js';
import { ItemListing, TradeQuery } from '../../src/types/tradeTypes.js';

function item(id: string, amount = 10, currency = 'chaos', mods = ['+80 to maximum Life']): ItemListing {
  return { id, item: { id, name: '', typeLine: 'Gold Ring', baseType: 'Gold Ring', identified: true,
    verified: true, w: 1, h: 1, icon: '', league: 'Test League', ilvl: 80, frameType: 2,
    explicitMods: mods, implicitMods: [] }, listing: { method: 'psapi', indexed: '', whisper: '',
    account: { name: 'synthetic' }, price: { type: '~b/o', amount, currency } } };
}
const context = (): UpgradeContext => ({ league: 'Test League', buildNeeds: { lifeNeeded: 60 },
  budget: { maxPricePerItem: 100, totalBudget: 100, currency: 'chaos' } });
const metadata = { result: [{ label: 'Pseudo', entries: [
  { id: 'pseudo.pseudo_total_life', text: '+# total maximum Life', type: 'pseudo' },
  ...['fire', 'cold', 'lightning', 'chaos'].map(r => ({ id: `pseudo.pseudo_total_${r}_resistance`,
    text: `+#% total to ${r[0].toUpperCase() + r.slice(1)} Resistance`, type: 'pseudo' })),
  { id: 'explicit.synthetic', text: '+# to Level of all Spell Skills', type: 'explicit' },
  { id: 'explicit.stat_3981240776', text: '# to Spirit', type: 'explicit' },
] }] };
async function setup(listings: ItemListing[], currencyClient?: any) {
  const calls: TradeQuery[] = [], batches: string[][] = [];
  const client = {
    game: 'poe2', getStats: async () => metadata,
    searchItems: async (_league: string, query: TradeQuery) => { calls.push(query); return { id: 'query-1', result: listings.map(i => i.id), total: listings.length }; },
    fetchItems: async (ids: string[], queryId: string) => {
      if (ids.length > 10) throw new Error('Cannot fetch more than 10 items at once');
      expect(queryId).toBe('query-1'); batches.push(ids);
      return listings.filter(i => ids.includes(i.id));
    },
  };
  const mapper = new StatMapper(); await mapper.loadFromTradeAPI(metadata);
  return { engine: new ItemRecommendationEngine(client as unknown as TradeApiClient, mapper, currencyClient), calls, batches, mapper, client };
}
let game: string | undefined;
beforeEach(() => { game = process.env.POE_GAME; process.env.POE_GAME = 'poe2'; });
afterEach(() => { jest.restoreAllMocks(); if (game === undefined) delete process.env.POE_GAME; else process.env.POE_GAME = game; });

describe('PoE2 candidate search', () => {
  it('fetches twenty candidates in batches of ten with their search identity', async () => {
    const { engine, batches } = await setup(Array.from({ length: 23 }, (_, i) => item(String(i))));
    const results = await engine.findUpgrades('Ring 1', context());
    expect(results).toHaveLength(20); expect(batches.map(b => b.length)).toEqual([10, 10]);
  });

  it('retains budget currency, explicit needs, category, base and custom stat constraints', async () => {
    const { engine, calls } = await setup([]);
    const ctx = { ...context(), buildNeeds: { lifeNeeded: 85, esNeeded: 200, resistanceGaps: { fire: 15, cold: 0, lightning: 0, chaos: 20 } },
      budget: { maxPricePerItem: 2, totalBudget: 1, currency: 'divine' },
      itemRequirements: { itemCategory: 'armour.focus', baseType: 'Voodoo Focus', stats: [{ id: 'explicit.synthetic', min: 3 }] } };
    await engine.findUpgrades('Weapon 2', ctx);
    expect(calls[0].query).toMatchObject({ type: 'Voodoo Focus', filters: {
      type_filters: { filters: { category: { option: 'armour.focus' } } },
      equipment_filters: { filters: { es: { min: 200 } } },
      trade_filters: { filters: { price: { max: 1, option: 'divine' } } },
    } });
    expect(calls[0].query.stats!.flatMap(g => g.filters)).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'pseudo.pseudo_total_life', value: expect.objectContaining({ min: 85 }) }),
      expect.objectContaining({ id: 'pseudo.pseudo_total_fire_resistance', value: expect.objectContaining({ min: 15 }) }),
      expect.objectContaining({ id: 'pseudo.pseudo_total_chaos_resistance', value: expect.objectContaining({ min: 20 }) }),
      expect.objectContaining({ id: 'explicit.synthetic', value: expect.objectContaining({ min: 3 }) }),
    ]));
  });

  it('searches all quote currencies via the Exalted Orb Equivalent filter when reference rates exist', async () => {
    const { engine, calls } = await setup([item('cheap-exalt', 10, 'exalted'), item('too-much', 2, 'divine')],
      { getCurrencyExchangeMap: async () => new Map([['Divine Orb', 200], ['Exalted Orb', 2]]) });
    const ctx = context(); ctx.budget = { maxPricePerItem: 1, totalBudget: 1, currency: 'divine' };
    const result = await engine.findUpgrades('Ring 1', ctx);
    expect(calls[0].query.filters!.trade_filters!.filters!.price).toEqual({ min: undefined, max: 100 });
    expect(result.map(r => r.listing.id)).toEqual(['cheap-exalt']);
    expect(result[0].warnings!.join(' ')).toMatch(/reference.*rate|rate.*reference/i);
    expect(result[0].warnings!.join(' ')).toMatch(/sample|20/i);
  });

  it('retains same-currency search and discloses narrowed coverage if quotes fail', async () => {
    const { engine, calls } = await setup([item('candidate', 1, 'divine')],
      { getCurrencyExchangeMap: async () => { throw new Error('Market unavailable'); } });
    const ctx = context(); ctx.budget = { maxPricePerItem: 2, totalBudget: 2, currency: 'divine' };
    const [result] = await engine.findUpgrades('Ring 1', ctx);
    expect(calls[0].query.filters!.trade_filters!.filters!.price).toMatchObject({ option: 'divine', max: 2 });
    expect(result.warnings!.join(' ')).toMatch(/denominat|quote currency/i);
  });

  it('preserves exact item-stat bounds including zero instead of silently dropping them', async () => {
    const { engine, calls } = await setup([]);
    await engine.findUpgrades('Ring 1', { ...context(), itemRequirements: { minLife: 0, stats: [{ id: 'explicit.synthetic', min: 0, max: 0 }] } });
    expect(calls[0].query.stats!.flatMap(g => g.filters)).toContainEqual({ id: 'explicit.synthetic', value: { min: 0, max: 0 } });
  });

  it('rejects unknown runtime constraints instead of quietly widening the search', async () => {
    const { engine } = await setup([]);
    const ctx = { ...context(), itemRequirements: { minLife: 60, minUnsupportedStat: 40 } };
    await expect(engine.findUpgrades('Ring 1', ctx)).rejects.toThrow(/minUnsupportedStat|constraint/i);
  });

  it.each([0, 25])('retains Spirit, Ward and rune socket constraints including zero (%s)', async minimum => {
    const { engine, calls } = await setup([]);
    await engine.findUpgrades('Helmet', { ...context(), buildNeeds: {}, itemRequirements: {
      minSpirit: minimum, minWard: minimum, minRuneSockets: minimum === 0 ? 0 : 2,
    } });
    expect(calls[0].query.filters!.equipment_filters!.filters).toMatchObject({
      spirit: { min: minimum }, ward: { min: minimum }, rune_sockets: { min: minimum === 0 ? 0 : 2 },
    });
  });

  it('checks all three constraints against displayed listing evidence after fetching', async () => {
    const candidates = ['match', 'low-spirit', 'low-ward', 'jewel-socket', 'unknown'].map(id => item(id));
    for (const candidate of candidates.slice(0, 4)) {
      candidate.item.properties = [
        { name: 'Spirit', values: [[candidate.id === 'low-spirit' ? '39' : '40', 0]], displayMode: 0 },
        { name: 'Runic Ward', values: [[candidate.id === 'low-ward' ? '59' : '60', 0]], displayMode: 0 },
      ];
      candidate.item.sockets = [{ type: 'rune', group: 0 }, { type: candidate.id === 'jewel-socket' ? 'jewel' : 'rune', group: 1 }] as any;
    }
    const { engine } = await setup(candidates);
    const result = await engine.findUpgrades('Helmet', { ...context(), buildNeeds: {}, itemRequirements: { minSpirit: 40, minWard: 60, minRuneSockets: 2 } });
    expect(result.map(r => r.listing.id)).toEqual(['match']);
    expect(result[0].itemEvidence.stats).toMatchObject({ spirit: 40, ward: 60, runeSockets: 2 });
  });

  it('accepts observed zero but never treats missing evidence as zero', async () => {
    const zero = item('zero');
    zero.item.properties = [{ name: 'Spirit', values: [['0', 0]], displayMode: 0 }, { name: 'Ward', values: [['0', 0]], displayMode: 0 }];
    zero.item.sockets = [];
    const { engine } = await setup([item('missing'), zero]);
    const result = await engine.findUpgrades('Helmet', { ...context(), buildNeeds: {}, itemRequirements: { minSpirit: 0, minWard: 0, minRuneSockets: 0 } });
    expect(result.map(r => r.listing.id)).toEqual(['zero']);
  });

  it('queries body-armour Spirit mods and preserves actual ES/Ward minimums after quality-normalized search', async () => {
    const tooLow = item('normalized-only', 1), good = item('actual-match', 3);
    for (const row of [tooLow, good]) {
      row.item.explicitMods = [{ description: '+41 to [Spirit|Spirit]', domain: 'explicit', hash: 'stat.explicit.stat_3981240776' }] as any;
      row.item.properties = [
        { name: '[EnergyShield|Energy Shield]', values: [['146', 1]], displayMode: 0 },
        { name: '[Ward|Runic Ward]', values: [[row === tooLow ? '87' : '110', 1]], displayMode: 0 },
      ];
      row.item.extended = { es: 175, ward: 132 } as any;
    }
    const { engine, calls } = await setup([tooLow, good]);
    const result = await engine.findUpgrades('Body Armour', { ...context(), buildNeeds: {}, itemRequirements: { minES: 100, minSpirit: 40, minWard: 100 } });
    expect(calls[0].query.filters!.equipment_filters!.filters).toEqual({ es: { min: 100 }, ward: { min: 100 } });
    expect(calls[0].query.stats!.flatMap(g => g.filters)).toContainEqual({ id: 'explicit.stat_3981240776', value: { min: 40 } });
    expect(result.map(r => r.listing.id)).toEqual(['actual-match']);
    expect(result[0].itemEvidence.stats).toMatchObject({ es: 146, spirit: 41, ward: 110 });
  });

  it.each(['minSpirit', 'minWard', 'minRuneSockets'])('rejects invalid %s values before searching', async key => {
    const { engine, calls } = await setup([]);
    for (const value of [-1, NaN, Infinity, '2']) await expect(engine.findUpgrades('Helmet', {
      ...context(), buildNeeds: {}, itemRequirements: { [key]: value } as any,
    })).rejects.toThrow(/finite|non-negative/i);
    expect(calls).toHaveLength(0);
  });

  it('does not accept missing displayed defenses as a known zero or flat ES total', async () => {
    const { engine } = await setup([item('unknown', 10, 'chaos', ['+300 to maximum Energy Shield'])]);
    const ctx = context(); ctx.buildNeeds = { esNeeded: 100 };
    expect(await engine.findUpgrades('Helmet', ctx)).toEqual([]);
  });

  it('propagates a failed later fetch batch rather than returning a misleading partial success', async () => {
    const { engine, batches, client } = await setup(Array.from({ length: 20 }, (_, i) => item(String(i))));
    // The real engine must let transport failures surface to the handler.
    const fetch = client.fetchItems;
    client.fetchItems = async (ids: string[], query: string) => { if (batches.length) throw new Error('fetch unavailable'); return fetch(ids, query); };
    await expect(engine.findUpgrades('Ring 1', context())).rejects.toThrow('fetch unavailable');
  });

  it('requires an explicit category for an ambiguous offhand', async () => {
    const { engine } = await setup([]);
    await expect(engine.findUpgrades('Weapon 2 Swap', context())).rejects.toThrow(/categor|offhand/i);
  });

  it('fails explicitly when a requested stat mapping is unavailable', async () => {
    const { engine, mapper } = await setup([]);
    jest.spyOn(mapper, 'getTradeId').mockReturnValue(null);
    jest.spyOn(mapper, 'getPobName').mockReturnValue(null);
    await expect(engine.findUpgrades('Ring 1', context())).rejects.toThrow(/stat|mapping|metadata/i);
  });

  it('rejects over-budget and unpriced candidates using actual currency values', async () => {
    const unpriced = item('unpriced'); delete unpriced.listing.price;
    const { engine } = await setup([item('expensive', 1, 'divine'), item('affordable', 20, 'exalted'),
      item('unconverted', 1, 'new-currency'), unpriced], { getCurrencyExchangeMap: async () => new Map([['Divine Orb', 200], ['Exalted Orb', 2]]) });
    const result = await engine.findUpgrades('Ring 1', context());
    expect(result.map(r => r.listing.id)).toEqual(['affordable']);
    expect(result[0].costBenefit).toMatchObject({ price: 20, currency: 'exalted' });
  });

  it('uses same-currency budgets without pretending exchange rates are known', async () => {
    const { engine } = await setup([item('priced', 1, 'divine')]);
    const ctx = context(); ctx.budget = { maxPricePerItem: 2, totalBudget: 2, currency: 'divine' };
    const [result] = await engine.findUpgrades('Ring 1', ctx);
    expect(result.costBenefit.pointsPerChaos).toBeUndefined();
    expect(result.warnings!.join(' ')).toMatch(/rate|conversion/i);
  });

  it('keeps identical candidate ranks when the budget currency denomination changes', async () => {
    const rates = new Map([['Divine Orb', 200], ['Exalted Orb', 2]]);
    const { engine } = await setup([item('divine', 0.5, 'divine'), item('chaos', 40), item('exalt', 20, 'exalted')], { getCurrencyExchangeMap: async () => rates });
    const first = context();
    const second = context(); second.budget = { maxPricePerItem: 0.5, totalBudget: 0.5, currency: 'divine' };
    const a = await engine.findUpgrades('Ring 1', first), b = await engine.findUpgrades('Ring 1', second);
    expect(a.map(r => r.listing.id)).toEqual(['chaos', 'exalt', 'divine']);
    expect(b.map(r => r.listing.id)).toEqual(a.map(r => r.listing.id));
    expect(b.map(r => r.score)).toEqual(a.map(r => r.score));
  });

  it('does not create build gains without a baseline or derive DPS from flat damage', async () => {
    const { engine } = await setup([item('candidate', 10, 'chaos', ['+80 to maximum Life', 'Adds 100 to 200 Fire Damage to Spells'])]);
    const ctx = context(); ctx.buildNeeds.dpsTarget = 500000;
    const [result] = await engine.findUpgrades('Ring 1', ctx);
    expect(result.costBenefit.lifeGain).toBeUndefined(); expect(result.costBenefit.dpsGain).toBeUndefined();
    expect(result.statComparison).toBeUndefined();
    expect(result.warnings!.join(' ')).toMatch(/native.*calculat/i);
  });

  it('compares signed item-stat deltas and preserves resistance losses', async () => {
    const { engine, calls } = await setup([item('candidate', 10, 'chaos', ['+85 to maximum Life', '+15% to Fire Resistance', '+5% to Cold Resistance'])]);
    const ctx = context(); ctx.currentItem = { name: 'old', slot: 'Ring 1', life: 80, resistances: { fire: 10, cold: 30 } };
    ctx.buildNeeds = { lifeNeeded: 5, resistanceGaps: { fire: 5, cold: 0, lightning: 0 } };
    const [result] = await engine.findUpgrades('Ring 1', ctx);
    expect(result.costBenefit.lifeGain).toBe(5);
    expect(result.costBenefit.resistGain).toMatchObject({ fire: 5, cold: -25 });
    expect(result.warnings!.join(' ')).toMatch(/cold|loss/i);
    expect(calls[0].query.stats!.flatMap(g => g.filters)).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'pseudo.pseudo_total_life', value: expect.objectContaining({ min: 85 }) }),
    ]));
  });

  it('keeps resistance candidates distinct from claims to cap the build and deduplicates ring slots', async () => {
    const { engine } = await setup([item('ring', 10, 'chaos', ['+20% to Chaos Resistance'])]);
    const result = await engine.findResistanceGear({ fire: 0, cold: 0, lightning: 0, chaos: 20 }, context().budget, 'Test League', ['Ring 1', 'Ring 2']);
    expect(result).toHaveLength(1);
    expect(result[0].costBenefit.resistGain).toBeUndefined();
    expect(result[0].warnings!.join(' ')).toMatch(/current|baseline/i);
  });

  it('does not treat partially supplied current stats as zero baselines', async () => {
    const { engine } = await setup([item('candidate')]);
    const ctx = context(); ctx.currentItem = { name: 'unknown', slot: 'Ring 1' };
    const [result] = await engine.findUpgrades('Ring 1', ctx);
    expect(result.costBenefit.lifeGain).toBeUndefined();
    expect(result.warnings!.join(' ')).toMatch(/baseline.*missing|missing.*baseline/i);
  });

  it('uses native weapon filters only for explicit candidate weapon DPS, never the build target', async () => {
    const { engine, calls } = await setup([]);
    const ctx = context(); ctx.buildNeeds = { dpsTarget: 100000 };
    ctx.itemRequirements = { itemCategory: 'weapon.crossbow', minDPS: 400, minPDPS: 250, minEDPS: 100 };
    await engine.findUpgrades('Weapon 1', ctx);
    expect(calls[0].query.filters!.equipment_filters!.filters).toMatchObject({ dps: { min: 400 }, pdps: { min: 250 }, edps: { min: 100 } });
  });

  it('passes a real-shaped candidate query through the strict PoE2 metadata client', async () => {
    const filters = { result: [
      { id: 'status_filters', filters: [{ id: 'status', option: { options: [{ id: 'available' }] } }] },
      { id: 'type_filters', filters: [{ id: 'category', option: { options: [{ id: 'accessory.ring' }] } }] },
      { id: 'trade_filters', filters: [{ id: 'price', option: { options: [{ id: null }, { id: 'divine' }, { id: 'exalted' }] } }] },
    ] };
    const captured: TradeQuery[] = [];
    const api = jest.spyOn(globalThis, 'fetch').mockImplementation(async (url, options) => {
      const path = String(url);
      const response = (body: unknown) => Promise.resolve(new Response(JSON.stringify(body), { status: 200 }));
      if (path.endsWith('/data/leagues')) return response({ result: [{ id: 'Test League', realm: 'poe2' }] });
      if (path.endsWith('/data/filters')) return response(filters);
      if (path.endsWith('/data/stats')) return response(metadata);
      if (path.includes('/search/')) { captured.push(JSON.parse(options!.body as string)); return response({ id: 'q', result: ['candidate'], total: 1 }); }
      if (path.includes('/fetch/')) return response({ result: [item('candidate', 10, 'exalted')] });
      throw new Error(`Unexpected public API request: ${path}`);
    });
    const client = new TradeApiClient({ game: 'poe2', requestsPerSecond: 10000 });
    const mapper = new StatMapper(); await mapper.loadFromTradeAPI(metadata);
    const engine = new ItemRecommendationEngine(client, mapper);
    const ctx = context(); ctx.budget = { currency: 'divine', maxPricePerItem: 1, totalBudget: 1 };
    ctx.currencyRates = new Map([['Divine Orb', 200], ['Exalted Orb', 2]]);
    const [result] = await engine.findUpgrades('Ring 1', ctx);
    expect(captured[0].query.filters!.trade_filters!.filters!.price).toEqual({ max: 100 });
    expect(result.costBenefit.price).toBe(10);
    expect(result.costBenefit.currency).toBe('exalted');
    expect(result.costBenefit.priceInBudgetCurrency).toBe(0.1);
    expect(api.mock.calls.some(([url]) => String(url).includes('query=q'))).toBe(true);
  });
});
