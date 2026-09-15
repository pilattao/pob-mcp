import { ShoppingListService } from '../../src/services/shoppingListService.js';
import { SkillGemService } from '../../src/services/skillGemService.js';
import { StatMapper } from '../../src/services/statMapper.js';
import { handleGenerateShoppingList } from '../../src/handlers/shoppingListHandlers.js';
import { handleFindItemUpgrades } from '../../src/handlers/itemShoppingHandler.js';
import { TradeQuery } from '../../src/types/tradeTypes.js';
import { TradeApiClient } from '../../src/services/tradeClient.js';
import { routeToolCall } from '../../src/server/toolRouter.js';

// All item names, listing quotes and FX rates below are synthetic test inputs.
// They are never production defaults, real market observations or user data.
const raw = (name: string, base: string, mods: string, headers = '') => `Rarity: RARE\n${name}\n${base}\n${headers}\nImplicits: 0\n${mods}`;
function build(): any { return { __xmlRoot: 'PathOfBuilding2', Build: { level: '93', mainSocketGroup: '1', PlayerStat: [
  { stat: 'Life', value: '2000' }, { stat: 'FireResist', value: '60' }, { stat: 'MissingFireResist', value: '20' },
] }, Items: { activeItemSet: '7', Item: [
  { id: '1', '#text': raw('Unused ring', 'Ruby Ring', '+10 to maximum Life') },
  { id: '22', '#text': raw('Selected ring', 'Ruby Ring', '+80 to maximum Life\n+10% to Fire Resistance') },
  { id: '33', '#text': raw('Selected focus', 'Voodoo Focus', '+50 to maximum Energy Shield') },
  { id: '44', '#text': raw('Selected belt', 'Utility Belt', '', 'Charm Slots: 1') },
  { id: '55', '#text': raw('Selected chest', 'Silk Robe', '', 'Sockets: S S\nRune: Test Rune\nRune: None') },
  { id: '66', '#text': 'Rarity: MAGIC\nThawing Charm\nImplicits: 0\nUsed when you become Frozen' },
], ItemSet: [ { id: '1', Slot: { name: 'Ring 1', itemId: '1' } },
  { id: '7', useSecondWeaponSet: 'true', Slot: [ { name: 'Ring 1', itemId: '22' },
    { name: 'Weapon 2 Swap', itemId: '33' }, { name: 'Weapon 1', itemId: '1' },
    { name: 'Belt', itemId: '44' }, { name: 'Body Armour', itemId: '55' },
    { name: 'Charm 1', itemId: '66', active: 'false' }, { name: 'Charm 2', itemId: '66', active: 'true' },
    { name: 'Ring 3', itemId: '0' } ] } ] },
  Skills: { activeSkillSet: '9', SkillSet: [ { id: '1', Skill: { Gem: { nameSpec: 'Inactive skill' } } },
    { id: '9', Skill: [ { enabled: 'true', Gem: [ { gemId: 'skill', level: '18', quality: '20' },
      { gemId: 'support', level: '1', quality: '0' } ] },
      { enabled: 'false', Gem: { gemId: 'disabled', level: '1' } },
      { source: 'Item:44', Gem: { gemId: 'granted', level: '1' } } ] } ] } }; }
const gemService = new SkillGemService({ catalog: async () => [
  { gemId: 'skill', name: 'Test Skill', support: false, naturalMaxLevel: 20, maxLevel: 40, tags: ['spell'], perLevel: [{ level: 20, levelRequirement: 90 }] },
  { gemId: 'support', name: 'Test Support', support: true, naturalMaxLevel: 1, maxLevel: 1, tags: ['support'] },
  { gemId: 'disabled', name: 'Disabled Skill', support: false, naturalMaxLevel: 20, tags: ['spell'] },
  { gemId: 'granted', name: 'Granted Skill', support: false, naturalMaxLevel: 20, tags: ['spell'] },
], compatibility: async () => [] });
const bases: Record<string, string> = { 'Ruby Ring': 'Ring', 'Voodoo Focus': 'Focus', 'Utility Belt': 'Belt', 'Silk Robe': 'Body Armour', 'Thawing Charm': 'Charm' };
const deps = { skillGemService: gemService, baseLookup: (name: string) => bases[name] ? { name, type: bases[name], subType: '', tags: [], req: {}, sourceFile: 'synthetic' } : null };
const Service = ShoppingListService as any;
let game: string | undefined;
beforeEach(() => { game = process.env.POE_GAME; process.env.POE_GAME = 'poe2'; });
afterEach(() => { jest.restoreAllMocks(); if (game === undefined) delete process.env.POE_GAME; else process.env.POE_GAME = game; });

