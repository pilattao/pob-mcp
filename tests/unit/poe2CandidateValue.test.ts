import { CostBenefitAnalyzer } from '../../src/services/costBenefitAnalyzer.js';
import { ItemListing, Property } from '../../src/types/tradeTypes.js';

export function listing(id: string, amount: number | undefined = 10, currency = 'chaos', mods: string[] = []): ItemListing {
  return {
    id,
    listing: { method: 'psapi', indexed: '2026-09-15T00:00:00Z', whisper: '', account: { name: 'synthetic' },
      ...(amount === undefined ? {} : { price: { type: '~b/o', amount, currency } }) },
    item: { id, verified: true, w: 1, h: 1, icon: '', league: 'Test League', name: '',
      typeLine: 'Gold Ring', baseType: 'Gold Ring', identified: true, ilvl: 80, frameType: 2,
      explicitMods: mods, implicitMods: [], extended: { category: 'accessories', subcategories: ['ring'] } },
  };
}
export const property = (name: string, ...values: string[]): Property => ({ name, values: values.map(v => [v, 0]), displayMode: 0 });

describe('PoE2 item evidence and value', () => {
  const analyzer = new CostBenefitAnalyzer();
  it('sums unconditional signed flat mods and combined resistances without accepting percentages, conditions or minion stats', () => {
    const item = listing('evidence', 10, 'chaos', [
      '+70 to maximum Life', '15% increased maximum Life', 'Minions have +100 to maximum Life',
      '+99 to maximum Life while on Low Life', '-10% to Fire and Cold Resistances',
      '+12% to all Elemental Resistances', '+3% to all Resistances', '+20% to Lightning Resistance',
      '+100% to Fire Resistance while stationary', '+5% to maximum Fire Resistance',
      '+8 to Strength and Dexterity', '+4 to all Attributes',
    ]);
    item.item.implicitMods = ['+10 to maximum Life'];
    item.item.craftedMods = ['+5 to maximum Life'];
    item.item.fracturedMods = ['+15% to Chaos Resistance'];
    expect(analyzer.analyzeItem(item).stats).toMatchObject({ life: 85, fireResist: 5, coldResist: 5,
      lightningResist: 35, chaosResist: 18, totalResist: 63, strength: 12, dexterity: 12, intelligence: 4 });
  });

  it('uses displayed defense totals instead of adding local mods a second time', () => {
    const item = listing('defence', 10, 'chaos', ['+30 to maximum Energy Shield', '100% increased Energy Shield', '+100 to Armour']);
    item.item.properties = [property('Energy Shield', '180'), property('Armour', '1,200'), property('Evasion Rating', '250')];
    expect(analyzer.analyzeItem(item).stats).toMatchObject({ es: 180, armour: 1200, evasion: 250 });
  });

  it('extracts displayed Spirit and Runic Ward and counts rune sockets without jewel sockets', () => {
    const item = listing('spirit-ward', 10, 'chaos', ['+25 to Spirit', '+30 to Ward', '100% increased Ward']);
    item.item.properties = [property('[Spirit|Spirit]', '140'), property('[Ward|Runic Ward]', '260')];
    item.item.sockets = [{ type: 'rune', group: 0 }, { type: 'jewel', group: 1 }, { group: 2 }] as any;
    const result = analyzer.analyzeItem(item);
    expect(result.stats).toMatchObject({ spirit: 140, ward: 260, runeSockets: 2 });
    expect(result.knownStats).toEqual(expect.arrayContaining(['spirit', 'ward', 'runeSockets']));
  });

  it('keeps missing or malformed Spirit, Ward and socket evidence unknown', () => {
    const item = listing('missing', 10, 'chaos', ['+100 to Spirit', '+100 to Ward']);
    item.item.properties = [property('Spirit', 'unavailable'), property('Runic Ward', '-1')];
    item.item.sockets = [null] as any;
    const result = analyzer.analyzeItem(item);
    for (const key of ['spirit', 'ward', 'runeSockets']) expect(Reflect.get(result.stats, key)).toBeUndefined();
    expect(result.knownStats).not.toEqual(expect.arrayContaining(['spirit']));
    expect(result.knownStats).not.toEqual(expect.arrayContaining(['ward']));
    expect(result.knownStats).not.toEqual(expect.arrayContaining(['runeSockets']));
  });

  it('reads real-shaped PoE2 modifier objects and flat Spirit without using maximum-quality indexed defenses', () => {
    const row = listing('object-mods');
    row.item.explicitMods = [
      { description: '+41 to [Spirit|Spirit]', domain: 'explicit', hash: 'stat.explicit.stat_3981240776' },
      { description: '+18 to maximum Life', domain: 'explicit' },
      { description: '+24% to [Resistances|Cold Resistance]', domain: 'explicit' },
    ] as any;
    (row.item as any).runeMods = [
      { description: '+18% to [Resistances|Cold Resistance]', domain: 'rune' },
      { description: '[ShamanOnlyMods|Bonded]: +40 to maximum Life', domain: 'rune' },
    ];
    row.item.properties = [property('[EnergyShield|Energy Shield]', '104'), property('[Ward|Runic Ward]', '87')];
    row.item.extended = { es: 124, ward: 104 } as any;
    const result = analyzer.analyzeItem(row);
    expect(result.stats).toMatchObject({ spirit: 41, life: 18, coldResist: 42, es: 104, ward: 87 });
    expect(result.knownStats).toContain('spirit');
    expect(result.unparsedMods).toContain('Bonded: +40 to maximum Life');
  });

  it('uses flat Spirit only when a displayed Spirit property is absent and ignores conditional Spirit', () => {
    const row = listing('spirit-mods', 10, 'chaos', ['+40 to Spirit', '+80 to Spirit while on Full Life']);
    row.item.implicitMods = ['+10 to Spirit'];
    expect(analyzer.analyzeItem(row).stats.spirit).toBe(50);
    row.item.properties = [property('Spirit', '150')];
    expect(analyzer.analyzeItem(row).stats.spirit).toBe(150);
  });

  it('computes only displayed weapon DPS with all elemental ranges and order-independent attack speed', () => {
    const item = listing('weapon', 10, 'chaos', ['Adds 10 to 20 Fire Damage', 'Adds 100 to 200 Cold Damage to Spells']);
    item.item.properties = [property('Physical Damage', '100-200'), property('Elemental Damage', '10-20', '30-50'), property('Attacks per Second', '2.00')];
    expect(analyzer.analyzeItem(item).stats).toMatchObject({ physicalDPS: 300, elementalDPS: 110, totalDPS: 410 });
    expect(analyzer.formatAnalysis(analyzer.analyzeItem(item))).toMatch(/weapon DPS/i);
  });

  it('leaves weapon DPS unknown without attack speed or when only added spell mods exist', () => {
    const item = listing('unknown', 10, 'chaos', ['Adds 100 to 200 Fire Damage to Spells']);
    item.item.properties = [property('Physical Damage', '100-200')];
    expect(analyzer.analyzeItem(item).stats.totalDPS).toBeUndefined();
  });

  it('converts real league rates and aliases without hardcoded market rates', () => {
    const rates = new Map([['Divine Orb', 200], ['Exalted Orb', 2]]);
    expect(analyzer.analyzeItem(listing('divine', 0.5, 'divine'), rates).priceInChaos).toBe(100);
    expect(analyzer.analyzeItem(listing('exalt', 10, 'exa'), rates).priceInChaos).toBe(20);
    expect(analyzer.analyzeItem(listing('unknown', 1, 'divine')).priceInChaos).toBeUndefined();
  });

  it.each([undefined, 0, -1, NaN, Infinity])('does not turn missing or invalid price %s into free value', amount => {
    const item = listing('unpriced', 10, 'chaos', ['+100 to maximum Life']);
    if (amount === undefined) delete item.listing.price; else item.listing.price!.amount = amount;
    const result = analyzer.analyzeItem(item);
    expect(result.priceInChaos).toBeUndefined();
    expect(result.metrics.lifePerChaos).toBeUndefined();
    expect(result.metrics.valueScore).toBeUndefined();
    expect(result.metrics.isBudgetPick).toBe(false);
    expect(result.metrics.warnings.join(' ')).toMatch(/price/i);
    expect(analyzer.formatAnalysis(result)).toMatch(/unavailable/i);
  });

  it('ranks equivalent currency prices equally and unconvertible prices after known prices', () => {
    const mods = ['+80 to maximum Life'];
    const result = analyzer.analyzeAndRank([
      listing('unknown', 1, 'unquoted', mods), listing('expensive', 1, 'divine', mods),
      listing('cheap', 10, 'chaos', mods), listing('equivalent', 5, 'exa', mods),
    ], new Map([['Divine Orb', 200], ['Exalted Orb', 2]]));
    expect(result.map(r => r.listing.id)).toEqual(['cheap', 'equivalent', 'expensive', 'unknown']);
    expect(result[0].metrics.valueScore).toBe(result[1].metrics.valueScore);
  });

  it('does not fabricate EHP or whole-build conclusions from raw item stats', () => {
    const result = analyzer.analyzeItem(listing('item', 10, 'chaos', ['+80 to maximum Life']));
    expect(result.metrics.ehpPerChaos).toBeUndefined();
    expect(analyzer.formatAnalysis(result)).toMatch(/native.*calculat/i);
    expect(analyzer.formatAnalysis(result)).not.toMatch(/poor survivability|EHP per chaos/i);
  });

  it.each([0, -1, NaN, Infinity])('does not manufacture an exchange rate from invalid quote %s', rate => {
    expect(analyzer.analyzeItem(listing('bad-rate', 1, 'divine'), new Map([['Divine Orb', rate]])).priceInChaos).toBeUndefined();
  });

  it('does not merge contradictory alias quotes or overflow converted prices', () => {
    expect(analyzer.analyzeItem(listing('conflict', 1, 'divine'), new Map([['Divine Orb', 200], ['div', 100]])).priceInChaos).toBeUndefined();
    expect(analyzer.analyzeItem(listing('overflow', 1e308, 'divine'), new Map([['Divine Orb', 200]])).priceInChaos).toBeUndefined();
  });

  it('retains raw item evidence when a price has no conversion', () => {
    const result = analyzer.analyzeItem(listing('unknown', 1, 'new-currency', ['+85 to maximum Life']));
    expect(result.stats.life).toBe(85);
    expect(result.priceEvidence).toMatchObject({ amount: 1, currency: 'new-currency', status: 'missing-rate' });
    expect(result.metrics.valueTier).toBe('unknown');
    expect(result.rank).toBeUndefined();
  });

  it('leaves value unknown when all item-stat data are absent', () => {
    const item = listing('no-data'); delete item.item.explicitMods; delete item.item.implicitMods;
    const result = analyzer.analyzeItem(item);
    expect(result.knownStats).toEqual([]);
    expect(result.metrics.valueScore).toBeUndefined();
  });

  it('prefers cheaper equivalent evidence after the heuristic saturates', () => {
    const result = analyzer.analyzeAndRank([listing('expensive', 2, 'chaos', ['+100 to maximum Life']), listing('cheap', 1, 'chaos', ['+100 to maximum Life'])]);
    expect(result.map(r => r.listing.id)).toEqual(['cheap', 'expensive']);
  });
});
