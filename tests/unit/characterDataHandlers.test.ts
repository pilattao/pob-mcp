import { describe, it, expect, jest, beforeEach, afterEach } from '@jest/globals';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import {
  handleComputeConstraintMargins,
  handleSyncCharacterCache,
} from '../../src/handlers/characterDataHandlers';
import type { LuaHandlerContext } from '../../src/handlers/luaHandlers';

function makeContext(luaClient: any = null, overrides: Partial<LuaHandlerContext> = {}): LuaHandlerContext {
  return {
    pobDirectory: '/builds',
    luaEnabled: true,
    getLuaClient: jest.fn<() => any>().mockReturnValue(luaClient),
    ensureLuaClient: jest.fn<() => Promise<void>>().mockResolvedValue(undefined),
    stopLuaClient: jest.fn<() => Promise<void>>().mockResolvedValue(undefined),
    ...overrides,
  };
}

const DEFAULT_STATS: Record<string, number> = {
  Life: 5400,
  EnergyShield: 120,
  Mana: 800,
  ManaUnreserved: 146,
  FireResist: 78,
  FireResistOverCap: 11,
  ColdResist: 77,
  LightningResist: 76,
  ChaosResist: 52,
  LifeUnreserved: 3977,
  HitChance: 100,
  BlockChance: 54,
  SpellBlockChance: 20,
  CombinedDPS: 1234567,
  TotalEHP: 32000,
  CritChance: 45.5,
  CritMultiplier: 320,
  PhysicalDamageReduction: 32,
  LifeRegen: 210,
  Armour: 12000,
  Evasion: 3000,
  Str: 142,
};

function makeLuaClient(overrides: Partial<Record<string, jest.Mock>> = {}) {
  return {
    getStats: jest.fn<() => Promise<any>>().mockResolvedValue(DEFAULT_STATS),
    getBuildInfo: jest.fn<() => Promise<any>>().mockResolvedValue({
      name: 'TestBuild', level: 97, className: 'Duelist', ascendClassName: 'Slayer', treeVersion: '3_26',
    }),
    getItems: jest.fn<() => Promise<any[]>>().mockResolvedValue([]),
    ...overrides,
  };
}

let tmpDir: string;
beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'chardata-test-'));
});
afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

const PROFILE_MD = `---
character: TestChar
mode: analysis
---

# Build Profile

## 6. Constraint Status

| Stat | Tier | Threshold | Current | Margin | Notes |
|------|------|-----------|---------|--------|-------|
| Fire resistance | Important | ≥75% | | | -max res maps consume overcap |
| Chaos resistance | Important | ≥30% | | | |
| Life (unreserved) | Important | ≥3,500 | | | comma threshold |
| Mana (unreserved) | Important | ≥150 | | | |
| Hit chance | Critical | 100% | | | at exact floor |
| Leech source | Critical | present | | | gloves + ring 2 |
| Reserved Life+Mana | Critical | both active | | | Reservation Mastery requires both |
| Strength | Important | gem/gear req | | | |

## 7. Known Weak Points
`;

// ── compute_constraint_margins ────────────────────────────────────────────────

