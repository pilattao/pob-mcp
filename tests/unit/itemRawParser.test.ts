import { describe, it, expect } from '@jest/globals';
import { parseItemRawMods, parseItemLevel } from '../../src/utils/itemRawParser';

// A representative PoB raw item block (Body Armour with mixed mod sources).
const RAW = `Rarity: RARE
Doom Shell
Astral Plate
Item Level: 84
Implicits: 1
+8% to all Elemental Resistances
+120 to maximum Life
+45% to Fire Resistance
{crafted}+15% to Cold and Lightning Resistances
{fractured}+30 to Strength
Corrupted`;

describe('parseItemRawMods', () => {
  it('counts granted skills inside PoE2 implicits instead of consuming an explicit modifier', () => {
    const mods = parseItemRawMods('Rarity: RARE\nTest Staff\nParalysing Staff\nImplicits: 2\n{enchant}{rune}+1 to Level of all Spell Skills\nGrants Skill: Level 17 Enervating Nova\nGain 58% of Damage as Extra Cold Damage');
    expect(mods.find(m => m.line === 'Grants Skill: Level 17 Enervating Nova')?.type).toBe('implicit');
    expect(mods.find(m => m.line === 'Gain 58% of Damage as Extra Cold Damage')?.type).toBe('explicit');
    expect(mods[0].type).toBe('enchant');
  });

  it('preserves bonded and desecrated modifiers and skips the sanctified state marker', () => {
    const mods = parseItemRawMods('Implicits: 1\nBonded: +20 to maximum Life\n{desecrated}+30 to Spirit\nSanctified');
    expect(mods).toEqual([{ line: 'Bonded: +20 to maximum Life', type: 'implicit' }, { line: '+30 to Spirit', type: 'desecrated' }]);
  });
  it('separates implicit from explicit mods', () => {
    const mods = parseItemRawMods(RAW);
    const implicit = mods.filter((m) => m.type === 'implicit');
    expect(implicit.length).toBe(1);
    expect(implicit[0].line).toMatch(/all Elemental Resistances/);
  });

  it('tags crafted and fractured mods', () => {
    const mods = parseItemRawMods(RAW);
    const crafted = mods.find((m) => m.type === 'crafted');
    const fractured = mods.find((m) => m.type === 'fractured');
    expect(crafted?.line).toMatch(/Cold and Lightning Resistances/);
    expect(fractured?.line).toMatch(/to Strength/);
  });

  it('strips {tag} markers from display text', () => {
    const mods = parseItemRawMods(RAW);
    expect(mods.every((m) => !m.line.includes('{'))).toBe(true);
  });

  it('skips trailer lines like Corrupted', () => {
    const mods = parseItemRawMods(RAW);
    expect(mods.every((m) => m.line !== 'Corrupted')).toBe(true);
  });

  it('returns empty for undefined/empty raw', () => {
    expect(parseItemRawMods(undefined)).toEqual([]);
    expect(parseItemRawMods('')).toEqual([]);
  });
});

describe('parseItemLevel', () => {
  it('extracts the item level', () => {
    expect(parseItemLevel(RAW)).toBe(84);
  });

  it('returns undefined when absent', () => {
    expect(parseItemLevel('Rarity: RARE\nSome Item')).toBeUndefined();
  });
});
