import { useLegacyCraftFixture } from '../fixtures/coreCraftLegacy';
let legacy: ReturnType<typeof useLegacyCraftFixture>;
beforeAll(() => { legacy = useLegacyCraftFixture(); });
afterAll(() => legacy.cleanup());
import { describe, it, expect, beforeAll, afterAll } from '@jest/globals';
import { handleCalculateModOdds } from '../../src/handlers/calculateModOddsHandler';


function getText(r: { content: Array<{ type: string; text: string }> }): string {
  return r.content.map((c) => c.text).join('\n');
}

describe('handleCalculateModOdds', () => {
  it('validates required args', async () => {
    expect((await handleCalculateModOdds({ base_name: '', ilvl: 86, targets: [] })).isError).toBe(true);
    expect((await handleCalculateModOdds({ base_name: 'Astral Plate', ilvl: 86, targets: [] })).isError).toBe(true);
  });

  it('computes combined odds for two group targets (raw_json)', async () => {
    const r = await handleCalculateModOdds({
      base_name: 'Astral Plate',
      ilvl: 86,
      targets: [{ group: 'IncreasedLife', min_tier: 1 }, { group: 'FireResistance', min_tier: 1 }],
      method: 'chaos',
      raw_json: true,
    });
    const j = JSON.parse(getText(r));
    expect(j.combined_probability).toBeGreaterThan(0);
    expect(j.combined_probability).toBeLessThan(1);
    expect(j.estimated_attempts).toBeGreaterThan(1);
    expect(j.targets.length).toBe(2);
  });

  it('returns a disambiguation list for ambiguous stat keywords', async () => {
    const r = await handleCalculateModOdds({
      base_name: 'Astral Plate',
      ilvl: 86,
      targets: [{ stat: 'maximum Life' }],
    });
    expect(getText(r)).toMatch(/matches multiple mod groups/);
  });

  it('essence method guarantees the forced mod and reduces slots', async () => {
    const r = await handleCalculateModOdds({
      base_name: 'Astral Plate',
      ilvl: 86,
      method: 'essence',
      essence_name: 'Deafening Essence of Greed',
      targets: [{ group: 'IncreasedLife' }, { group: 'FireResistance', min_tier: 1 }],
      raw_json: true,
    });
    const j = JSON.parse(getText(r));
    expect(j.method).toBe('essence');
    // Life target should be flagged forced-satisfied
    const life = j.targets.find((t: { group: string }) => t.group === 'IncreasedLife');
    expect(life.forcedSatisfied).toBe(true);
    // prefix slot count reduced by the forced prefix
    expect(j.prefix_count).toBe(2);
    // essence-guaranteed life => combined odds equal the fire-res odds alone
    expect(j.combined_probability).toBeGreaterThan(0);
  });

  it('flags impossible combos (two targets same group)', async () => {
    const r = await handleCalculateModOdds({
      base_name: 'Astral Plate',
      ilvl: 86,
      targets: [{ group: 'IncreasedLife', min_tier: 1 }, { group: 'IncreasedLife', min_tier: 3 }],
      raw_json: true,
    });
    const j = JSON.parse(getText(r));
    expect(j.warnings.join(' ')).toMatch(/same mod group/);
    expect(j.combined_probability).toBe(0);
  });

  it('alt method caps slots at 1/1', async () => {
    const r = await handleCalculateModOdds({
      base_name: 'Sapphire Ring',
      ilvl: 84,
      method: 'alt',
      targets: [{ group: 'FireResistance', min_tier: 2 }],
      raw_json: true,
    });
    const j = JSON.parse(getText(r));
    expect(j.prefix_count).toBeLessThanOrEqual(1);
    expect(j.suffix_count).toBeLessThanOrEqual(1);
  });

  it('suggests bases on miss', async () => {
    const r = await handleCalculateModOdds({ base_name: 'Astrl Plate', ilvl: 86, targets: [{ group: 'IncreasedLife' }] });
    expect(getText(r)).toMatch(/not found/);
  });
});