describe('handleComputeConstraintMargins', () => {
  it('converts a native critical multiplier factor only for percent thresholds', async () => {
    const profilePath = path.join(tmpDir, 'crit-profile.md');
    await fs.writeFile(profilePath, '| Stat | Tier | Threshold | Current | Margin | Notes |\n| --- | --- | --- | --- | --- | --- |\n| Crit Multiplier | Hard | >= 400% | | | |\n| Crit Multiplier | Soft | >= 4 | | | |\n');
    const ctx = makeContext(makeLuaClient({ getStats: jest.fn<() => Promise<any>>().mockResolvedValue({CritMultiplier:4.5}) }));
    const text=(await handleComputeConstraintMargins(ctx,profilePath,false)).content[0].text;
    expect(text).toContain('current 450%, margin +50%');
    expect(text).toContain('current 4.5, margin +0.5');
  });

  it('evaluates PoE2 Spirit resources and keeps missing evidence explicit', async () => {
    const profilePath = path.join(tmpDir, 'spirit-profile.md');
    await fs.writeFile(profilePath, '| Stat | Tier | Threshold | Current | Margin | Notes |\n| --- | --- | --- | --- | --- | --- |\n| Spirit | Hard | >= 140 | | | |\n| Spirit unreserved | Hard | >= 1 | | | |\n| Mystery | Hard | >= 1 | | | |\n');
    const client = makeLuaClient({ getStats: jest.fn<() => Promise<any>>().mockResolvedValue({ Spirit: 144, SpiritUnreserved: 4 }) });
    const result = await handleComputeConstraintMargins(makeContext(client), profilePath, false);
    const text = result.content[0].text;
    expect(text).toContain('current 144, margin +4');
    expect(text).toContain('current 4, margin +3');
    expect(text).toContain('not fully verified');
  });

  it('computes margins for numeric thresholds from live stats', async () => {
    const profilePath = path.join(tmpDir, 'build-profile.md');
    await fs.writeFile(profilePath, PROFILE_MD);
    const ctx = makeContext(makeLuaClient());

    const result = await handleComputeConstraintMargins(ctx, profilePath, false);
    const text = result.content[0].text;

    expect(text).toContain('Fire resistance');
    expect(text).toContain('+3%');           // 78 vs ≥75
    expect(text).toContain('overcap');       // FireResistOverCap surfaced
    expect(text).toContain('+22%');          // chaos 52 vs ≥30
    expect(text).toContain('-4');            // mana 146 vs ≥150
    expect(text).toContain('VIOLATED');      // the -4 margin
    expect(text).toContain('Mana (unreserved)');
  });

  it('marks non-numeric thresholds and fills current when stat is mapped', async () => {
    const profilePath = path.join(tmpDir, 'build-profile.md');
    await fs.writeFile(profilePath, PROFILE_MD);
    const ctx = makeContext(makeLuaClient());

    const result = await handleComputeConstraintMargins(ctx, profilePath, false);
    const text = result.content[0].text;

    expect(text).toContain('manual evaluation');
    expect(text).toContain('Leech source');
    // Strength row: non-numeric threshold but mapped stat → current filled
    expect(text).toMatch(/Strength.*current 142/);
  });

  it('parses thresholds with thousands separators ("≥3,500")', async () => {
    const profilePath = path.join(tmpDir, 'build-profile.md');
    await fs.writeFile(profilePath, PROFILE_MD);
    const ctx = makeContext(makeLuaClient());

    const result = await handleComputeConstraintMargins(ctx, profilePath, false);
    const row = result.content[0].text.split('\n').find((l) => l.includes('Life (unreserved)'));
    expect(row).toContain('current 3977');
    expect(row).toContain('+477'); // 3977 − 3500, comma stripped
    expect(row).not.toContain('✍️'); // computed, not manual
  });

  it('does not map compound status rows ("Reserved Life+Mana") to a numeric stat', async () => {
    const profilePath = path.join(tmpDir, 'build-profile.md');
    await fs.writeFile(profilePath, PROFILE_MD);
    const ctx = makeContext(makeLuaClient());

    const result = await handleComputeConstraintMargins(ctx, profilePath, false);
    const text = result.content[0].text;
    const row = text.split('\n').find((l) => l.includes('Reserved Life+Mana'));
    // The greedy \blife\b pattern used to fill this status row with the Life stat.
    expect(row).toContain('current —');
    expect(row).not.toContain('5400');
    expect(row).toContain('✍️');
  });

  it('flags at-floor constraints as near-floor, not violated', async () => {
    const profilePath = path.join(tmpDir, 'build-profile.md');
    await fs.writeFile(profilePath, PROFILE_MD);
    const ctx = makeContext(makeLuaClient());

    const result = await handleComputeConstraintMargins(ctx, profilePath, false);
    const text = result.content[0].text;
    // Hit chance 100 vs 100% → margin 0, warn icon on that line, not violated
    const hitLine = text.split('\n').find((l) => l.includes('Hit chance'));
    expect(hitLine).toContain('⚠️');
  });

  it('does not modify the file without write_back', async () => {
    const profilePath = path.join(tmpDir, 'build-profile.md');
    await fs.writeFile(profilePath, PROFILE_MD);
    const ctx = makeContext(makeLuaClient());

    await handleComputeConstraintMargins(ctx, profilePath, false);
    expect(await fs.readFile(profilePath, 'utf-8')).toBe(PROFILE_MD);
  });

  it('writes updated Current/Margin cells and a computed-on caption with write_back', async () => {
    const profilePath = path.join(tmpDir, 'build-profile.md');
    await fs.writeFile(profilePath, PROFILE_MD);
    const ctx = makeContext(makeLuaClient());

    await handleComputeConstraintMargins(ctx, profilePath, true);
    const updated = await fs.readFile(profilePath, 'utf-8');

    expect(updated).toContain('compute_constraint_margins');    // caption
    const fireRow = updated.split('\n').find((l) => l.includes('Fire resistance'));
    expect(fireRow).toContain('78%');
    expect(fireRow).toContain('+3%');
    expect(fireRow).toContain('-max res maps consume overcap'); // Notes preserved
    // Surrounding content untouched
    expect(updated).toContain('## 7. Known Weak Points');
    expect(updated).toContain('mode: analysis');
  });

  it('is idempotent on write_back (caption replaced, not duplicated)', async () => {
    const profilePath = path.join(tmpDir, 'build-profile.md');
    await fs.writeFile(profilePath, PROFILE_MD);
    const ctx = makeContext(makeLuaClient());

    await handleComputeConstraintMargins(ctx, profilePath, true);
    await handleComputeConstraintMargins(ctx, profilePath, true);
    const updated = await fs.readFile(profilePath, 'utf-8');
    const captions = updated.split('\n').filter((l) => l.includes('compute_constraint_margins'));
    expect(captions).toHaveLength(1);
  });

  it('requests derived stat fields explicitly (PoB omits them from a no-arg getStats)', async () => {
    const profilePath = path.join(tmpDir, 'build-profile.md');
    await fs.writeFile(profilePath, PROFILE_MD);
    const client = makeLuaClient();
    const ctx = makeContext(client);

    await handleComputeConstraintMargins(ctx, profilePath, false);

    const requested = (client.getStats as jest.Mock).mock.calls[0][0] as string[];
    expect(Array.isArray(requested)).toBe(true);
    // The derived fields that a bare getStats() silently drops must be named.
    expect(requested).toEqual(
      expect.arrayContaining(['FireResist', 'FireResistOverCap', 'ManaUnreserved', 'HitChance', 'Str'])
    );
  });

  it('errors clearly when no constraint table exists', async () => {
    const profilePath = path.join(tmpDir, 'build-profile.md');
    await fs.writeFile(profilePath, '# Empty profile\n\nNo table here.\n');
    const ctx = makeContext(makeLuaClient());

    const result = await handleComputeConstraintMargins(ctx, profilePath, false).catch((e: Error) => e);
    expect(result).toBeInstanceOf(Error);
    expect((result as Error).message).toContain('Constraint Status');
  });
});

