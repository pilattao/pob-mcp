import fs from 'fs';
import os from 'os';
import path from 'path';
import * as loader from '../../src/services/pobTreeDataLoader.js';
import { legacyJewelTree } from '../fixtures/jewelRadiusFixture.js';
import { parseTimelessJewelMod, findAffectedNodes } from '../../src/services/timelessJewelService.js';
import { handleListRadiusEffectJewels } from '../../src/handlers/radiusEffectJewelHandler.js';
import { handleEvaluateThresholdJewels } from '../../src/handlers/thresholdJewelHandler.js';
import { handleFindJewelAffectedNodes } from '../../src/handlers/timelessJewelHandlers.js';

const text = (r: any) => r.content.map((c: any) => c.text).join('\n');
describe('PoE2 jewel handler context and honest Timeless awareness', () => {
  let directory: string, saved: NodeJS.ProcessEnv, tree: loader.PobTreeData;
  let client: any, context: any;
  const heroic = { slot: 'Jewel 26196', id: 1, name: 'Heroic Tragedy', raw: 'Rarity: UNIQUE\nHeroic Tragedy\nTimeless Jewel\nRadius: Very Large\nRemembrancing 1234 songworthy deeds by the line of Vorana\nPassives in radius are Conquered by the Kalguur\nHistoric' };
  beforeEach(() => {
    saved = { ...process.env }; process.env.POE_GAME = 'poe2';
    directory = fs.mkdtempSync(path.join(os.tmpdir(), 'poe2-jewel-handlers-')); process.env.POB_INSTALL_DIR = directory;
    fs.mkdirSync(path.join(directory, 'Data/Uniques'), { recursive: true }); fs.mkdirSync(path.join(directory, 'Modules'));
    fs.writeFileSync(path.join(directory, 'GameVersions.lua'), 'liveTargetVersion="0_1"');
    fs.writeFileSync(path.join(directory, 'Modules/Data.lua'), 'data.jewelRadii={["0_1"]={{inner=0,outer=1000,label="Small"},{inner=0,outer=1150,label="Medium"},{inner=0,outer=1300,label="Large"},{inner=0,outer=1500,label="Very Large"},{inner=650,outer=950,label="Variable"},{inner=800,outer=1100,label="Variable"},{inner=950,outer=1250,label="Variable"},{inner=1100,outer=1400,label="Variable"}}}');
    fs.writeFileSync(path.join(directory, 'Data/Misc.lua'), 'data.gameConstants={PassiveTreeJewelDistanceMultiplier=1.2}');
    fs.writeFileSync(path.join(directory, 'Data/Uniques/jewel.lua'), 'return {[[Heroic Tragedy\nTimeless Jewel\nRadius: Very Large\nRemembrancing (100-8000) songworthy deeds by the line of Vorana\nRemembrancing (100-8000) songworthy deeds by the line of Medved\nRemembrancing (100-8000) songworthy deeds by the line of Olroth]],[[Undying Hate\nTimeless Jewel\nRadius: Very Large\nGlorifying the defilement of (100-8000) souls in tribute to Amanamu\nGlorifying the defilement of (100-8000) souls in tribute to Kulemak]]}');
    tree = legacyJewelTree(); tree.tree = '0_4';
    tree.constants = { orbitRadii: [0], orbitAnglesByOrbit: [[0]] };
    tree.nodes['6712'].name = 'Exact active passive';
    tree.groups['4'].x = 1400;
    tree.nodes['40'].name = 'Ring candidate';
    jest.spyOn(loader, 'getPobTreeData').mockImplementation(version => { if (version !== '0_4') throw new Error('Latest or wrong version requested'); return tree; });
    client = {
      getBuildInfo: jest.fn().mockResolvedValue({ game: 'poe2', treeVersion: '0_4', name: 'Fixture' }),
      getTree: jest.fn().mockResolvedValue({ treeVersion: '0_4', nodes: [26196, 6712], weaponSets: {} }),
      getItems: jest.fn().mockResolvedValue([heroic]),
      listItemSets: jest.fn().mockResolvedValue({ itemSets: [{ id: 1, active: true, useSecondWeaponSet: false }] }),
      getNodeState: jest.fn().mockResolvedValue({ id: 6712, dn: 'Native current name', type: 'normal', allocated: true, sd: ['Native currently reported stat'], conqueredBy: { seed: 1234, conqueror_type: 'kalguur' } }),
    };
    context = { ensureLuaClient: async () => {}, getLuaClient: () => client };
  });
  afterEach(() => {
    jest.restoreAllMocks(); fs.rmSync(directory, { recursive: true, force: true });
    for (const key of ['POE_GAME', 'POB_INSTALL_DIR']) { if (saved[key] === undefined) delete process.env[key]; else process.env[key] = saved[key]; }
  });
  it.each([
    ['Heroic Tragedy', 'Remembrancing 1234 songworthy deeds by the line of Vorana', 'Vorana', 'kalguur'],
    ['Undying Hate', 'Glorifying the defilement of 4321 souls in tribute to Kulemak', 'Kulemak', 'abyss'],
  ])('recognizes native %s with its native leader and radius', (name, mod, leader, conqueror) => {
    const parsed: any = (parseTimelessJewelMod as any)(name, [mod], { treeVersion: '0_4', tree });
    expect(parsed).toMatchObject({ jewelType: name, historicCharacter: leader, radius: 1800, conquerorType: conqueror, game: 'poe2' });
  });
  it('rejects an unverified leader or invalid seed instead of fabricating a valid PoE2 jewel', () => {
    expect(() => (parseTimelessJewelMod as any)('Heroic Tragedy', ['Remembrancing 1234 songworthy deeds by the line of Uhtred'], { treeVersion: '0_4', tree })).toThrow(/leader|catalog|unavailable/i);
    expect(() => (parseTimelessJewelMod as any)('Heroic Tragedy', ['Remembrancing 9000 songworthy deeds by the line of Vorana'], { treeVersion: '0_4', tree })).toThrow(/seed|catalog/i);
  });
  it('keeps PoE1-only jewels out of a PoE2 evaluation', () => {
    const result: any = (findAffectedNodes as any)([{ socketNodeId: '26196', jewelName: 'Lethal Pride', mods: ['Commanded leadership over 10678 warriors under Kaom'] }], new Set(['26196','6712']), { treeVersion: '0_4', tree });
    expect(result.timelessJewels).toHaveLength(0);
    expect(result.unresolvedJewels[0].reason).toMatch(/PoE1|PoE2|catalog/i);
  });
  it('reports native node state as evidence without asserting complete seed transformations', async () => {
    const result = await handleFindJewelAffectedNodes(context);
    expect(result.isError).not.toBe(true);
    const report = text(result);
    expect(report).toContain('Heroic Tragedy'); expect(report).toContain('1800');
    expect(report).toContain('Exact active passive');
    expect(report).toContain('Native currently reported stat');
    expect(report).toMatch(/conquest.*1234.*kalguur/i);
    expect(report).toMatch(/not.*proof|does not prove|not established/i);
    expect(report).not.toMatch(/nodes are being transformed|paste the in-game tooltip|requires.*extraction/i);
  });
  it('does not infer untransformed stats from missing conquest metadata', async () => {
    client.getNodeState.mockResolvedValue({ id: 6712, dn: 'Native', allocated: true, sd: [] });
    const report = text(await handleFindJewelAffectedNodes(context));
    expect(report).toMatch(/conquest.*unavailable|conquest.*not reported/i);
    expect(report).not.toMatch(/NOT being transformed|match the base|untransformed/i);
  });
  it('keeps missing seed data visible instead of reporting no Timeless jewels', async () => {
    client.getItems.mockResolvedValue([{ ...heroic, raw: 'Heroic Tragedy\nTimeless Jewel\nHistoric' }]);
    const report = text(await handleFindJewelAffectedNodes(context));
    expect(report).toMatch(/unavailable|unresolved|missing/i);
    expect(report).not.toContain('No Timeless Jewels');
  });
  it('reports radius rings, unallocated eligibility, and exact-version labels', async () => {
    client.getItems.mockResolvedValue([{ ...heroic, name: 'Controlled Metamorphosis', raw: 'Controlled Metamorphosis\nRadius: Variable\nOnly affects Passives in Medium Ring\nPassives in Radius can be Allocated without being connected to your tree' }]);
    const report = text(await handleListRadiusEffectJewels(context));
    expect(report).toContain('1320'); expect(report).toContain('1680'); expect(report).toContain('Ring candidate');
    expect(report).toMatch(/eligible unallocated/i);
    expect(report).not.toMatch(/Energy From Within|Healthy Mind|Might of the Meek/);
  });
  it('filters empty slots and wrong weapon-set allocations', async () => {
    client.getItems.mockResolvedValue([{ slot: 'Jewel 7162', id: 0 }, { ...heroic, name: 'Time-Lost Ruby', raw: 'Time-Lost Ruby\nRadius: Small\nSmall Passive Skills in Radius also grant 3% increased Armour' }]);
    client.getTree.mockResolvedValue({ treeVersion: '0_4', nodes: [26196,6712], weaponSets: { 6712: 2 } });
    const report = text(await handleListRadiusEffectJewels(context));
    expect(report).toMatch(/Scanned 1 jewel/);
    expect(report).toMatch(/weapon set 1/i);
    expect(report).not.toContain('Exact active passive');
  });
  it.each([handleListRadiusEffectJewels, handleEvaluateThresholdJewels, handleFindJewelAffectedNodes])('rejects conflicting or missing native tree versions', async handler => {
    client.getBuildInfo.mockResolvedValue({ game: 'poe2', treeVersion: '0_5' });
    expect((await handler(context)).isError).toBe(true);
    client.getBuildInfo.mockResolvedValue({ game: 'poe2' }); client.getTree.mockResolvedValue({ nodes: [26196] });
    expect((await handler(context)).isError).toBe(true);
  });
  it('states the PoE2 threshold limitation without PoE1 equipment recommendations', async () => {
    client.getItems.mockResolvedValue([]);
    const report = text(await handleEvaluateThresholdJewels(context));
    expect(report).toMatch(/PoE2/); expect(report).toMatch(/unavailable|not established|not verified/);
    expect(report).not.toMatch(/Brawn|Conqueror|800 units|ALLOCATED nodes/);
  });
  it('returns a readable error when a PoE2 radius variant is unknown', async () => {
    client.getItems.mockResolvedValue([{ ...heroic, name: 'Controlled Metamorphosis', raw: 'Radius: Variable\nPassives in Radius can be Allocated without being connected to your tree' }]);
    const result = await handleListRadiusEffectJewels(context);
    expect(result.isError).toBe(true); expect(text(result)).toMatch(/unknown|unavailable/);
  });
  it('keeps only the selected ring variant', async () => {
    client.getItems.mockResolvedValue([{ ...heroic, name: 'Controlled Metamorphosis', raw: 'Radius: Variable\nSelected Variant: 2\n{variant:1}Only affects Passives in Small Ring\n{variant:2}Only affects Passives in Medium Ring\nPassives in Radius can be Allocated without being connected to your tree' }]);
    const result = await handleListRadiusEffectJewels(context);
    expect(result.isError).toBe(false); expect(text(result)).toContain('1320–1680');
  });
  it('rejects a scan if tree allocation changes during native reads', async () => {
    client.getTree.mockResolvedValueOnce({ treeVersion: '0_4', nodes: [26196,6712], weaponSets: {} })
      .mockResolvedValue({ treeVersion: '0_4', nodes: [26196], weaponSets: {} });
    const result = await handleFindJewelAffectedNodes(context);
    expect(result.isError).toBe(true); expect(text(result)).toMatch(/changed/);
  });
  it('does not guess an active weapon set from a missing item-set response', async () => {
    client.getTree.mockResolvedValue({ treeVersion: '0_4', nodes: [26196,6712], weaponSets: { 6712: 2 } });
    client.listItemSets.mockResolvedValue({ itemSets: [] });
    expect((await handleFindJewelAffectedNodes(context)).isError).toBe(true);
  });
  it('uses an exact get_tree version if get_build_info is unavailable', async () => {
    client.getBuildInfo.mockRejectedValue(new Error('not supported'));
    const result = await handleFindJewelAffectedNodes(context);
    expect(result.isError).toBe(false); expect(text(result)).toContain('active tree: 0_4');
  });
  it('reports native-state failure as unknown without substituting static stats', async () => {
    client.getNodeState.mockRejectedValue(new Error('node state unavailable'));
    const result = await handleFindJewelAffectedNodes(context);
    expect(result.isError).toBe(false); expect(text(result)).toContain('native state unavailable');
    expect(text(result)).not.toContain('5% increased maximum Life');
  });
  it('bounds native node reads and reports the unread remainder', async () => {
    const ids = [26196];
    for (let id = 100; id < 135; id++) { tree.nodes[String(id)] = { ...tree.nodes['6712'], skill: id }; ids.push(id); }
    client.getTree.mockResolvedValue({ treeVersion: '0_4', nodes: ids, weaponSets: {} });
    client.getNodeState.mockImplementation(async ({ node_id }: any) => ({ id: Number(node_id), sd: ['Native stat'] }));
    const result = await handleFindJewelAffectedNodes(context);
    expect(result.isError).toBe(false); expect(client.getNodeState).toHaveBeenCalledTimes(30);
    expect(text(result)).toContain('5 additional candidates were not read');
  });
  it('does not request transformed state for an unallocated socket', async () => {
    client.getTree.mockResolvedValue({ treeVersion: '0_4', nodes: [6712], weaponSets: {} });
    const result = await handleFindJewelAffectedNodes(context);
    expect(result.isError).toBe(false); expect(text(result)).toContain('effect inactive');
    expect(client.getNodeState).not.toHaveBeenCalled();
  });
  it('requires native catalog presence for PoE2 Timeless awareness', async () => {
    fs.writeFileSync(path.join(directory, 'Data/Uniques/jewel.lua'), 'return {}');
    const result = await handleFindJewelAffectedNodes(context);
    expect(text(result)).toContain('absent from the installed poe2 jewel catalog');
    expect(text(result)).not.toContain('No recognized Timeless');
  });
  it('preserves actual legacy threshold semantics in the handler', async () => {
    process.env.POE_GAME = 'poe1'; tree.tree = '3_26'; tree.nodes['6712'].stats = ['+40 to Strength'];
    jest.spyOn(loader, 'getPobTreeData').mockImplementation(version => { if (version !== '3_26') throw new Error('wrong legacy version'); return tree; });
    client.getBuildInfo.mockResolvedValue({ game: 'poe1', treeVersion: '3_26' });
    client.getTree.mockResolvedValue({ treeVersion: '3_26', nodes: [26196], weaponSets: {} });
    client.getItems.mockResolvedValue([{ ...heroic, name: 'Divine Inferno', raw: 'Radius: Medium\nWith at least 40 Strength in Radius, Combust is Disabled' }]);
    const result = await handleEvaluateThresholdJewels(context);
    expect(result.isError).toBe(false); expect(text(result)).toContain('Met: Strength 40/40');
    expect(text(result)).toContain('unallocated nodes');
  });
});