describe('PoE2 selected shopping evidence', () => {
  it('resolves selected item IDs, weapon set and selected enabled gems without PoE1 defaults', async () => {
    const result = await new Service(undefined, undefined, undefined, deps).generateShoppingList(build(), 'Fixture', 'Test League');
    expect(result.selection).toMatchObject({ itemSetId: '7', skillSetId: '9', weaponSet: 2 });
    expect(result.items.find((i: any) => i.slot === 'Ring 1').currentItem).toMatchObject({ id: '22', name: 'Selected ring' });
    expect(result.items.some((i: any) => i.slot === 'Weapon 1')).toBe(false);
    expect(result.items.some((i: any) => i.slot === 'Weapon 2 Swap')).toBe(true);
    expect(result.gems.map((g: any) => g.name)).toEqual(['Test Skill', 'Test Support', 'Granted Skill']);
    expect(result.buildNeeds.resistanceGaps.fire).toBe(20);
    expect(result.buildNeeds.resistanceGaps.cold).toBeUndefined();
    expect(result.buildNeeds.lifeNeeded).toBeUndefined();
    expect(result.summary.totalMediumCost).toBeUndefined();
    expect(JSON.stringify(result)).not.toMatch(/4500|6000|6-link|Stygian Vise|influenced|buildMultiplier/);
  });

  it('rejects unknown selected sets and dangling references rather than borrowing another set', async () => {
    const service = new Service(undefined, undefined, undefined, deps);
    const b = build(); b.Items.activeItemSet = '99';
    await expect(service.generateShoppingList(b, 'Fixture', 'Test League')).rejects.toThrow(/item set/i);
    b.Items.activeItemSet = '7'; b.Items.ItemSet[1].Slot[0].itemId = 'missing';
    const result = await service.generateShoppingList(b, 'Fixture', 'Test League');
    expect(result.items.find((i: any) => i.slot === 'Ring 1').warnings.join(' ')).toMatch(/reference|missing/i);
    expect(result.items.find((i: any) => i.slot === 'Ring 1').currentItem).toBeUndefined();
  });

  it('keeps rune occupancy separate from skill supports and charm capacity separate from immunity', async () => {
    const result = await new Service(undefined, undefined, undefined, deps).generateShoppingList(build(), 'Fixture', 'Test League');
    expect(result.runes.find((r: any) => r.slot === 'Body Armour')).toMatchObject({ capacity: 2, occupied: ['Test Rune'], empty: 1 });
    expect(result.charms).toMatchObject({ capacity: 1, equipped: 2 });
    expect(result.charms.warnings.join(' ')).toMatch(/capacity|1.*slot/i);
    expect(result.items.find((i: any) => i.slot === 'Charm 1').warnings.join(' ')).toMatch(/conditional|activation/i);
    expect(result.items.some((i: any) => i.slot === 'Ring 3' && i.priority === 'critical')).toBe(false);
  });

  it('prefers the native effective charm limit over the belt base capacity', async () => {
    const result = await new Service(undefined, undefined, undefined, deps).generateShoppingList(build(), 'Fixture', 'Test League', 'medium',
      { stats: { CharmLimit: 2 }, includeGems: false });
    expect(result.charms).toMatchObject({ capacity: 2, beltCapacity: 1, capacitySource: 'native-output' });
    expect(result.charms.warnings.join(' ')).not.toMatch(/exceed|but the belt/);
  });

  it('uses native gem natural caps, identity and target requirements without leveling supports or granted skills', async () => {
    const result = await new Service(undefined, undefined, undefined, deps).generateShoppingList(build(), 'Fixture', 'Test League');
    const gem = result.items.find((i: any) => i.kind === 'gem');
    expect(gem.gem).toMatchObject({ gemId: 'skill', currentLevel: 18, targetLevel: 20, levelRequirement: 90 });
    expect(result.items.filter((i: any) => i.kind === 'gem')).toHaveLength(1);
    expect(gem.estimatedImpact).toEqual({});
    expect(gem.price.status).toBe('unpriced');
  });

  it('does not price or recommend an unavailable gem level as immediately equippable', async () => {
    const b = build(); b.Build.level = '80';
    const result = await new Service(undefined, undefined, undefined, deps).generateShoppingList(b, 'Fixture', 'Test League');
    const gem = result.items.find((i: any) => i.kind === 'gem');
    expect(gem.gem.requirementsMet).toBe(false);
    expect(gem.warnings.join(' ')).toMatch(/90/);
    expect(gem.price.status).toBe('unpriced');
  });

  it('does not claim gem requirements are met when attribute requirements are absent', async () => {
    const result = await new Service(undefined, undefined, undefined, deps).generateShoppingList(build(), 'Fixture', 'Test League');
    expect(result.items.find((i: any) => i.kind === 'gem').gem.requirementsMet).toBeUndefined();
  });

  it('preserves real inactive weapon references when that slot is explicitly requested', async () => {
    const result = await new Service(undefined, undefined, undefined, deps).generateShoppingList(build(), 'Fixture', 'Test League', 'medium', { slots: ['Weapon 1'], includeGems: false });
    expect(result.items[0].currentItem.id).toBe('1');
    expect(result.items[0].warnings.join(' ')).toMatch(/inactive weapon/i);
  });

  it('preserves empty rune positions and selected character-rune assignments', async () => {
    const b = build(); b.Items.Item[4]['#text'] = raw('Chest', 'Silk Robe', '', 'Sockets: S S\nRune: None\nRune: Test Rune');
    b.Items.ItemSet[0].RuneSlot = { slotName: 'Helmet Rune #1', runeName: 'Inactive Rune' };
    b.Items.ItemSet[1].RuneSlot = { slotName: 'Helmet Rune #1', runeName: 'Selected Rune' };
    const result = await new Service(undefined, undefined, undefined, deps).generateShoppingList(b, 'Fixture', 'Test League', 'medium',
      { includeGems: false, runeTargets: { 'Body Armour': ['Replacement Rune', 'Test Rune'] } });
    expect(result.items.filter((i: any) => i.kind === 'rune')).toHaveLength(1);
    expect(result.runes.find((r: any) => r.slot === 'Helmet Rune #1')).toMatchObject({ occupied: ['Selected Rune'] });
    expect(JSON.stringify(result.runes)).not.toContain('Inactive Rune');
  });

  it('does not drop disabled charm activation, unknown requirements or unresolved gem identities', async () => {
    const b = build(); b.Skills.SkillSet[1].Skill[0].Gem.push({ gemId: 'missing-gem', nameSpec: 'Unresolved gem', level: '1' });
    const result = await new Service(undefined, undefined, undefined, deps).generateShoppingList(b, 'Fixture', 'Test League');
    expect(result.gems.find((g: any) => g.gemId === 'missing-gem')).toMatchObject({ name: 'Unresolved gem' });
    expect(result.warnings.join(' ')).toMatch(/Unresolved gem|metadata/i);
    expect(result.items.find((i: any) => i.slot === 'Charm 1').currentItem.active).toBe(false);
  });
});