// ── sync_character_cache ──────────────────────────────────────────────────────

const META_JSON = {
  account: 'Test#1234',
  character: 'TestChar',
  league: 'Mirage',
  level: 96,
  guide_url: 'https://example.com',
  current_stats: {
    as_of: '2026-01-01',
    life: 5000,
    resistances: { fire: 70, cold: 70, lightning: 70, chaos: 40 },
    notes: 'hand-written sync log',
  },
  masteries: ['Life Mastery'],
};

const INVENTORY_JSON = {
  as_of: '2026-01-01',
  equipped: {
    helmet: { name: 'Old Hat', base: 'Iron Hat', rarity: 'RARE', key_mods: ['old mod'], notes: 'curated' },
    boots: { name: 'Same Boots', base: 'Slink Boots', rarity: 'RARE', key_mods: ['curated mod'], notes: 'keep me' },
  },
  flasks: [{ slot: 1, name: 'Old Flask', purpose: 'utility' }],
  jewels: { rare: [{ name: 'Curated Jewel' }] },
  eldritch_implicits: { helmet: { searing: 'x' } },
};

function makeItemsClient() {
  return makeLuaClient({
    getItems: jest.fn<() => Promise<any[]>>().mockResolvedValue([
      { id: 1, slot: 'Helmet', name: 'New Hat', baseName: 'Hubris Circlet', rarity: 'RARE', raw: '' },
      { id: 2, slot: 'Boots', name: 'Same Boots', baseName: 'Slink Boots', rarity: 'RARE', raw: '' },
      { id: 3, slot: 'Flask 1', name: 'New Flask', baseName: 'Quicksilver Flask', rarity: 'MAGIC', raw: '' },
    ]),
  });
}

