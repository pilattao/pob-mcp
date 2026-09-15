import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import * as bases from '../../src/services/pobBaseDataLoader';
import * as mods from '../../src/services/pobModDataLoader';
import * as crafts from '../../src/services/pobCraftDataLoader';

// Small, hand-written native-format fixtures. PoB2 uses mixed Lua tables,
// ordered 1/0 weights, string essence categories and tierLevel, and resolves
// some essence IDs through ModItemExclusive. No installed/user files are copied.
const nativeMods = `return {
  ["Strength1"] = { type = "Suffix", affix = "of the Brute", "+(5-8) to Strength",
    statOrder = { 992 }, level = 1, group = "Strength",
    weightKey = { "ring", "crossbow", "default", }, weightVal = { 1, 1, 0 },
    modTags = { "attribute" }, tradeHashes = { [4080418644] = { "+(5-8) to Strength" } } },
  ["IncreasedLife3"] = { type = "Prefix", affix = "Sanguine", "+(30-39) to maximum Life",
    statOrder = { 887 }, level = 16, group = "IncreasedLife",
    weightKey = { "body_armour", "ring", "default" }, weightVal = { 1, 1, 0 },
    modTags = { "resource", "life" } },
  ["EssenceIncreasedLifePercent1"] = { type = "Prefix", affix = "Essences",
    "(8-10)% increased maximum Life", statOrder = { 889 }, level = 72,
    group = "MaximumLifeIncreasePercent", weightKey = { "default" }, weightVal = { 0 },
    modTags = { "resource", "life" } },
}`;
const nativeExclusive = `return {
  ["EssenceDisplayDefences1"] = { affix = "", "(27-42)% increased Armour, Evasion and Energy Shield",
    statOrder = { 6478 }, level = 1, group = "EssenceDisplayDefences",
    weightKey = { }, weightVal = { }, modTags = { } },
}`;
const nativeEssences = `return {
  ["Metadata/Items/Currency/CurrencyLesserEssenceLife"] = {
    name = "Lesser Essence of the Body", type = "Life", tierLevel = 12,
    mods = { ["Body Armour"] = "IncreasedLife3", ["Focus"] = "IncreasedLife3" } },
  ["Metadata/Items/Currency/CurrencyPerfectEssenceLife"] = {
    name = "Perfect Essence of the Body", type = "Life", tierLevel = 72,
    mods = { ["Body Armour"] = "EssenceIncreasedLifePercent1" } },
  ["Metadata/Items/Currency/CurrencyLesserEssenceDefences"] = {
    name = "Lesser Essence of Enhancement", type = "Defences", tierLevel = 16,
    mods = { ["Focus"] = "EssenceDisplayDefences1" } },
  ["Metadata/Items/Currency/CurrencyCorruptedEssenceAbyss"] = {
    name = "Essence of the Abyss", type = "Abyss", tierLevel = 1, mods = { } },
  ["Metadata/Items/Currency/UndescribedEssence"] = {
    name = "Undescribed Essence", type = "Unresolved", tierLevel = 1,
    mods = { ["Amulet"] = "UndescribedPassiveHashMod" } },
}`;
const focus = `local itemBases = ...
itemBases["Woven Focus"] = {
  type = "Focus", quality = 20, socketLimit = 3,
  tags = { armour = true, default = true, ezomyte_basetype = true, focus = true, int_armour = true },
  implicitModTypes = { }, armour = { EnergyShield = 15 }, req = { level = 6, int = 11 },
}`;
const crossbow = `local itemBases = ...
itemBases["Tense Crossbow"] = {
  type = "Crossbow", quality = 20, socketLimit = 4,
  tags = { crossbow = true, default = true, ezomyte_basetype = true, ranged = true,
    two_hand_weapon = true, twohand = true, weapon = true },
  implicit = "(20-30)% increased Bolt Speed", implicitModTypes = { { } },
  weapon = { PhysicalMin = 8, PhysicalMax = 15, CritChanceBase = 5, AttackRateBase = 1.6,
    Range = 120, ReloadTimeBase = 0.85 }, req = { str = 8, dex = 8 },
}`;
const poe1Master = `return {
  { type = "Suffix", affix = "of Craft", "+(16-20)% to Fire Resistance", level = 12,
    group = "FireResistance", types = { ["Ring"] = true }, modTags = { "fire", "resistance" } },
}`;
const envKeys = ['POB_INSTALL_DIR', 'POE_MCP_SUITE_POB_DIR', 'POE_MCP_SUITE_ROOT', 'POE_GAME'] as const;
let savedEnv: Array<string | undefined>;
let sandbox: string;
const fixedTime = new Date('2025-01-01T00:00:00Z');

