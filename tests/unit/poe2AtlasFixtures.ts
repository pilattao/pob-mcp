import { mkdtempSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

// Verified 2026-09-15 against the primary extractor and its public output:
// https://github.com/repoe-fork/repoe/blob/master/RePoE/parser/poe2/passives.py
// https://repoe-fork.github.io/poe2/passive_skill_trees/Atlas.json
// The index advertised export version 4.5.5.2 (not a user-facing patch number).
// groups[].passives supplies numeric connections and spline geometry;
// passives[hash] supplies metadata, stat_text, stat IDs, flags and atlas_subtree.
// SkillPointsGranted becomes skill_points: it is NOT an allocation cost.
// This hand-written induced graph slice retains real IDs and internal edges;
// boundary edges and art are omitted. No bulk dataset/user content is stored.
export const atlasSource = 'https://repoe-fork.github.io/poe2/passive_skill_trees/Atlas.json';
export const atlasIndex = 'https://repoe-fork.github.io/poe2/';

function passive(hash: number, id: string, name: string, overrides: Record<string, unknown> = {}) {
  return {
    hash, id, name, atlas_group: '', flavour_text: '', reminder_text: [],
    is_atlas_root: false, is_icon_only: false, is_notable: false, is_keystone: false,
    is_ascendancy_starting_node: false, is_free: false, is_jewel_socket: false,
    is_multiple_choice: false, is_multiple_choice_option: false,
    skill_points: 0, weapon_set_points: 0, stat_text: [], stats: {}, ...overrides,
  };
}

export function nativeAtlasFixture() {
  return {
    title: 'Atlas Skills', art: { id: 'Atlas' }, roots: [25703, 18887],
    orbit_radii: [0, 82, 162, 335, 493, 662, 846, 251, 1080, 1332],
    skills_per_orbit: [1, 12, 24, 24, 72, 72, 72, 24, 72, 144],
    groups: [
      { x: 120, y: -500, flag: 0, passives: [
        { hash: 692, radius: 7, position_clockwise: 6, connections: [9980], splines: [0] },
        { hash: 9980, radius: 4, position_clockwise: 18, connections: [12162], splines: [0] },
      ] },
      { x: 300, y: -700, flag: 0, passives: [
        { hash: 12162, radius: 7, position_clockwise: 18, connections: [], splines: [] },
      ] },
      { x: 0, y: 0, flag: 0, passives: [
        { hash: 25703, radius: 0, position_clockwise: 0, connections: [34041], splines: [0] },
        { hash: 34041, radius: 5, position_clockwise: 21, connections: [], splines: [] },
      ] },
      { x: -4569, y: -498, flag: 0, passives: [
        { hash: 18887, radius: 0, position_clockwise: 0, connections: [31048], splines: [0] },
        { hash: 31048, radius: 4, position_clockwise: 65, connections: [], splines: [] },
      ] },
      { x: 500, y: -900, flag: 0, passives: [
        { hash: 361, radius: 0, position_clockwise: 0, connections: [], splines: [] },
        { hash: 182, radius: 0, position_clockwise: 0, connections: [], splines: [] },
      ] },
    ],
    passives: {
      '692': passive(692, 'AtlasStrongboxNotable5_', 'Living Metal', {
        is_notable: true,
        stat_text: ['[AzmeriSpirit|Azmeri Spirits] may seek out and [SpiritPossessed|Possess] [Strongbox|Strongboxes]'],
        stats: { map_azmeri_spirit_may_possess_strongboxes: 1 },
      }),
      '9980': passive(9980, 'AtlasHybridLeagueSmall5', 'Azmeri Spirit and Strongbox Chance', {
        stat_text: ['20% increased chance of [Strongbox|Strongboxes]', '20% increased chance of [AzmeriSpirit|Azmeri Spirits]'],
        stats: { 'map_strongbox_chance_+%': 20, 'map_tormented_spirit_chance_+%': 20 },
      }),
      '12162': passive(12162, 'AtlasAzmeriSpiritNotable14_', 'Hunt the Apex', {
        is_notable: true, stat_text: ['[AzmeriSpirit|Azmeri Spirits] may [SpiritPossessed|Possess] [MapBoss|Map Bosses]'],
        stats: { map_boss_can_be_selected_as_spirit_target_by_ruleset: 1 },
      }),
      '25703': passive(25703, 'AtlasGenericStart', '', { is_atlas_root: true }),
      '34041': passive(34041, 'AtlasStrongbox6', 'Strongbox Chance', {
        stat_text: ['40% increased chance of [Strongbox|Strongboxes]'], stats: { 'map_strongbox_chance_+%': 40 },
      }),
      '18887': passive(18887, 'AtlasRitualStart', '', { is_atlas_root: true, atlas_subtree: { id: 'Ritual' } }),
      '31048': passive(31048, 'AtlasRitualSmall1', 'Increased Tribute', {
        atlas_subtree: { id: 'Ritual' },
        stat_text: ['Monsters Sacrificed at [ContainsRitual|Ritual Altars] grant 5% increased Tribute'],
        stats: { 'map_ritual_tribute_+%': 5 },
      }),
      '361': passive(361, 'AtlasGenericMastery28', '', { is_icon_only: true }),
      '182': passive(182, 'AtlasExpeditionNotable8', 'Strategic Advantage', {
        is_keystone: true, atlas_subtree: { id: 'Expedition' },
        stat_text: ['Improve Explosives used within [ContainsExpedition|Expeditions] and [GrandExpedition|Grand Expeditions]'],
        stats: { dummy_display_expedition_explosive_bonus_selector: 1 },
      }),
    },
  };
}

export function nativeAtlasEnvelope() {
  return {
    game: 'poe2', version: '4.5.5.2', source: atlasSource,
    retrievedAt: '2026-09-15T10:00:00Z', data: nativeAtlasFixture(),
  };
}

/** Process-local configuration only; cleanup never touches the checkout. */
export function useAtlasFixture() {
  const keys = ['POE_GAME', 'ATLASTREE_DIRECTORY', 'POE2_ATLAS_FILE'] as const;
  const saved = keys.map(key => process.env[key]);
  const dir = mkdtempSync(join(tmpdir(), 'poe2-atlas-test-'));
  const path = join(dir, 'poe2-atlas.json');
  process.env.POE_GAME = 'poe2';
  process.env.ATLASTREE_DIRECTORY = dir;
  delete process.env.POE2_ATLAS_FILE;
  writeFileSync(path, JSON.stringify(nativeAtlasEnvelope()));
  return {
    dir, path,
    cleanup() {
      keys.forEach((key, i) => {
        if (saved[i] === undefined) delete process.env[key]; else process.env[key] = saved[i];
      });
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