describe('handleSyncCharacterCache', () => {
  async function writeFixtures() {
    await fs.writeFile(path.join(tmpDir, 'meta.json'), JSON.stringify(META_JSON, null, 2));
    await fs.writeFile(path.join(tmpDir, 'inventory.json'), JSON.stringify(INVENTORY_JSON, null, 2));
  }

  it('updates meta.json stats, level, and as_of while preserving unknown keys', async () => {
    await writeFixtures();
    const ctx = makeContext(makeItemsClient());

    const result = await handleSyncCharacterCache(ctx, tmpDir, ['meta'], false);
    const text = result.content[0].text;
    expect(text).toContain('level: 96 → 97');
    expect(text).toContain('life: 5000 → 5400');

    const meta = JSON.parse(await fs.readFile(path.join(tmpDir, 'meta.json'), 'utf-8'));
    expect(meta.level).toBe(97);
    expect(meta.current_stats.life).toBe(5400);
    expect(meta.current_stats.resistances.fire).toBe(78);
    expect(meta.current_stats.as_of).not.toBe('2026-01-01');
    // preserved fields
    expect(meta.current_stats.notes).toBe('hand-written sync log');
    expect(meta.guide_url).toBe('https://example.com');
    expect(meta.masteries).toEqual(['Life Mastery']);
  });

  it('replaces changed inventory slots but preserves curated fields on unchanged ones', async () => {
    await writeFixtures();
    const ctx = makeContext(makeItemsClient());

    await handleSyncCharacterCache(ctx, tmpDir, ['inventory'], false);
    const inv = JSON.parse(await fs.readFile(path.join(tmpDir, 'inventory.json'), 'utf-8'));

    expect(inv.equipped.helmet.name).toBe('New Hat');
    expect(inv.equipped.helmet.notes).toContain('synced from PoB');
    // unchanged slot: curated data intact
    expect(inv.equipped.boots.key_mods).toEqual(['curated mod']);
    expect(inv.equipped.boots.notes).toBe('keep me');
    // flask changed → purpose flagged for review
    expect(inv.flasks[0].name).toBe('New Flask');
    expect(inv.flasks[0].purpose).toBe('(review)');
    // curated sections untouched
    expect(inv.jewels.rare[0].name).toBe('Curated Jewel');
    expect(inv.eldritch_implicits.helmet.searing).toBe('x');
  });

  it('dry_run reports changes without writing', async () => {
    await writeFixtures();
    const ctx = makeContext(makeItemsClient());

    const result = await handleSyncCharacterCache(ctx, tmpDir, ['meta', 'inventory'], true);
    expect(result.content[0].text).toContain('Dry run');

    const meta = JSON.parse(await fs.readFile(path.join(tmpDir, 'meta.json'), 'utf-8'));
    expect(meta.level).toBe(96);
    const inv = JSON.parse(await fs.readFile(path.join(tmpDir, 'inventory.json'), 'utf-8'));
    expect(inv.equipped.helmet.name).toBe('Old Hat');
  });

  it('skips missing files with a warning instead of failing', async () => {
    // only meta.json present
    await fs.writeFile(path.join(tmpDir, 'meta.json'), JSON.stringify(META_JSON, null, 2));
    const ctx = makeContext(makeItemsClient());

    const result = await handleSyncCharacterCache(ctx, tmpDir, ['meta', 'inventory'], false);
    const text = result.content[0].text;
    expect(text).toContain('inventory.json not found');
    expect(text).toContain('level: 96 → 97');
  });

  it('errors clearly when character_dir does not exist', async () => {
    const ctx = makeContext(makeItemsClient());
    const result = await handleSyncCharacterCache(ctx, path.join(tmpDir, 'nope'), ['meta'], false).catch((e: Error) => e);
    expect(result).toBeInstanceOf(Error);
    expect((result as Error).message).toContain('does not exist');
  });
});