function write(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
  // Identical timestamps across installations expose cache leakage.
  utimesSync(path, fixedTime, fixedTime);
}

function fixture(name: string, layout: 'install' | 'source' = 'install', game: 'poe1' | 'poe2' = 'poe2') {
  const root = join(sandbox, name);
  const codeDir = layout === 'install' ? root : join(root, 'src');
  const data = join(codeDir, 'Data');
  write(join(codeDir, 'GameVersions.lua'), `liveTargetVersion = "${game === 'poe2' ? '0_1' : '3_0'}"`);
  write(join(data, 'Bases', 'focus.lua'), focus);
  write(join(data, 'Bases', 'crossbow.lua'), crossbow);
  write(join(data, 'ModItem.lua'), nativeMods);
  write(join(data, 'ModItemExclusive.lua'), nativeExclusive);
  write(join(data, 'Essence.lua'), nativeEssences);
  if (game === 'poe1') {
    write(join(data, 'Bases', 'body.lua'), `local itemBases = ...
      itemBases["Astral Plate"] = { type = "Body Armour", subType = "Armour",
        tags = { armour = true, body_armour = true, default = true, str_armour = true },
        implicit = "+(8-12)% to all Elemental Resistances", req = { level = 62, str = 180 } }`);
    write(join(data, 'ModExplicit.lua'), `return {
      ["Strength1"] = { type = "Suffix", affix = "of the Brute", "+(8-12) to Strength",
        level = 1, group = "Strength", weightKey = { "ring", "default" }, weightVal = { 1000, 0 },
        modTags = { "attribute" } },
      ["IncreasedLifeEssence7"] = { type = "Prefix", affix = "Essences", "+(120-129) to maximum Life",
        level = 82, group = "IncreasedLife", weightKey = { "default" }, weightVal = { 0 }, modTags = { "life" } },
    }`);
    write(join(data, 'Essence.lua'), `return {
      ["Metadata/Items/Currency/CurrencyEssenceGreed7"] = { name = "Deafening Essence of Greed",
        type = 1, tier = 7, mods = { ["Body Armour"] = "IncreasedLifeEssence7" } },
    }`);
    write(join(data, 'ModMaster.lua'), poe1Master);
  }
  return { root, data };
}

beforeEach(() => {
  savedEnv = envKeys.map(key => process.env[key]);
  envKeys.forEach(key => delete process.env[key]);
  process.env.POE_GAME = 'poe2';
  sandbox = mkdtempSync(join(tmpdir(), 'poe2-craft-data-'));
  process.env.POE_MCP_SUITE_ROOT = join(sandbox, 'suite');
});

