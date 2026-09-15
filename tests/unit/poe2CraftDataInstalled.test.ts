import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';
import { existsSync } from 'fs';
import { join } from 'path';
import * as bases from '../../src/services/pobBaseDataLoader';
import * as mods from '../../src/services/pobModDataLoader';
import * as crafts from '../../src/services/pobCraftDataLoader';

// Opt in with POB_NATIVE_TEST_DIR pointing at a real packaged PoB2 install.
// Only distributed Data and GameVersions files are read; no build/settings
// files are read or written. Never skip a bad path when explicitly requested.
const nativeDir = process.env.POB_NATIVE_TEST_DIR;
const native = nativeDir ? describe : describe.skip;
const savedGame = process.env.POE_GAME;
const savedInstall = process.env.POB_INSTALL_DIR;

native('real installed PoB2 data (opt-in, read only)', () => {
  beforeAll(() => {
    process.env.POE_GAME = 'poe2';
    process.env.POB_INSTALL_DIR = nativeDir!;
  });
  afterAll(() => {
    if (savedGame === undefined) delete process.env.POE_GAME;
    else process.env.POE_GAME = savedGame;
    if (savedInstall === undefined) delete process.env.POB_INSTALL_DIR;
    else process.env.POB_INSTALL_DIR = savedInstall;
  });

  it('loads native base definitions and PoE2 equipment categories from root Data', () => {
    expect(bases.getBasesDir()).toBe(join(nativeDir!, 'Data', 'Bases'));
    expect(bases.getBaseCount()).toBeGreaterThan(1700);
    expect(bases.getBase('Woven Focus')).toMatchObject({ type: 'Focus', req: { level: 6, int: 11 } });
    expect(bases.getBase('Tense Crossbow')).toMatchObject({ type: 'Crossbow', implicit: '(20-30)% increased Bolt Speed' });
    expect(bases.getBase('Ruby')?.type).toBe('Jewel');
  });

  it('reads the actual ModItem table and preserves native eligibility weights', () => {
    expect(mods.getModItemPath()).toBe(join(nativeDir!, 'Data', 'ModItem.lua'));
    expect(mods.getModCount()).toBeGreaterThan(2000);
    const strength = mods.getMod('Strength1');
    expect(strength).toMatchObject({ type: 'Suffix', statLines: ['+(5-8) to Strength'], group: 'Strength' });
    expect(mods.resolveWeightForTag(strength!, 'crossbow')).toBe(1);
    expect(mods.matchStatLine('+7 to Strength', { itemTags: bases.getBase('Tense Crossbow')!.tags }).best?.id).toBe('Strength1');
  });

  it('resolves native essence IDs in both Item and Exclusive tables', () => {
    crafts.ensureCraftDataLoaded();
    expect(crafts.getEssenceCount()).toBeGreaterThan(70);
    expect(crafts.getEssence('Lesser Essence of the Body')).toMatchObject({ type: 'Life', tierLevel: 12, tier: null, typeId: null });
    expect(crafts.resolveEssenceMods('Lesser Essence of the Body', 'Body Armour')[0].mod?.statLines)
      .toEqual(['+(30-39) to maximum Life']);
    expect(crafts.resolveEssenceMods('Lesser Essence of Enhancement', 'Focus')[0].mod?.statLines)
      .toEqual(['(27-42)% increased Armour, Evasion and Energy Shield']);
    expect(crafts.searchEssencesByStat('Energy Shield').some(hit => hit.essence.name === 'Lesser Essence of Enhancement')).toBe(true);
    expect(crafts.getEssence('Deafening Essence of Greed')).toBeNull();
  });

  it('reports the missing native bench mechanism without fabricating a pool', () => {
    expect(existsSync(crafts.getModMasterPath())).toBe(false);
    expect(() => crafts.searchMasterCrafts({ itemType: 'Ring' })).toThrow(crafts.PobCraftUnsupportedError);
    expect(crafts.getEssenceCount()).toBeGreaterThan(70);
  });

  it('records data coverage without reading or retaining any user content', () => {
    const essences = crafts.findEssencesMatching('', Number.POSITIVE_INFINITY);
    const references = essences.flatMap(essence => crafts.resolveEssenceMods(essence.name));
    const unresolved = references.filter(reference => reference.mod === null);
    expect(references.filter(reference => reference.mod !== null).length).toBeGreaterThan(400);
    console.info('Native PoB2 read evidence:', JSON.stringify({
      bases: bases.getBaseCount(), itemMods: mods.getModCount(), essences: crafts.getEssenceCount(),
      essenceReferences: references.length, resolvedReferences: references.length - unresolved.length,
      unresolvedIds: [...new Set(unresolved.map(reference => reference.modId))],
    }));
  });
});
