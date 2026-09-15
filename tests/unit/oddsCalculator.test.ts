import { useLegacyCraftFixture } from '../fixtures/coreCraftLegacy';
let legacy: ReturnType<typeof useLegacyCraftFixture>;
beforeAll(() => { legacy = useLegacyCraftFixture(); });
afterAll(() => legacy.cleanup());
import { describe, it, expect, beforeAll, afterAll } from '@jest/globals';
import { probAllTargetsDrawn, buildEligiblePool } from '../../src/services/oddsCalculator';
import { getBase, ensureBasesLoaded } from '../../src/services/pobBaseDataLoader';
import { ensureLoaded } from '../../src/services/pobModDataLoader';

// --- Pure probability function: hand-computable cases (no PoB data) ---
describe('probAllTargetsDrawn (pure)', () => {
  it('single target, K=1: P = weight share', () => {
    const groups = [
      { id: 'a', weight: 1 },
      { id: 'b', weight: 3 },
    ];
    // P(a in 1 draw) = 1/4
    expect(probAllTargetsDrawn(groups, ['a'], 1)).toBeCloseTo(0.25, 10);
    expect(probAllTargetsDrawn(groups, ['b'], 1)).toBeCloseTo(0.75, 10);
  });

  it('equal weights reduce to hypergeometric K/n', () => {
    const groups = [
      { id: 'a', weight: 1 },
      { id: 'b', weight: 1 },
      { id: 'c', weight: 1 },
    ];
    // P(specific item in sample of 2 from 3) = 2/3
    expect(probAllTargetsDrawn(groups, ['a'], 2)).toBeCloseTo(2 / 3, 10);
  });

  it('two targets in K=2 from 3 equal groups = both must be the 2 drawn', () => {
    const groups = [
      { id: 'a', weight: 1 },
      { id: 'b', weight: 1 },
      { id: 'c', weight: 1 },
    ];
    // Only one of the 3 unordered pairs is {a,b}; P = 1/3
    expect(probAllTargetsDrawn(groups, ['a', 'b'], 2)).toBeCloseTo(1 / 3, 10);
  });

  it('weighted two-target case computed by hand', () => {
    // groups a=2, b=3, c=5 (total 10). P(a and b both in 2 draws):
    // order a,b: (2/10)*(3/8)=6/80; order b,a: (3/10)*(2/7)=6/70
    // sum = 0.075 + 0.0857142857 = 0.1607142857
    const groups = [
      { id: 'a', weight: 2 },
      { id: 'b', weight: 3 },
      { id: 'c', weight: 5 },
    ];
    expect(probAllTargetsDrawn(groups, ['a', 'b'], 2)).toBeCloseTo(0.16071428571, 8);
  });

  it('returns 0 when more targets than draws', () => {
    const groups = [{ id: 'a', weight: 1 }, { id: 'b', weight: 1 }];
    expect(probAllTargetsDrawn(groups, ['a', 'b'], 1)).toBe(0);
  });

  it('returns 0 when a target is not in the pool', () => {
    const groups = [{ id: 'a', weight: 1 }];
    expect(probAllTargetsDrawn(groups, ['z'], 1)).toBe(0);
  });

  it('returns 1 when no targets required', () => {
    const groups = [{ id: 'a', weight: 1 }];
    expect(probAllTargetsDrawn(groups, [], 1)).toBe(1);
  });

  it('K >= n still works (all groups drawn)', () => {
    const groups = [{ id: 'a', weight: 1 }, { id: 'b', weight: 2 }];
    expect(probAllTargetsDrawn(groups, ['a', 'b'], 2)).toBeCloseTo(1, 10);
  });
});

// --- Pool builder: needs PoB submodule ---

describe('buildEligiblePool', () => {
  it('builds prefix/suffix groups for a base at ilvl', () => {
    ensureLoaded();
    ensureBasesLoaded();
    const base = getBase('Astral Plate');
    expect(base).not.toBeNull();
    if (!base) return;
    const pool = buildEligiblePool(base, 86);
    expect(pool.prefixes.map(g => g.group)).toEqual(['IncreasedLife', 'ArmourAndLife', 'IncreasedMana', 'ArmourPercent']);
    expect(pool.suffixes.map(g => g.group)).toEqual(['Strength', 'FireResistance', 'ColdResistance']);
    expect(pool.prefixWeight).toBeGreaterThan(0);
    // IncreasedLife should be a prefix group on a body armour
    expect(pool.prefixes.some((g) => g.group === 'IncreasedLife')).toBe(true);
    // FireResistance should be a suffix group
    expect(pool.suffixes.some((g) => g.group === 'FireResistance')).toBe(true);
  });

  it('gates by ilvl (low ilvl excludes top tiers)', () => {
    const base = getBase('Astral Plate');
    if (!base) return;
    const low = buildEligiblePool(base, 1);
    const high = buildEligiblePool(base, 86);
    const lifeLow = low.prefixes.find((g) => g.group === 'IncreasedLife');
    const lifeHigh = high.prefixes.find((g) => g.group === 'IncreasedLife');
    // more tiers available at ilvl 86 than ilvl 1
    expect((lifeHigh?.mods.length ?? 0)).toBeGreaterThan(lifeLow?.mods.length ?? 0);
  });
});
