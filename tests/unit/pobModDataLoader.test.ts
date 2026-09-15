import { useLegacyCraftFixture } from '../fixtures/coreCraftLegacy';
let legacy: ReturnType<typeof useLegacyCraftFixture>;
beforeAll(() => { legacy = useLegacyCraftFixture(); });
afterAll(() => legacy.cleanup());
import { describe, it, expect, beforeAll, afterAll } from '@jest/globals';

import {
  ensureLoaded,
  getMod,
  getModCount,
  getModGroup,
  matchStatLine,
  normalizeStatLine,
  parseRolledValues,
  parseTemplateRanges,
  resolveWeightForTag,
  resolveWeightForTags,
  rolledValuesFitTemplate,
  searchMods,
} from '../../src/services/pobModDataLoader';


describe('pobModDataLoader', () => {
  it('parses every entry in the coherent PoE1 fixture', () => {
    ensureLoaded();
    expect(getModCount()).toBe(18);
  });

  it('returns null for an unknown mod ID', () => {
    expect(getMod('NotARealModId__')).toBeNull();
  });

  it('returns Strength1 with expected shape', () => {
    const m = getMod('Strength1');
    expect(m).not.toBeNull();
    if (!m) return;
    expect(m.type).toBe('Suffix');
    expect(m.affix).toBe('of the Brute');
    expect(m.level).toBe(1);
    expect(m.group).toBe('Strength');
    expect(m.statLines.length).toBeGreaterThan(0);
    expect(m.statLines[0]).toMatch(/Strength/);
    expect(m.modTags).toContain('attribute');
    expect(m.weights.length).toBeGreaterThan(0);
  });

  it('returns a multi-stat mod with all stat lines preserved', () => {
    // IncreasedLifeEnhancedMod has two stat lines (life flat + life percent)
    const m = getMod('IncreasedLifeEnhancedMod');
    expect(m).not.toBeNull();
    if (!m) return;
    expect(m.statLines.length).toBe(2);
    expect(m.statLines[0]).toMatch(/maximum Life/);
    expect(m.statLines[1]).toMatch(/increased maximum Life/);
  });

  it('groups mods by their group field', () => {
    const lifeGroup = getModGroup('IncreasedLife');
    expect(lifeGroup.map(m => m.id)).toEqual(['IncreasedLife1', 'IncreasedLife6', 'IncreasedLife11', 'IncreasedLife12', 'GreedEssence7']);
    expect(lifeGroup.every((m) => m.group === 'IncreasedLife')).toBe(true);
  });

  it('resolveWeightForTag returns the explicit tag weight when present', () => {
    const m = getMod('Strength1');
    expect(m).not.toBeNull();
    if (!m) return;
    expect(resolveWeightForTag(m, 'ring')).toBe(1000);
  });

  it('resolveWeightForTag falls through to default when tag is absent', () => {
    // IncreasedLife6 has weightKey { fishing_rod, weapon, default } with weights { 0, 0, 1000 }.
    // Querying for "body_armour" should fall through to default (1000).
    const m = getMod('IncreasedLife6');
    expect(m).not.toBeNull();
    if (!m) return;
    expect(resolveWeightForTag(m, 'body_armour')).toBe(1000);
  });

  it('resolveWeightForTags walks the weights and matches any input tag', () => {
    // FireResist mods list "armour" (parent tag) — a body_armour base should
    // match via the "armour" entry when both are supplied.
    const m = getMod('FireResist6');
    expect(m).not.toBeNull();
    if (!m) return;
    expect(resolveWeightForTags(m, ['body_armour'])).toBe(0); // would miss; default=0
    expect(resolveWeightForTags(m, ['body_armour', 'armour'])).toBe(1000);
  });

  describe('searchMods', () => {
    it('filters by stat substring (case-insensitive)', () => {
      const hits = searchMods({ statContains: 'fire resistance', limit: 20 });
      expect(hits.length).toBeGreaterThan(0);
      expect(
        hits.every((m) => m.statLines.some((s) => /fire resistance/i.test(s)))
      ).toBe(true);
    });

    it('filters by type Prefix/Suffix', () => {
      const prefixes = searchMods({ statContains: 'maximum Life', type: 'Prefix', limit: 50 });
      expect(prefixes.length).toBeGreaterThan(0);
      expect(prefixes.every((m) => m.type === 'Prefix')).toBe(true);
    });

    it('filters by min/max level', () => {
      const hits = searchMods({
        statContains: 'maximum Life',
        minLevel: 70,
        maxLevel: 80,
        type: 'Prefix',
        limit: 50,
      });
      expect(hits.length).toBeGreaterThan(0);
      expect(hits.every((m) => m.level >= 70 && m.level <= 80)).toBe(true);
    });

    it('filters by item-tag chain (Astral Plate)', () => {
      // Astral Plate carries ["body_armour","armour","str_armour"] in PoE's
      // base-item data. Fire Resistance mods list "armour" not "body_armour"
      // — single-tag filtering misses; multi-tag should not.
      const tags = ['body_armour', 'armour', 'str_armour'];
      const hits = searchMods({
        statContains: 'Fire Resistance',
        itemTags: tags,
        type: 'Suffix',
        limit: 20,
      });
      expect(hits.length).toBeGreaterThan(0);
      expect(hits.every((m) => resolveWeightForTags(m, tags) > 0)).toBe(true);
    });

    it('filters by mod group', () => {
      const hits = searchMods({ group: 'IncreasedLife', limit: 200 });
      expect(hits).toHaveLength(5);
      expect(hits.every((m) => m.group === 'IncreasedLife')).toBe(true);
    });

    it('filters by hasTags (all tags must be present)', () => {
      const hits = searchMods({ hasTags: ['attribute'], limit: 100 });
      expect(hits.length).toBeGreaterThan(0);
      expect(hits.every((m) => m.modTags.includes('attribute'))).toBe(true);
    });

    it('honours the limit parameter', () => {
      const hits = searchMods({ statContains: 'Life', limit: 5 });
      expect(hits.length).toBeLessThanOrEqual(5);
    });

    it('limit=0 disables the cap (results may be large)', () => {
      const capped = searchMods({ group: 'IncreasedLife', limit: 2 });
      const all = searchMods({ group: 'IncreasedLife', limit: 0 });
      expect(all.length).toBeGreaterThan(capped.length);
    });

    it('returns empty when no mod matches the filters', () => {
      const hits = searchMods({ statContains: 'definitely-not-a-real-stat-text', limit: 10 });
      expect(hits).toEqual([]);
    });
  });

  describe('matchStatLine', () => {
    const armourBodyTags = ['body_armour', 'armour', 'str_armour'];

    it('identifies a flat life roll to its specific tier', () => {
      const r = matchStatLine('+150 to maximum Life', { itemTags: armourBodyTags, ilvl: 86 });
      expect(r.best).not.toBeNull();
      expect(r.best?.group).toBe('IncreasedLife');
      // +150 falls in the (145-159) tier
      expect(r.best?.statLines[0]).toMatch(/145-159/);
      expect(r.tier).toBeGreaterThanOrEqual(1);
      expect(r.tierMax).toBeGreaterThan(r.tier!);
      expect(r.nextTier).toBeDefined();
      expect(r.nextTier!.level).toBeGreaterThan(r.best!.level);
    });

    it('selects the tier whose range contains the rolled value', () => {
      const low = matchStatLine('+15 to maximum Life', { itemTags: armourBodyTags });
      const high = matchStatLine('+150 to maximum Life', { itemTags: armourBodyTags });
      expect(low.best?.level).toBeLessThan(high.best!.level);
    });

    it('reports top tier with no next-tier upgrade', () => {
      const r = matchStatLine('+48% to Fire Resistance', { itemTags: armourBodyTags, ilvl: 86 });
      expect(r.best?.group).toBe('FireResistance');
      expect(r.tier).toBe(1);
      expect(r.nextTier).toBeUndefined();
    });

    it('prefers affixed mods over empty-affix (Hellscape/implicit) entries', () => {
      const r = matchStatLine('+25% to Fire Resistance', { itemTags: armourBodyTags, ilvl: 86 });
      expect(r.best?.affix).toBeTruthy();
      expect(r.best?.affix.length).toBeGreaterThan(0);
    });

    it('returns best=null for text that matches no template', () => {
      const r = matchStatLine('Florble gnarp wibble zonk quux');
      expect(r.candidates.length).toBe(0);
      expect(r.best).toBeNull();
      expect(r.meaningfulCandidateCount).toBe(0);
    });

    it('matches multi-value mods (Adds X to Y Physical Damage)', () => {
      const r = matchStatLine('Adds 5 to 9 Physical Damage to Attacks', { itemTags: ['ring'], ilvl: 80 });
      expect(r.best).not.toBeNull();
      expect(r.best?.group).toMatch(/Physical/i);
    });
  });
});