async function market() {
  const queries: TradeQuery[] = [];
  const client: any = { game: 'poe2', getStats: async () => ({ result: [{ label: 'Pseudo', entries: [
    { id: 'pseudo.pseudo_total_fire_resistance', text: '+#% total to Fire Resistance', type: 'pseudo' },
    { id: 'explicit.stat_3981240776', text: '# to Spirit', type: 'explicit' },
  ] }] }), searchItems: async (_league: string, q: TradeQuery) => { queries.push(q); return { id: 'query-1', result: ['candidate'], total: 1 }; },
    fetchItems: async (ids: string[], queryId: string) => { expect(ids.length).toBeLessThanOrEqual(10); expect(queryId).toBe('query-1'); return [{
      id: 'candidate', listing: { price: { amount: 5, currency: 'exalted', type: '~b/o' }, indexed: '2026-09-15T00:00:00Z', account: {}, method: 'psapi', whisper: '' },
      item: { id: 'candidate', league: 'Test League', baseType: 'Ruby Ring', typeLine: 'Ruby Ring', name: 'Candidate ring', identified: true,
        explicitMods: ['+80 to maximum Life', '+30% to Fire Resistance'] },
    }]; } };
  const mapper = new StatMapper(); await mapper.loadFromTradeAPI(await client.getStats());
  const ninja: any = { getCurrencyExchangeMap: async () => new Map([['Exalted Orb', 2], ['Divine Orb', 200]]) };
  return { client, mapper, ninja, queries };
}
describe('PoE2 shopping market evidence', () => {
  it.each([undefined, 5])('retains the body-armour Spirit requirement and renders object modifiers with budget %s', async budget => {
    const m = await market(), originalFetch = m.client.fetchItems;
    m.client.fetchItems = async (ids: string[], queryId: string) => (await originalFetch(ids, queryId)).map((row: any) => ({ ...row,
      item: { ...row.item, baseType: 'Synthetic Robe', explicitMods: [
        { description: '+41 to [Spirit|Spirit]', domain: 'explicit', hash: 'stat.explicit.stat_3981240776' },
      ], properties: [
        { name: '[EnergyShield|Energy Shield]', values: [['146', 1]], displayMode: 0 },
        { name: '[Ward|Runic Ward]', values: [['110', 1]], displayMode: 0 },
      ] },
    }));
    const result = await new Service(m.client, m.mapper, m.ninja, deps).generateShoppingList(build(), 'Fixture', 'Test League', 'medium', {
      slots: ['Body Armour'], includeGems: false, priority: 'dps', budget, currency: 'divine',
      itemRequirements: { 'Body Armour': { minES: 100, minSpirit: 40, minWard: 100 } },
    });
    expect(m.queries[0].query.filters!.equipment_filters!.filters).toMatchObject({ es: { min: 100 }, ward: { min: 100 } });
    expect(m.queries[0].query.filters!.equipment_filters!.filters!.spirit).toBeUndefined();
    expect(m.queries[0].query.stats!.flatMap(g => g.filters)).toContainEqual({ id: 'explicit.stat_3981240776', value: { min: 40 } });
    expect(result.items[0].candidates[0].itemEvidence).toMatchObject({ es: 146, spirit: 41, ward: 110 });
    expect(result.items[0].candidates[0].mods).toEqual(['+41 to Spirit']);
  });

  it('postchecks the three constraints for shopping searches without a spending limit', async () => {
    const m = await market();
    const result = await new Service(m.client, m.mapper, m.ninja, deps).generateShoppingList(build(), 'Fixture', 'Test League', 'medium', {
      slots: ['Ring 1'], includeGems: false, itemRequirements: { 'Ring 1': { minSpirit: 0, minWard: 0, minRuneSockets: 0 } },
    });
    expect(m.queries).toHaveLength(1);
    expect(result.items[0].candidates).toEqual([]); // Missing properties are not observed zeroes.
  });

  it.each([0, 40])('forwards the three native constraints through budgeted shopping and postchecks them (%s)', async minimum => {
    const m = await market(), fetchItems = m.client.fetchItems;
    m.client.fetchItems = async (ids: string[], queryId: string) => (await fetchItems(ids, queryId)).map((row: any) => ({ ...row,
      item: { ...row.item, properties: [
        { name: 'Spirit', values: [[String(minimum), 0]], displayMode: 0 },
        { name: 'Runic Ward', values: [[String(minimum), 0]], displayMode: 0 },
      ], sockets: minimum === 0 ? [] : [{ type: 'rune', group: 0 }] },
    }));
    const result = await new Service(m.client, m.mapper, m.ninja, deps).generateShoppingList(build(), 'Fixture', 'Test League', 'medium', {
      slots: ['Ring 1'], includeGems: false, budget: 1, currency: 'divine',
      itemRequirements: { 'Ring 1': { minSpirit: minimum, minWard: minimum, minRuneSockets: minimum === 0 ? 0 : 1 } },
    });
    expect(m.queries).toHaveLength(1);
    expect(m.queries[0].query.filters!.equipment_filters!.filters).toMatchObject({ spirit: { min: minimum }, ward: { min: minimum }, rune_sockets: { min: minimum === 0 ? 0 : 1 } });
    expect(result.items[0].candidates[0].itemEvidence).toMatchObject({ spirit: minimum, ward: minimum, runeSockets: minimum === 0 ? 0 : 1 });
    m.client.fetchItems = fetchItems; // This listing has no evidence for the new constraints.
    const rejected = await new Service(m.client, m.mapper, m.ninja, deps).generateShoppingList(build(), 'Fixture', 'Test League', 'medium', {
      slots: ['Ring 1'], includeGems: false, budget: 1, currency: 'divine', itemRequirements: { 'Ring 1': { minRuneSockets: 1 } },
    });
    expect(rejected.items[0].candidates).toEqual([]);
  });

  it('leaves every price unknown when no market source is injected', async () => {
    const result = await new Service(undefined, undefined, undefined, deps).generateShoppingList(build(), 'Fixture', 'Test League');
    for (const entry of result.items) {
      expect(entry.candidates).toEqual([]);
      expect(entry.price).toEqual({ status: 'unpriced' });
      expect(entry.referencePrice).toBeUndefined();
    }
    expect(result.summary.quotedSubtotal).toBeUndefined();
    expect(result.summary.quotedItems).toBe(0);
  });

  it.each([undefined, 1])('does not synthesize a missing listing price with budget %s', async budget => {
    const m = await market();
    const fetchItems = m.client.fetchItems;
    m.client.fetchItems = async (ids: string[], queryId: string) => (await fetchItems(ids, queryId)).map((row: any) => {
      delete row.listing.price;
      return row;
    });
    const result = await new Service(m.client, m.mapper, m.ninja, deps).generateShoppingList(build(), 'Fixture', 'Test League', 'medium',
      { slots: ['Ring 1'], includeGems: false, budget, currency: 'divine' });
    expect(result.items[0].price).toEqual({ status: 'unpriced' });
    expect(result.items[0].candidates.every((row: any) => row.price === undefined)).toBe(true);
    expect(result.summary.quotedSubtotal).toBeUndefined();
    expect(result.summary.quotedItems).toBe(0);
  });

  it('issues exact natural-level gem queries using the shared metadata-aware builder', async () => {
    const m = await market();
    await new Service(m.client, m.mapper, m.ninja, deps).generateShoppingList(build(), 'Fixture', 'Test League', 'medium', { slots: [], includeGems: true });
    expect(m.queries).toHaveLength(1);
    expect(m.queries[0].query).toMatchObject({ type: 'Test Skill', filters: { misc_filters: { filters: { gem_level: { min: 20, max: 20 } } },
      type_filters: { filters: { category: { option: 'gem.activegem' }, quality: { min: 20 } } } } });
  });

  it('retains constraints when a caller uses compact slot aliases', async () => {
    const m = await market();
    const result = await new Service(m.client, m.mapper, m.ninja, deps).generateShoppingList(build(), 'Fixture', 'Test League', 'medium',
      { slots: ['Ring1'], includeGems: false, itemRequirements: { Ring1: { fireResist: 50 } } });
    expect(result.items[0].requirements.fireResist).toBe(50);
    expect(m.queries[0].query.stats!.flatMap(g => g.filters)).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'pseudo.pseudo_total_fire_resistance', value: expect.objectContaining({ min: 50 }) }),
    ]));
  });

  it('does not discard requirements for a slot absent from the selected XML', async () => {
    const result = await new Service(undefined, undefined, undefined, deps).generateShoppingList(build(), 'Fixture', 'Test League', 'medium',
      { includeGems: false, itemRequirements: { Boots: { minRuneSockets: 2 } } });
    expect(result.items.find((i: any) => i.slot === 'Boots').requirements.minRuneSockets).toBe(2);
  });

  it('finds actual bounded candidates and quotes a subtotal only for covered entries', async () => {
    const m = await market();
    const result = await new Service(m.client, m.mapper, m.ninja, deps).generateShoppingList(build(), 'Fixture', 'Test League', 'medium',
      { slots: ['Ring 1'], includeGems: false, budget: 1, currency: 'divine' });
    const row = result.items[0];
    expect(row.candidates[0]).toMatchObject({ listingId: 'candidate', price: { amount: 5, currency: 'exalted' } });
    expect(row.candidates[0].url).toContain('/trade2/search/poe2/Test%20League/query-1');
    expect(row.candidates[0].source).toMatchObject({ league: 'Test League', queryId: 'query-1' });
    expect(result.summary.quotedSubtotal).toBe(0.05);
    expect(result.summary.currency).toBe('divine');
    expect(result.summary.totalBudgetCost).toBeUndefined();
    expect(m.queries[0].query.stats!.flatMap(g => g.filters)).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'pseudo.pseudo_total_fire_resistance', value: expect.objectContaining({ min: 30 }) }),
    ]));
  });

  it('keeps failed or unpriced parts visible without zero-price budget claims', async () => {
    const m = await market(); m.client.searchItems = async () => { throw new Error('Synthetic rate limit'); };
    const result = await new Service(m.client, m.mapper, m.ninja, deps).generateShoppingList(build(), 'Fixture', 'Test League', 'medium', { slots: ['Ring 1'], includeGems: false });
    expect(result.items[0].price.status).toBe('unpriced');
    expect(result.items[0].warnings.join(' ')).toMatch(/rate limit/);
    expect(result.items[0].search.query).toBeDefined();
    expect(result.summary.quotedSubtotal).toBeUndefined();
    expect(result.summary.unpricedItems).toBe(1);
  });

  it('keeps rune reference estimates and their source metadata separate from actual listings', async () => {
    const m = await market();
    m.ninja.getItemPrice = async (_league: string, name: string) => ({ status: 'priced', price: { name, primaryCurrency: 'exalted', primaryValue: 3,
      values: { chaos: 6 }, provenance: { game: 'poe2', league: 'Test League', fetchedAt: '2026-09-15T00:00:00Z', sourceUpdatedAt: null, source: 'https://poe.ninja/synthetic' } } });
    const result = await new Service(undefined, undefined, m.ninja, deps).generateShoppingList(build(), 'Fixture', 'Test League', 'medium',
      { slots: ['Body Armour'], includeGems: false, runeTargets: { 'Body Armour': ['Test Rune', 'Replacement Rune'] } });
    const row = result.items.find((i: any) => i.kind === 'rune');
    expect(row.referencePrice).toMatchObject({ primaryCurrency: 'exalted', primaryValue: 3, provenance: { sourceUpdatedAt: null } });
    expect(row.price.status).toBe('unpriced');
    expect(result.summary.quotedSubtotal).toBeUndefined();
  });

  it('does not choose a minimum price from ambiguous unique variants', async () => {
    const b = build(); b.Items.Item[1]['#text'] = 'Rarity: UNIQUE\nTest Unique\nRuby Ring\nImplicits: 0\n+10% to Fire Resistance';
    const m = await market(); m.ninja.getItemPrice = async () => ({ status: 'ambiguous', price: null, matches: [{ primaryValue: 1 }, { primaryValue: 100 }] });
    const result = await new Service(undefined, undefined, m.ninja, deps).generateShoppingList(b, 'Fixture', 'Test League', 'medium', { slots: ['Ring 1'], includeGems: false });
    expect(result.items[0].referencePrice).toBeUndefined();
    expect(result.items[0].warnings.join(' ')).toMatch(/ambiguous/);
    expect(result.summary.quotedSubtotal).toBeUndefined();
  });

  it('bounds market searches while retaining the remaining concrete requirements as unpriced entries', async () => {
    const m = await market();
    const result = await new Service(m.client, m.mapper, m.ninja, deps).generateShoppingList(build(), 'Fixture', 'Test League', 'medium', { includeGems: false, maxSearches: 1 });
    expect(m.queries).toHaveLength(1);
    expect(result.items.length).toBeGreaterThan(1);
    expect(result.items.some((r: any) => r.warnings.join(' ').includes('search limit'))).toBe(true);
    expect(result.summary.unpricedItems).toBeGreaterThan(0);
  });
});

