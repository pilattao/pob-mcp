import { handleSuggestCrafting } from '../../src/handlers/craftingAdvisorHandler.js';
import { BuildService } from '../../src/services/buildService.js';
import * as legacyData from '../../src/services/craftingDataService.js';
import { useNativeCraftFixture } from '../fixtures/coreCraftNative.js';

const league = 'Forbidden Rites';
function economy() {
  return {
    primaryCurrency: 'divine', rates: { chaos: 123.45, divine: 1 }, quoteEvidence: 'missing-directional-quotes',
    rows: [
      { id: 'divine', name: 'Divine Orb', primaryCurrency: 'divine', primaryValue: 1, values: { chaos: 123.45, divine: 1 }, sourceKind: 'core-reference' },
      { id: 'exalted', name: 'Exalted Orb', primaryCurrency: 'divine', primaryValue: 0.002, values: { chaos: 0.2469, divine: 0.002 }, sourceKind: 'exchange-valuation' },
    ],
    provenance: { game: 'poe2', league, category: 'Currency', source: 'https://poe.ninja/test/poe2/currency',
      fetchedAt: '2026-09-15T10:00:00Z', checkedAt: '2026-09-15T10:00:05Z', cacheAgeSeconds: 5, sourceUpdatedAt: null, sourceAgeSeconds: null, httpLastModified: null },
  };
}
const item = (rarity = 'MAGIC', mods = '+10 to Strength', base = 'Makeshift Crossbow', tail = '') =>
  `Rarity: ${rarity}\n${base}\nItem Level: 20\nImplicits: 0\n${mods}\n${tail}`;
function nativeXml(raw = item(), active = '2') {
  return `<PathOfBuilding2><Build level="90" className="Witch"/>
    <Items activeItemSet="${active}"><Item id="1">${item('MAGIC', '+7 to Strength', 'Tense Crossbow')}</Item>
    <Item id="2">${raw}</Item><ItemSet id="1" useSecondWeaponSet="false"><Slot name="Weapon 1" itemId="1"/></ItemSet>
    <ItemSet id="2" useSecondWeaponSet="true"><Slot name="Weapon 1 Swap" itemId="2"/><Slot name="Weapon 1" itemId="1"/></ItemSet></Items>
    <Config activeConfigSet="1"><ConfigSet id="1" title="Current config"/></Config></PathOfBuilding2>`;
}
function context(xml?: string) {
  const native = xml === undefined ? null : {
    getBuildInfo: jest.fn(async () => ({ name: 'Unsaved crafting target', level: 90, className: 'Witch' })),
    exportBuildXml: jest.fn(async () => xml),
    getStats: jest.fn(async () => ({ Life: 2502, ChaosResist: 39, MissingChaosResist: 36 })),
    loadBuildXml: jest.fn(), saveBuild: jest.fn(), getItems: jest.fn(),
  };
  return {
    native,
    buildService: new BuildService('/unused'),
    ensureLuaClient: jest.fn(async () => {}), getLuaClient: () => native as any,
    ninjaClient: { getEconomyOverview: jest.fn(async () => economy()) } as any,
  };
}
async function report(ctx: ReturnType<typeof context>, args: Record<string, unknown> = {}) {
  const result = await handleSuggestCrafting(ctx, { slot: 'weapon', base: 'Makeshift Crossbow', league, desired_mods: ['Strength'], ...args } as any);
  return result.content.map(part => part.text).join('\n');
}

