import { convertTradeItemForPob } from '../../src/services/tradeItemConversion.js';

const item = (): any => ({ id: 'trade-item', name: 'Actual Rare', typeLine: 'Rattling Sceptre', baseType: 'Rattling Sceptre',
  frameType: 2, identified: true, ilvl: 80, corrupted: true, properties: [
    { name: 'Quality', values: [['+17%', 1]] }, { name: 'Spirit', values: [['100', 1]] },
  ], requirements: [{ name: 'Level', values: [['74', 0]] }],
  sockets: [{ type: 'rune' }, { type: 'rune' }], socketedItems: [{ socket: 1, baseType: 'Iron Rune' }],
  runeMods: ['25% increased Spell Damage'], implicitMods: ['+10 to [Strength]'],
  explicitMods: [{ description: '+80 to maximum [Life]', flags: { fractured: true } }, '50% increased Spell Damage'],
  craftedMods: ['+12% to Fire Resistance'], enchantMods: ['10% increased Mana Regeneration Rate'],
});

describe('PoE2 trade item to native item conversion', () => {
  it('preserves exact mods, flags, rune positions, corruption, quality and required level', () => {
    const source = item(), before = JSON.stringify(source);
    const converted = convertTradeItemForPob(source);
    expect(converted.complete).toBe(true);
    expect(converted.text).toContain('Quality: 17');
    expect(converted.text).toContain('LevelReq: 74');
    expect(converted.text).toContain('Item Level: 80');
    expect(converted.text).toContain('Rune: None\nRune: Iron Rune');
    expect(converted.text).toContain('{fractured}+80 to maximum Life');
    expect(converted.text).toContain('{crafted}+12% to Fire Resistance');
    expect(converted.text).toContain('{enchant}{rune}25% increased Spell Damage');
    expect(converted.text).toContain('Corrupted');
    expect(converted.expected).toMatchObject({ quality: 17, requiredLevel: 74, corrupted: true, socketCount: 2 });
    expect(JSON.stringify(source)).toBe(before);
  });
  it('changes candidate identity when any full item evidence changes', () => {
    const first = item(), next = item(); next.explicitMods[1] = '51% increased Spell Damage';
    expect(convertTradeItemForPob(first).identity).not.toBe(convertTradeItemForPob(next).identity);
  });
  it('preserves the real trade granted-skill string and its exact native skill name', () => {
    const source = item();
    source.grantedSkills = [{ name: 'Grants Skill', values: [['Level 18 Lightning Bolt', 25]] }];
    const converted = convertTradeItemForPob(source);
    expect(converted.complete).toBe(true);
    expect(converted.text).toContain('Grants Skill: Level 18 Lightning Bolt');
  });
  it.each(['unidentified', 'unknown-socket', 'missing-runes', 'unknown-mods', 'invalid-quality'])('keeps %s conversions incomplete', kind => {
    const source = item();
    if (kind === 'unidentified') source.identified = false;
    if (kind === 'unknown-socket') source.sockets[0].type = 'mystery';
    if (kind === 'missing-runes') delete source.socketedItems;
    if (kind === 'unknown-mods') source.unknownMods = ['a real effect the converter cannot preserve'];
    if (kind === 'invalid-quality') source.properties[0].values[0][0] = 'unknown';
    const result = convertTradeItemForPob(source);
    expect(result.complete).toBe(false);
    expect(result.text).toBeUndefined();
    expect(result.errors.length).toBeGreaterThan(0);
  });
  it('does not invent quality or a required level when fields are absent', () => {
    const source = item(); source.properties = []; source.requirements = [];
    const converted = convertTradeItemForPob(source);
    expect(converted.text).not.toMatch(/Quality:|LevelReq:/);
    expect(converted.expected.quality).toBeUndefined();
    expect(converted.expected.requiredLevel).toBeUndefined();
  });
  it('reports malformed trade arrays as incomplete conversion instead of throwing', () => {
    const source = item(); source.grantedSkills = {};
    const converted = convertTradeItemForPob(source);
    expect(converted.complete).toBe(false);
    expect(converted.text).toBeUndefined();
  });
});