afterEach(() => {
  envKeys.forEach((key, index) => {
    if (savedEnv[index] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[index];
  });
  rmSync(sandbox, { recursive: true, force: true });
});

describe('PoB2 data paths and native definitions', () => {
  it.each(['install', 'source'] as const)('uses POB_INSTALL_DIR for the %s layout in every loader', layout => {
    const selected = fixture('selected', layout);
    process.env.POB_INSTALL_DIR = selected.root;
    process.env.POE_MCP_SUITE_POB_DIR = fixture('legacy', 'source', 'poe1').root;
    expect(bases.getBasesDir()).toBe(join(selected.data, 'Bases'));
    expect(mods.getModItemPath()).toBe(join(selected.data, 'ModItem.lua'));
    expect(crafts.getEssencePath()).toBe(join(selected.data, 'Essence.lua'));
    expect(crafts.getModMasterPath()).toBe(join(selected.data, 'ModMaster.lua'));
    expect(bases.getBase('Woven Focus')?.req).toEqual({ level: 6, int: 11 });
    expect(mods.getMod('Strength1')?.statLines).toEqual(['+(5-8) to Strength']);
    expect(crafts.getEssence('Lesser Essence of the Body')?.mods['Focus']).toBe('IncreasedLife3');
  });

  it('supports the legacy explicit directory override with a native install', () => {
    process.env.POE_MCP_SUITE_POB_DIR = fixture('legacy').root;
    expect(bases.getBase('Woven Focus')).not.toBeNull();
    expect(mods.getMod('Strength1')).not.toBeNull();
    expect(crafts.getEssenceCount()).toBe(5);
  });

  it('can use a verified PoB2 suite checkout when no override is set', () => {
    fixture('suite/PathOfBuilding', 'source');
    expect(bases.getBase('Tense Crossbow')).not.toBeNull();
    expect(crafts.getEssenceCount()).toBe(5);
  });

  it('does not fall back to the suite when an explicit install is missing', () => {
    fixture('suite/PathOfBuilding', 'source', 'poe1');
    process.env.POB_INSTALL_DIR = join(sandbox, 'missing');
    for (const load of [bases.ensureBasesLoaded, mods.ensureLoaded, crafts.ensureCraftDataLoaded]) {
      expect(load).toThrow(/POB_INSTALL_DIR/);
    }
  });

  it.each(['configured', 'suite'] as const)('rejects %s PoE1 data in PoE2 mode', location => {
    const selected = fixture(location === 'suite' ? 'suite/PathOfBuilding' : 'wrong', 'source', 'poe1');
    if (location === 'configured') process.env.POB_INSTALL_DIR = selected.root;
    for (const load of [bases.ensureBasesLoaded, mods.ensureLoaded, crafts.ensureCraftDataLoaded]) {
      expect(load).toThrow(/PoE2.*PoE1|PoE1.*PoE2/);
    }
  });

  it('rejects unverified data in PoE2 mode', () => {
    const selected = fixture('unknown');
    rmSync(join(selected.root, 'GameVersions.lua'));
    process.env.POB_INSTALL_DIR = selected.root;
    expect(mods.ensureLoaded).toThrow(/PoE2.*verif|verif.*PoE2/i);
  });

  it('keeps the native root Data authoritative when src/Data also exists', () => {
    const selected = fixture('mixed');
    fixture('mixed', 'source', 'poe1');
    process.env.POB_INSTALL_DIR = selected.root;
    expect(mods.getMod('Strength1')?.statLines).toEqual(['+(5-8) to Strength']);
    rmSync(join(selected.data, 'ModItem.lua'));
    expect(mods.ensureLoaded).toThrow(/item.mod data not found/i);
  });

  it('loads new equipment categories, their ordered tags, requirements and implicits', () => {
    process.env.POB_INSTALL_DIR = fixture('bases').root;
    expect(bases.getBaseCount()).toBe(2);
    expect(bases.getBase('TENSE CROSSBOW')).toMatchObject({
      type: 'Crossbow', req: { str: 8, dex: 8 }, sourceFile: 'crossbow',
      implicit: '(20-30)% increased Bolt Speed',
      tags: ['crossbow', 'default', 'ezomyte_basetype', 'ranged', 'two_hand_weapon', 'twohand', 'weapon'],
    });
    expect(bases.getBasesByTag('focus').map(base => base.name)).toEqual(['Woven Focus']);
    expect(bases.findBasesMatching('crossbow').map(base => base.name)).toEqual(['Tense Crossbow']);
    expect(bases.getBase('Astral Plate')).toBeNull();
  });

  it('parses native mixed tables and uses their actual weights for filtering and matching', () => {
    process.env.POB_INSTALL_DIR = fixture('mods').root;
    expect(mods.getModCount()).toBe(3);
    expect(mods.getMod('Strength1')).toMatchObject({
      type: 'Suffix', affix: 'of the Brute', statOrder: [992], level: 1, group: 'Strength',
      weights: [{ tag: 'ring', weight: 1 }, { tag: 'crossbow', weight: 1 }, { tag: 'default', weight: 0 }],
      modTags: ['attribute'],
    });
    const tags = bases.getBase('Tense Crossbow')!.tags;
    expect(mods.searchMods({ itemTags: tags }).map(mod => mod.id)).toEqual(['Strength1']);
    expect(mods.matchStatLine('+7 to Strength', { itemTags: tags, ilvl: 10 }).best?.id).toBe('Strength1');
    expect(mods.searchMods({ itemTags: ['default', 'focus'] })).toEqual([]);
  });

  it('prefers native ModItem over a leftover PoE1 ModExplicit in PoE2 mode', () => {
    const selected = fixture('both');
    write(join(selected.data, 'ModExplicit.lua'), 'return { ["PoE1Only"] = {} }');
    process.env.POB_INSTALL_DIR = selected.root;
    expect(mods.getMod('Strength1')).not.toBeNull();
    expect(mods.getMod('PoE1Only')).toBeNull();
  });

  it('loads essences without ModMaster and preserves native category and tierLevel', () => {
    process.env.POB_INSTALL_DIR = fixture('essences').root;
    crafts.ensureCraftDataLoaded();
    expect(crafts.getEssenceCount()).toBe(5);
    expect(crafts.getEssence('lesser essence of the body')).toMatchObject({
      name: 'Lesser Essence of the Body', type: 'Life', tierLevel: 12,
      tier: null, typeId: null,
    });
    expect(crafts.findEssencesMatching('the Body').map(essence => essence.name))
      .toEqual(['Lesser Essence of the Body', 'Perfect Essence of the Body']);
    expect(crafts.getEssence('Deafening Essence of Greed')).toBeNull();
  });

  it('resolves real item and exclusive essence definitions without expanding the rolling pool', () => {
    process.env.POB_INSTALL_DIR = fixture('resolutions').root;
    expect(crafts.resolveEssenceMods('Lesser Essence of the Body', 'Body Armour')[0]).toMatchObject({
      itemType: 'Body Armour', modId: 'IncreasedLife3', mod: { statLines: ['+(30-39) to maximum Life'] },
    });
    expect(crafts.resolveEssenceMods('Lesser Essence of Enhancement', 'Focus')[0]).toMatchObject({
      modId: 'EssenceDisplayDefences1', mod: { statLines: ['(27-42)% increased Armour, Evasion and Energy Shield'], weights: [] },
    });
    expect(crafts.searchEssencesByStat('Energy Shield').map(hit => hit.essence.name))
      .toEqual(['Lesser Essence of Enhancement']);
    expect(crafts.searchEssencesByStat('maximum Life')[0].matchingTypes).toEqual(['Body Armour', 'Focus']);
    expect(mods.searchMods({ statContains: 'Energy Shield' })).toEqual([]);
    expect(mods.getModCount()).toBe(3);
  });

  it('keeps missing descriptions and empty essence mappings explicit', () => {
    process.env.POB_INSTALL_DIR = fixture('unresolved').root;
    expect(crafts.resolveEssenceMods('Essence of the Abyss')).toEqual([]);
    expect(crafts.resolveEssenceMods('Undescribed Essence')).toEqual([
      { itemType: 'Amulet', modId: 'UndescribedPassiveHashMod', mod: null },
    ]);
    expect(crafts.resolveEssenceMods('Lesser Essence of the Body', 'Crossbow')).toEqual([]);
  });

  it('reports unsupported bench crafts explicitly, even if ModMaster or runes are present', () => {
    const selected = fixture('bench');
    write(join(selected.data, 'ModMaster.lua'), poe1Master);
    write(join(selected.data, 'ModRunes.lua'), 'return { { "Socket effect", type = "Rune" } }');
    process.env.POB_INSTALL_DIR = selected.root;
    expect(crafts.getMasterCraftCount).toThrow(/PoE2.*bench.*unsupported/i);
    expect(() => crafts.searchMasterCrafts({ itemType: 'Ring' })).toThrow(/PoE2.*bench.*unsupported/i);
    expect(() => crafts.matchMasterCraft('+18% to Fire Resistance', 'Ring')).toThrow(/PoE2.*bench.*unsupported/i);
    expect(crafts.getEssenceCount()).toBe(5);
  });

  it('invalidates all caches on install changes with identical timestamps and lengths', () => {
    const first = fixture('first');
    const second = fixture('second');
    write(join(second.data, 'Bases', 'focus.lua'), focus.replace('Woven Focus', 'Other Focus'));
    write(join(second.data, 'ModItem.lua'), nativeMods.replace('+(5-8)', '+(6-9)'));
    write(join(second.data, 'Essence.lua'), nativeEssences.replace('type = "Life"', 'type = "Mana"'));
    process.env.POB_INSTALL_DIR = first.root;
    expect(bases.getBase('Woven Focus')).not.toBeNull();
    expect(mods.getMod('Strength1')?.statLines).toEqual(['+(5-8) to Strength']);
    expect(crafts.getEssence('Lesser Essence of the Body')).toMatchObject({ type: 'Life' });
    process.env.POB_INSTALL_DIR = second.root;
    expect(bases.getBase('Woven Focus')).toBeNull();
    expect(bases.getBase('Other Focus')).not.toBeNull();
    expect(mods.getMod('Strength1')?.statLines).toEqual(['+(6-9) to Strength']);
    expect(crafts.getEssence('Lesser Essence of the Body')).toMatchObject({ type: 'Mana' });
  });

  it('refreshes bases after file membership changes with identical mtimes', () => {
    const selected = fixture('membership');
    process.env.POB_INSTALL_DIR = selected.root;
    expect(bases.getBase('Woven Focus')).not.toBeNull();
    rmSync(join(selected.data, 'Bases', 'focus.lua'));
    write(join(selected.data, 'Bases', 'spear.lua'), focus.replaceAll('Woven Focus', 'Test Spear'));
    expect(bases.getBase('Woven Focus')).toBeNull();
    expect(bases.getBase('Test Spear')).not.toBeNull();
  });

  it('indexes all native base definitions, including categories with separate mod pools', () => {
    const selected = fixture('all-base-types');
    write(join(selected.data, 'Bases', 'jewel.lua'), `local itemBases = ...
      itemBases["Ruby"] = { type = "Jewel", tags = { jewel = true, default = true }, req = { level = 1 } }`);
    write(join(selected.data, 'Bases', 'flask.lua'), `local itemBases = ...
      itemBases["Lesser Life Flask"] = { type = "Life Flask", tags = { flask = true, default = true },
        flask = { life = 50 }, req = { } }`);
    process.env.POB_INSTALL_DIR = selected.root;
    expect(bases.getBaseCount()).toBe(4);
    expect(bases.getBase('Ruby')?.type).toBe('Jewel');
    expect(bases.getBase('Lesser Life Flask')?.type).toBe('Life Flask');
  });

  it('uses the final Lua assignment consistently for lookups, tags, searches and counts', () => {
    const selected = fixture('base-overwrite');
    write(join(selected.data, 'Bases', 'focus.lua'), focus + `
      itemBases["Woven Focus"] = { type = "Focus", tags = { focus = true, default = true }, req = { level = 9 } }`);
    process.env.POB_INSTALL_DIR = selected.root;
    expect(bases.getBaseCount()).toBe(2);
    expect(bases.getBase('Woven Focus')?.req).toEqual({ level: 9 });
    expect(bases.findBasesMatching('Woven')).toEqual([bases.getBase('Woven Focus')]);
    expect(bases.getBasesByTag('int_armour')).toEqual([]);
  });

  it('refreshes exclusive definitions when their source changes or disappears', () => {
    const selected = fixture('exclusive-reload');
    process.env.POB_INSTALL_DIR = selected.root;
    expect(mods.getMod('EssenceDisplayDefences1')?.statLines).toEqual(['(27-42)% increased Armour, Evasion and Energy Shield']);
    write(join(selected.data, 'ModItemExclusive.lua'), nativeExclusive.replace('(27-42)', '(30-50)'));
    utimesSync(join(selected.data, 'ModItemExclusive.lua'), fixedTime, new Date('2025-01-02T00:00:00Z'));
    expect(mods.getMod('EssenceDisplayDefences1')?.statLines).toEqual(['(30-50)% increased Armour, Evasion and Energy Shield']);
    rmSync(join(selected.data, 'ModItemExclusive.lua'));
    expect(mods.getMod('EssenceDisplayDefences1')).toBeNull();
  });

  it('fails on missing or malformed native files instead of returning cached success', () => {
    const selected = fixture('broken');
    process.env.POB_INSTALL_DIR = selected.root;
    crafts.ensureCraftDataLoaded();
    write(join(selected.data, 'Essence.lua'), 'return "not a table"');
    expect(crafts.ensureCraftDataLoaded).toThrow(/table/i);
    write(join(selected.data, 'Essence.lua'), nativeEssences);
    crafts.ensureCraftDataLoaded();
    rmSync(join(selected.data, 'Essence.lua'));
    expect(crafts.ensureCraftDataLoaded).toThrow();
  });
});

describe('PoE1 compatibility using isolated source fixtures', () => {
  it('retains base lookup, ModExplicit precedence, numeric essence tiers and real bench crafts', () => {
    const selected = fixture('poe1', 'source', 'poe1');
    process.env.POE_GAME = 'poe1';
    process.env.POB_INSTALL_DIR = selected.root;
    expect(bases.getBase('Astral Plate')?.tags).toContain('str_armour');
    expect(mods.getModItemPath()).toBe(join(selected.data, 'ModExplicit.lua'));
    expect(mods.getMod('Strength1')?.statLines).toEqual(['+(8-12) to Strength']);
    expect(crafts.getEssence('Deafening Essence of Greed')).toMatchObject({ tier: 7, typeId: 1 });
    expect(crafts.resolveEssenceMods('Deafening Essence of Greed', 'Body Armour')[0].mod?.id).toBe('IncreasedLifeEssence7');
    expect(crafts.getMasterCraftCount()).toBe(1);
    expect(crafts.searchMasterCrafts({ itemType: 'Ring', statContains: 'Fire Resistance' })).toHaveLength(1);
    expect(crafts.matchMasterCraft('+18% to Fire Resistance', 'Ring')?.group).toBe('FireResistance');
  });
});