// These are pure functions — no PoB data required, so always run.
describe('pobModDataLoader pure helpers', () => {
  describe('normalizeStatLine', () => {
    it('replaces ranges and bare numbers with #', () => {
      expect(normalizeStatLine('+(8-12) to Strength')).toBe('+# to strength');
      expect(normalizeStatLine('+10 to Strength')).toBe('+# to strength');
    });

    it('normalizes multi-value templates and rolls to the same key', () => {
      const tpl = normalizeStatLine('Adds (2-3) to (4-5) Physical Damage to Attacks');
      const rolled = normalizeStatLine('Adds 7 to 12 Physical Damage to Attacks');
      expect(tpl).toBe(rolled);
    });

    it('handles decimals', () => {
      expect(normalizeStatLine('Regenerate 12.5 Life per second')).toBe('regenerate # life per second');
    });

    it('preserves the +/% structure that distinguishes mods', () => {
      // flat life has +, increased life has % — must NOT normalize to the same key
      expect(normalizeStatLine('+105 to maximum Life')).not.toBe(
        normalizeStatLine('105% increased maximum Life')
      );
    });
  });

  describe('parseRolledValues', () => {
    it('extracts the rolled numbers', () => {
      expect(parseRolledValues('+150 to maximum Life')).toEqual([150]);
      expect(parseRolledValues('Adds 7 to 12 Physical Damage')).toEqual([7, 12]);
    });

    it('ignores parenthesized ranges if present', () => {
      expect(parseRolledValues('+(8-12) to Strength')).toEqual([]);
    });
  });

  describe('parseTemplateRanges', () => {
    it('parses a single range', () => {
      expect(parseTemplateRanges('+(145-159) to maximum Life')).toEqual([{ min: 145, max: 159 }]);
    });

    it('parses multiple ranges in order', () => {
      expect(parseTemplateRanges('Adds (2-3) to (4-5) Physical Damage')).toEqual([
        { min: 2, max: 3 },
        { min: 4, max: 5 },
      ]);
    });

    it('treats bare numbers as fixed-value ranges', () => {
      expect(parseTemplateRanges('Adds 1 to 2 Physical Damage')).toEqual([
        { min: 1, max: 1 },
        { min: 2, max: 2 },
      ]);
    });
  });

  describe('rolledValuesFitTemplate', () => {
    it('returns true when value falls in range', () => {
      expect(rolledValuesFitTemplate([150], '+(145-159) to maximum Life')).toBe(true);
    });

    it('returns false when value is out of range', () => {
      expect(rolledValuesFitTemplate([200], '+(145-159) to maximum Life')).toBe(false);
    });

    it('returns false on arity mismatch', () => {
      expect(rolledValuesFitTemplate([5], 'Adds (2-3) to (4-5) Physical Damage')).toBe(false);
    });

    it('checks each value against its own range', () => {
      expect(rolledValuesFitTemplate([2, 5], 'Adds (2-3) to (4-5) Physical Damage')).toBe(true);
      expect(rolledValuesFitTemplate([2, 9], 'Adds (2-3) to (4-5) Physical Damage')).toBe(false);
    });
  });
});