describe('PoE2 crafting advisor', () => {
  let data: ReturnType<typeof useNativeCraftFixture>;
  beforeEach(() => {
    data = useNativeCraftFixture();
    data.write('Data/Essence.lua', `return {
      ["Metadata/Items/Currency/CurrencyEssenceAttribute"] = {name="Essence of the Infinite",type="Attribute",tierLevel=40,mods={["Crossbow"]="Strength2"}},
      ["Metadata/Items/Currency/CurrencyGreaterEssenceAttribute"] = {name="Greater Essence of the Infinite",type="Attribute",tierLevel=60,mods={["Crossbow"]="Strength8"}},
      ["Metadata/Items/Currency/CurrencyPerfectEssenceAttribute"] = {name="Perfect Essence of the Infinite",type="Attribute",tierLevel=72,mods={["Crossbow"]="EssenceOnly"}},
      ["Metadata/Items/Currency/CurrencyCorruptedEssenceHorror"] = {name="Essence of Horror",type="Horror",tierLevel=1,mods={["Crossbow"]="EssenceOnly"}}
    }`);
    jest.spyOn(legacyData, 'fetchBaseModData').mockRejectedValue(new Error('Legacy PoEDB must not be used in PoE2'));
  });
  afterEach(() => { jest.restoreAllMocks(); data.cleanup(); });

  it('gives source-backed base and mod eligibility without PoE1 methods or invented prices', async () => {
    const text = await report(context(), { ilvl: 20 });
    expect(text).toContain('PoE2 Crafting Advisor');
    expect(text).toContain('Crossbow');
    expect(text).toContain('Strength2');
    expect(text).toContain('ilvl 11');
    expect(text).toContain('Strength8');
    expect(text).toMatch(/requires ilvl 74/);
    expect(text).toContain('ModItem.lua');
    expect(text).toContain('sha256');
    expect(text).toContain('123.45');
    expect(text).toContain('0.2469');
    expect(text).toContain('2026-09-15T10:00:00Z');
    expect(text).not.toMatch(/fossil|resonator|bench craft|Prefixes Cannot|Suffixes Cannot|alt\/aug|Scour|Divine Orb = 200|84\+|full rare reroll/i);
    expect(legacyData.fetchBaseModData).not.toHaveBeenCalled();
  });

  it('preserves unknown item level and current mods for a base-only request', async () => {
    const text = await report(context());
    expect(text).toMatch(/Item level: unknown/i);
    expect(text).toMatch(/Rarity: unknown/i);
    expect(text).toMatch(/Current modifiers: unknown/i);
    expect(text).toMatch(/item-level eligibility.*unknown/i);
    expect(text).not.toMatch(/Expected attempts:|Estimated cost: \d|Probability: \d/);
  });

  it('requires explicit PoE1 selection before using the legacy advisor', async () => {
    delete process.env.POE_GAME;
    const text = await report(context(), { ilvl: 20 });
    expect(text).toContain('PoE2 Crafting Advisor');
    expect(text).not.toMatch(/fossil|resonator|Divine Orb = 200/i);
  });

  it('does not establish affix occupancy from duplicate supplied modifier IDs', async () => {
    const text = await report(context(), { item_rarity: 'magic', existing_mod_ids: ['Strength1', 'Strength1'], method: 'regal', ilvl: 20 });
    expect(text).toMatch(/occupancy unknown/);
    expect(text).toMatch(/Odds: unknown/);
    expect(text).not.toContain('Available under the plain-item assumptions');
  });

  it('does not identify a whole hybrid from only its first stat line', async () => {
    const text = await report(context(), { item_text: item('MAGIC', '17% increased Physical Damage'), method: 'augment' });
    expect(text).toMatch(/occupancy unknown/);
    expect(text).toMatch(/Odds: unknown/);
  });

  it('makes ambiguous and nonfinite currency valuations unknown', async () => {
    const ctx = context();
    const snapshot = economy();
    snapshot.rows[0].values.chaos = Infinity;
    snapshot.rows.push({ ...snapshot.rows[1] });
    ctx.ninjaClient.getEconomyOverview.mockResolvedValue(snapshot);
    const text = await report(ctx);
    expect(text).toContain('Divine Orb: unknown');
    expect(text).toContain('Exalted Orb: unknown');
    expect(text).not.toMatch(/Infinity|NaN/);
  });

  it('uses the unsaved selected item and weapon set with native build gaps', async () => {
    const ctx = context(nativeXml());
    const text = await report(ctx, { base: undefined });
    expect(text).toContain('Makeshift Crossbow');
    expect(text).toContain('Weapon 1 Swap');
    expect(text).toContain('+10 to Strength');
    expect(text).toContain('Strength2');
    expect(text).toContain('2502');
    expect(text).toMatch(/Chaos.*36/);
    expect(text).toContain('including unsaved selections');
    expect(text).not.toContain('Tense Crossbow');
    expect(ctx.native!.loadBuildXml).not.toHaveBeenCalled();
    expect(ctx.native!.saveBuild).not.toHaveBeenCalled();
    expect(ctx.native!.getItems).not.toHaveBeenCalled();
  });

  it('does not borrow item level, rarity or current mods when an explicit base differs', async () => {
    const text = await report(context(nativeXml()), { base: 'Tense Crossbow' });
    expect(text).toMatch(/Item level: unknown/i);
    expect(text).toMatch(/Current modifiers: unknown/i);
    expect(text).not.toContain('+10 to Strength');
  });

  it('does not fall back to a different item set when the selected ID is invalid', async () => {
    const text = await report(context(nativeXml(item(), '99')), { base: undefined });
    expect(text).toMatch(/base.*unknown|provide.*base/i);
    expect(text).not.toContain('+10 to Strength');
    expect(text).not.toContain('+7 to Strength');
  });

  it('retains useful mod and method advice when currency data is unavailable', async () => {
    const ctx = context();
    ctx.ninjaClient.getEconomyOverview.mockRejectedValue(new Error('Rate limited'));
    const text = await report(ctx, { ilvl: 20 });
    expect(text).toContain('Strength2');
    expect(text).toContain('Regal Orb');
    expect(text).toMatch(/Currency.*unknown|Prices.*unavailable/i);
    expect(text).not.toMatch(/Divine Orb = 200|estimated cost.*\d/i);
  });

  it('rejects wrong-game or wrong-league valuations', async () => {
    const ctx = context();
    ctx.ninjaClient.getEconomyOverview.mockResolvedValue({ ...economy(), provenance: { ...economy().provenance, game: 'poe1', league: 'Standard' } });
    const text = await report(ctx);
    expect(text).not.toContain('123.45');
    expect(text).toMatch(/Currency.*unknown|Prices.*unavailable/i);
  });

  it('maps standard and Greater Essences to magic-to-rare and Perfect/Corrupted to rare replacement', async () => {
    const text = await report(context(), { desired_mods: ['Strength', 'Physical Damage'], ilvl: 20 });
    expect(text).toMatch(/Essence of the Infinite.*magic.*rare/i);
    expect(text).toMatch(/Greater Essence of the Infinite.*magic.*rare/i);
    expect(text).toMatch(/Perfect Essence of the Infinite.*rare.*remove.*guaranteed/i);
    expect(text).toMatch(/Essence of Horror.*rare.*remove.*guaranteed/i);
    expect(text).not.toMatch(/essence.*normal.*magic|essence.*rerolls the item/i);
  });

  it('uses current PoE2 Chaos and Alchemy semantics', async () => {
    const text = await report(context(), { item_text: item(), method: 'alchemy' });
    expect(text).toMatch(/Alchemy.*normal or magic.*four.*replace/i);
    expect(text).toMatch(/Chaos Orb.*remove.*one.*add.*one/i);
    expect(text).not.toMatch(/chaos spam|full reroll/i);
  });

  it('preserves hybrid affix grouping and does not invent an open slot', async () => {
    const text = await report(context(), { item_text: item('MAGIC', '17% increased Physical Damage\n+18 to Accuracy Rating\n+10 to Strength') });
    expect(text).toContain('LocalIncreasedPhysicalDamagePercentAndAccuracyRating1');
    expect(text).toMatch(/Prefixes: 1.*Suffixes: 1/i);
    expect(text).toMatch(/Augmentation.*no open|augment.*ineligible/i);
  });

  it('uses the existing CoE one-step model with explicit complete affix IDs', async () => {
    const text = await report(context(), { ilvl: 20, method: 'augment', item_rarity: 'magic', existing_mod_ids: ['LocalIncreasedPhysicalDamagePercent1'] });
    expect(text).toMatch(/Probability: 40(?:\.0+)?%/);
    expect(text).toContain('4.5.5.1.5');
    expect(text).toContain('Craft of Exile');
    expect(text).toContain('estimated');
    expect(text).toMatch(/repeated attempts.*not modeled/i);
    expect(text).not.toContain('2.5 attempts');
  });

  it('does not present any-tier odds as odds for a numerical target in free text', async () => {
    const text = await report(context(), { ilvl: 20, method: 'augment', item_rarity: 'magic',
      existing_mod_ids: ['LocalIncreasedPhysicalDamagePercent1'], desired_mods: ['+(9-12) to Strength'] });
    expect(text).toMatch(/Odds: unknown/);
    expect(text).not.toMatch(/Probability: 40/);
    expect(text).toMatch(/min_tier|numeric target/i);
  });

  it('does not compute odds from an incomplete or ambiguous raw item', async () => {
    const text = await report(context(), { item_text: item('RARE', '+10 to Strength\nUnrecognized special modifier'), method: 'exalt' });
    expect(text).toMatch(/Odds: unknown/);
    expect(text).toContain('Unrecognized special modifier');
    expect(text).not.toMatch(/Probability: \d/);
  });

  it.each(['Corrupted', 'Mirrored', 'Sanctified'])('provides replacement context for %s items without modeling a plain craft', async flag => {
    const text = await report(context(), { item_text: item('RARE', '+10 to Strength', 'Makeshift Crossbow', flag), method: 'exalt', existing_mod_ids: ['Strength2'] });
    expect(text).toMatch(/Odds: unknown/);
    expect(text).toMatch(/replacement/i);
    expect(text).toContain('Strength2');
    expect(text).not.toMatch(/Probability: \d/);
  });

  it('does not treat an enchantment as a prohibition on ordinary rarity-compatible crafting', async () => {
    const text = await report(context(), { method: 'chaos', item_text:
      'Rarity: RARE\nMakeshift Crossbow\nItem Level: 20\nImplicits: 1\n{enchant}Adds 3 to 5 Fire Damage\n+10 to Strength' });
    expect(text).toMatch(/Chaos Orb:.*Available at the reported rarity/i);
    expect(text).not.toMatch(/Chaos Orb:.*Ineligible/);
    expect(text).toMatch(/Odds: unknown/);
    expect(text).toContain('[enchant]');
  });

  it('does not recommend prefix addition when the requested target group is already occupied', async () => {
    const text = await report(context(), { item_text: item(), method: 'augment' });
    expect(text).toMatch(/Strength.*occupied|occupied.*Strength/i);
    expect(text).not.toMatch(/Probability: [1-9]/);
  });

  it('reports a missing CoE cache while retaining real native mod eligibility', async () => {
    process.env.POE2_COE_BUNDLE_PATH = data.root + '/absent.json';
    const text = await report(context(), { ilvl: 20, method: 'regal', item_rarity: 'magic', existing_mod_ids: ['Strength2'] });
    expect(text).toMatch(/Odds: unknown/);
    expect(text).toContain('Strength2');
    expect(text).not.toMatch(/Probability: \d/);
  });
});
