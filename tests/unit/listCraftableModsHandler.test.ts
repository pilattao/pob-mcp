import { useLegacyCraftFixture } from '../fixtures/coreCraftLegacy';
let legacy: ReturnType<typeof useLegacyCraftFixture>;
beforeAll(() => { legacy = useLegacyCraftFixture(); });
afterAll(() => legacy.cleanup());
import { describe, it, expect, beforeAll, afterAll } from '@jest/globals';

import { handleListCraftableModsForBase } from '../../src/handlers/listCraftableModsHandler';


function getText(result: { content: Array<{ type: string; text: string }> }): string {
  return result.content.map((c) => c.text).join('\n');
}

describe('handleListCraftableModsForBase', () => {
  it('rejects missing base_name', async () => {
    // Cast through unknown to bypass TS — the handler must guard at runtime.
    const r = await handleListCraftableModsForBase({ base_name: '' as unknown as string });
    expect(r.isError).toBe(true);
  });

  it('returns fuzzy suggestions for unknown base', async () => {
    const r = await handleListCraftableModsForBase({ base_name: 'Hubris' });
    expect(r.isError).toBeUndefined();
    const text = getText(r);
    expect(text).toMatch(/not found/i);
    expect(text).toMatch(/Hubris Circlet/);
  });

  it('lists prefixes and suffixes for Astral Plate at ilvl 86', async () => {
    const r = await handleListCraftableModsForBase({
      base_name: 'Astral Plate',
      ilvl: 86,
      tiers_per_group: 1,
    });
    expect(r.isError).toBeUndefined();
    const text = getText(r);
    expect(text).toMatch(/=== Astral Plate/);
    expect(text).toMatch(/--- PREFIXES/);
    expect(text).toMatch(/--- SUFFIXES/);
    // top-tier life should show up
    expect(text).toMatch(/IncreasedLife/);
    // top-tier fire res should show up
    expect(text).toMatch(/FireResistance/);
  });

  it('honours ilvl gating', async () => {
    // ilvl 1 — only the very lowest-tier mods should appear
    const r = await handleListCraftableModsForBase({
      base_name: 'Sapphire Ring',
      ilvl: 1,
      tiers_per_group: 1,
      raw_json: true,
    });
    const parsed = JSON.parse(getText(r));
    expect(parsed.mod_count).toBeGreaterThan(0);
    for (const g of parsed.groups) {
      for (const e of g.entries) {
        expect(e.level).toBeLessThanOrEqual(1);
      }
    }
  });

  it('type=Prefix filters to prefixes only', async () => {
    const r = await handleListCraftableModsForBase({
      base_name: 'Astral Plate',
      ilvl: 86,
      type: 'Prefix',
      tiers_per_group: 1,
      raw_json: true,
    });
    const parsed = JSON.parse(getText(r));
    expect(parsed.groups.length).toBeGreaterThan(0);
    for (const g of parsed.groups) {
      for (const e of g.entries) {
        expect(e.type).toBe('Prefix');
      }
    }
  });

  it('tiers_per_group caps entries per group', async () => {
    const r = await handleListCraftableModsForBase({
      base_name: 'Astral Plate',
      tiers_per_group: 2,
      raw_json: true,
    });
    const parsed = JSON.parse(getText(r));
    expect(parsed.groups.length).toBeGreaterThan(0);
    for (const g of parsed.groups) {
      expect(g.entries.length).toBeLessThanOrEqual(2);
    }
  });

  it('stat_contains narrows the dump', async () => {
    const r = await handleListCraftableModsForBase({
      base_name: 'Astral Plate',
      ilvl: 86,
      stat_contains: 'maximum Life',
      tiers_per_group: 0,
      raw_json: true,
    });
    const parsed = JSON.parse(getText(r));
    expect(parsed.mod_count).toBeGreaterThan(0);
    for (const g of parsed.groups) {
      for (const e of g.entries) {
        const hit = e.statLines.some((s: string) => /maximum Life/i.test(s));
        expect(hit).toBe(true);
      }
    }
  });
});
