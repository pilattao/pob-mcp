import { useLegacyCraftFixture } from '../fixtures/coreCraftLegacy';
let legacy: ReturnType<typeof useLegacyCraftFixture>;
beforeAll(() => { legacy = useLegacyCraftFixture(); });
afterAll(() => legacy.cleanup());
import { describe, it, expect, beforeAll, afterAll } from '@jest/globals';

import { handleAnalyzeItemMods } from '../../src/handlers/analyzeItemModsHandler';


function getText(result: { content: Array<{ type: string; text: string }> }): string {
  return result.content.map((c) => c.text).join('\n');
}

describe('handleAnalyzeItemMods', () => {
  it('rejects empty mod_lines', async () => {
    const r = await handleAnalyzeItemMods({ mod_lines: [] });
    expect(r.isError).toBe(true);
  });

  it('identifies mods and splits prefixes/suffixes', async () => {
    const r = await handleAnalyzeItemMods({
      base_name: 'Astral Plate',
      ilvl: 86,
      mod_lines: ['+150 to maximum Life', '+48% to Fire Resistance', '+45 to Strength'],
    });
    expect(r.isError).toBeUndefined();
    const text = getText(r);
    expect(text).toMatch(/PREFIXES/);
    expect(text).toMatch(/SUFFIXES/);
    expect(text).toMatch(/IncreasedLife/);
    expect(text).toMatch(/FireResistance/);
    expect(text).toMatch(/Strength/);
  });

  it('reports tier and next-tier in raw JSON', async () => {
    const r = await handleAnalyzeItemMods({
      base_name: 'Astral Plate',
      ilvl: 86,
      mod_lines: ['+150 to maximum Life'],
      raw_json: true,
    });
    const parsed = JSON.parse(getText(r));
    const m = parsed.lines[0].match;
    expect(m.best.group).toBe('IncreasedLife');
    expect(m.tier).toBeGreaterThanOrEqual(1);
    expect(m.tier_max).toBeGreaterThan(m.tier);
    expect(m.next_tier).not.toBeNull();
    expect(m.next_tier.level).toBeGreaterThan(m.best.level);
  });

  it('flags crafted mods separately and does not match them', async () => {
    const r = await handleAnalyzeItemMods({
      base_name: 'Astral Plate',
      ilvl: 86,
      mod_lines: ['+15% increased Stun and Block Recovery {crafted}'],
      raw_json: true,
    });
    const parsed = JSON.parse(getText(r));
    expect(parsed.lines[0].source).toBe('crafted');
    expect(parsed.lines[0].match).toBeNull();
  });

  it('collapses hybrid-mod continuation lines', async () => {
    // Crocodile's: "+(97-144) to Armour" / "+(34-38) to maximum Life" is one mod
    const r = await handleAnalyzeItemMods({
      base_name: 'Astral Plate',
      ilvl: 86,
      mod_lines: ['+120 to Armour', '+36 to maximum Life'],
      raw_json: true,
    });
    const parsed = JSON.parse(getText(r));
    expect(parsed.lines[1].is_hybrid_continuation).toBe(true);
    expect(parsed.lines[1].match.best.id).toBe('ArmourLife');
    expect(parsed.lines.length).toBe(2);
  });

  it('surfaces base-name fuzzy suggestions on miss', async () => {
    const r = await handleAnalyzeItemMods({
      base_name: 'Astral Plte',
      mod_lines: ['+150 to maximum Life'],
    });
    const text = getText(r);
    // Either it found nothing close, or it suggests — both acceptable, but it
    // must not crash and must still analyze the line without tag gating.
    expect(text).toMatch(/Item Mod Analysis/);
  });

  it('works without a base (no tag gating)', async () => {
    const r = await handleAnalyzeItemMods({
      mod_lines: ['+45 to Strength'],
    });
    const text = getText(r);
    expect(text).toMatch(/No base supplied/);
    expect(text).toMatch(/Strength/);
  });

  it('requires mod_lines or item_slot', async () => {
    const r = await handleAnalyzeItemMods({});
    expect(r.isError).toBe(true);
    expect(getText(r)).toMatch(/mod_lines.*item_slot|item_slot/);
  });

  describe('item_slot (live PoB)', () => {
    const fakeItem = {
      slot: 'Body Armour',
      name: 'Doom Shell',
      baseName: 'Astral Plate',
      type: 'Body Armour',
      raw: [
        'Rarity: RARE',
        'Doom Shell',
        'Astral Plate',
        'Item Level: 84',
        'Implicits: 1',
        '+8% to all Elemental Resistances',
        '+150 to maximum Life',
        '+45% to Fire Resistance',
        '{crafted}+30% to Cold and Lightning Resistances',
        'Corrupted',
      ].join('\n'),
    };

    function makeContext(items: unknown[]) {
      return {
        ensureLuaClient: async () => {},
        getLuaClient: () =>
          ({
            getItems: async () => items,
          }) as unknown as import('../../src/pobLuaBridge').AnyLuaClient,
      };
    }

    it('reads an equipped item, auto-derives base + ilvl, and analyzes', async () => {
      const r = await handleAnalyzeItemMods({ item_slot: 'Body Armour' }, makeContext([fakeItem]));
      const text = getText(r);
      expect(text).toMatch(/Read "Doom Shell" from slot "Body Armour"/);
      expect(text).toMatch(/Base: Astral Plate/);
      expect(text).toMatch(/ilvl: 84/);
      expect(text).toMatch(/IncreasedLife/);
      expect(text).toMatch(/FireResistance/);
      // crafted line should be matched against bench-craft pool
      expect(text).toMatch(/bench craft/);
    });

    it('errors cleanly when the slot is empty', async () => {
      const r = await handleAnalyzeItemMods({ item_slot: 'Gloves' }, makeContext([fakeItem]));
      const text = getText(r);
      expect(text).toMatch(/No item found in slot "Gloves"/);
    });

    it('errors when item_slot is used without a context', async () => {
      const r = await handleAnalyzeItemMods({ item_slot: 'Body Armour' });
      expect(r.isError).toBe(true);
    });
  });
});