describe('PoE2 shopping handlers', () => {
  it.each(['generate_shopping_list', 'find_item_upgrades'])('forwards saved build, currency and limits through the real %s router', async tool => {
    const m = await market();
    const readBuild = jest.fn(async () => build());
    const context = { buildService: { readBuild } };
    const router: any = { toolGate: { checkGate: () => {} }, tradeClient: m.client, statMapper: m.mapper, ninjaClient: m.ninja,
      recommendationEngine: null, getLuaClient: () => null, ensureLuaClient: async () => {},
      contextBuilder: {
        buildHandlerContext: () => context, buildWatchContext: () => ({}), buildTreeContext: () => ({}),
        buildLuaContext: () => ({}), buildItemSkillContext: () => ({}), buildOptimizationContext: () => ({}),
        buildExportContext: () => ({}), buildSkillGemContext: () => ({ skillGemService: gemService }),
      } };
    const args: any = { build_name: 'Requested', league: 'Test League', budget: 1, currency: 'divine', max_price: 0.1, include_gems: false };
    if (tool === 'find_item_upgrades') args.slot = 'Ring 1'; else args.slots = ['Ring 1'];
    const result = await routeToolCall(tool, args, router);
    expect(readBuild).toHaveBeenCalledWith('Requested');
    expect(result.content[0].text).toContain('Selected ring');
    expect(result.content[0].text).toContain('5 exalted');
    expect(m.queries[0].query.filters!.trade_filters!.filters!.price).toMatchObject({ max: 10 });
  });

  it('honors an explicit saved build and numeric budget without reading a different live build', async () => {
    const m = await market();
    const readBuild = jest.fn(async () => build());
    const context: any = { buildService: { readBuild }, getLuaClient: () => ({ getBuildInfo: async () => ({ name: 'Different build' }),
      getStats: () => { throw new Error('Must not read unrelated stats'); } }), tradeClient: m.client, statMapper: m.mapper, ninjaClient: m.ninja,
      skillGemService: gemService, shoppingDependencies: deps };
    const result = await (handleGenerateShoppingList as any)(context, { build_name: 'Requested', league: 'Test League', budget: 1, currency: 'divine', slots: ['Ring 1'], include_gems: false });
    const text = result.content[0].text;
    expect(readBuild).toHaveBeenCalledWith('Requested'); expect(text).toContain('Selected ring'); expect(text).toContain('5 exalted');
    expect(text).not.toMatch(/~\d+ chaos|4500|\+\d+k DPS/);
  });

  it('uses the same selected-file candidate path for the separately routed item advisor', async () => {
    const m = await market();
    const context: any = { buildService: { readBuild: async () => build() }, getLuaClient: () => null,
      tradeClient: m.client, statMapper: m.mapper, ninjaClient: m.ninja, skillGemService: gemService, shoppingDependencies: deps };
    const result = await (handleFindItemUpgrades as any)(context, { slot: 'Ring 1', build_name: 'Requested', league: 'Test League', budget: 1, currency: 'divine' });
    expect(result.content[0].text).toContain('Selected ring');
    expect(result.content[0].text).toContain('candidate');
    expect(result.content[0].text).toContain('/trade2/search/poe2/');
    expect(result.content[0].text).not.toMatch(/Stygian Vise|Two-Toned Boots|6.link|Oils|permanent immunity/);
  });

  it('validates gem level and quality against the strict real-shaped PoE2 filter catalog', async () => {
    const queries: any[] = [];
    const response = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });
    jest.spyOn(globalThis, 'fetch').mockImplementation(async (url, options) => {
      const path = String(url);
      if (path.endsWith('/data/leagues')) return response({ result: [{ id: 'Test League', realm: 'poe2' }] });
      if (path.endsWith('/data/stats')) return response({ result: [{ label: 'Pseudo', entries: [] }] });
      if (path.endsWith('/data/filters')) return response({ result: [
        { id: 'status_filters', filters: [{ id: 'status', option: { options: [{ id: 'available' }] } }] },
        { id: 'type_filters', filters: [{ id: 'category', option: { options: [{ id: 'gem.activegem' }] } }, { id: 'quality' }] },
        { id: 'misc_filters', filters: [{ id: 'gem_level' }] },
      ] });
      if (path.includes('/search/')) { queries.push(JSON.parse(options!.body as string)); return response({ id: 'gem-query', result: [], total: 0 }); }
      throw new Error(`Unexpected public request ${path}`);
    });
    const client = new TradeApiClient({ game: 'poe2', requestsPerSecond: 10000 });
    const result = await new Service(client, new StatMapper(), undefined, deps).generateShoppingList(build(), 'Fixture', 'Test League', 'medium', { slots: [], includeGems: true });
    expect(queries).toHaveLength(1);
    expect(queries[0].query.filters).toMatchObject({ misc_filters: { filters: { gem_level: { min: 20, max: 20 } } }, type_filters: { filters: { quality: { min: 20 } } } });
    expect(result.items[0].search.url).toContain('/trade2/search/poe2/Test%20League/gem-query');
  });
});
