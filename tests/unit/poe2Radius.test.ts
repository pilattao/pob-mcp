import { describe, it, expect, beforeEach, afterEach, jest } from '@jest/globals';
import fs from 'fs';
import os from 'os';
import path from 'path';
import * as loader from '../../src/services/pobTreeDataLoader.js';
import { legacyJewelTree } from '../fixtures/jewelRadiusFixture.js';
import { getJewelRadius, getNodePositionById, nodesInRadius, angleForOrbitIndex } from '../../src/services/radiusUtils.js';
import { findRadiusEffectJewels, isRadiusEffectMod } from '../../src/services/radiusEffectJewelService.js';
import { evaluateThreshold } from '../../src/services/thresholdJewelService.js';

describe('PoE2 radius geometry and item semantics', () => {
  let directory: string;
  let saved: NodeJS.ProcessEnv;
  let tree: loader.PobTreeData;
  beforeEach(() => {
    saved = { ...process.env };
    directory = fs.mkdtempSync(path.join(os.tmpdir(), 'poe2-radius-'));
    process.env.POE_GAME = 'poe2'; process.env.POB_INSTALL_DIR = directory;
    fs.mkdirSync(path.join(directory, 'Data')); fs.mkdirSync(path.join(directory, 'Modules'));
    fs.writeFileSync(path.join(directory, 'GameVersions.lua'), 'liveTargetVersion = "0_1"');
    fs.writeFileSync(path.join(directory, 'Data/Misc.lua'), 'local data=...; data.gameConstants={PassiveTreeJewelDistanceMultiplier=1.2}');
    fs.writeFileSync(path.join(directory, 'Modules/Data.lua'), 'data.jewelRadii={["0_1"]={{inner=0,outer=1000,label="Small"},{inner=0,outer=1150,label="Medium"},{inner=0,outer=1300,label="Large"},{inner=0,outer=1500,label="Very Large"},{inner=650,outer=950,label="Variable"},{inner=800,outer=1100,label="Variable"},{inner=950,outer=1250,label="Variable"},{inner=1100,outer=1400,label="Variable"}}}');
    tree = legacyJewelTree(); tree.tree = '0_5';
    // Native Lua numbered tables are 1-indexed; orbit 2 has 24 positions.
    tree.constants = { orbitRadii: { 1: 0, 2: 82, 3: 162 }, skillsPerOrbit: { 1: 1, 2: 12, 3: 24 }, orbitAnglesByOrbit: { 1: { 1: 0 }, 3: { 2: Math.PI / 12 } } };
    tree.nodes['6712'].group = 1; tree.nodes['6712'].orbit = 2; tree.nodes['6712'].orbitIndex = 1;
    for (const [id, x, extra] of [
      [101, 1199, {}], [102, 1320, {}], [103, 1680, { isNotable: true }], [104, 1681, {}],
      [105, 1100, { isAttribute: true }], [106, 1100, { isMastery: true }], [107, 1100, { isProxy: true }],
    ] as const) {
      tree.groups[String(id)] = { x, y: 0, nodes: [], orbits: [0] };
      tree.nodes[String(id)] = { skill: id, name: `Node ${id}`, group: id, orbit: 0, orbitIndex: 0, stats: [], in: [], out: [], ...extra };
    }
    jest.spyOn(loader, 'getPobTreeData').mockImplementation(version => { if (version && version !== tree.tree) throw new Error('wrong version'); return tree; });
    jest.spyOn(loader, 'getLoadedVersion').mockImplementation(() => tree.tree);
  });
  afterEach(() => {
    jest.restoreAllMocks();
    for (const key of ['POE_GAME', 'POB_INSTALL_DIR']) { if (saved[key] === undefined) delete process.env[key]; else process.env[key] = saved[key]; }
    fs.rmSync(directory, { recursive: true, force: true });
  });
  it('uses native radians and Lua indexing instead of PoE1 orbit-number assumptions', () => {
    const position = getNodePositionById('6712')!;
    expect(position.x).toBeCloseTo(162 * Math.sin(Math.PI / 12));
    expect(position.y).toBeCloseTo(-162 * Math.cos(Math.PI / 12));
  });
  it('does not cache constants across game trees', () => {
    getNodePositionById('6712');
    tree = legacyJewelTree(); tree.nodes['6712'].group = 1; tree.nodes['6712'].orbit = 2; tree.nodes['6712'].orbitIndex = 1;
    delete process.env.POE_GAME;
    expect(getNodePositionById('6712')!.x).toBeCloseTo(81); // legacy 30 degrees
  });
  it('excludes native mastery/proxy nodes and does not turn a missing socket into an empty radius', () => {
    expect(nodesInRadius('26196', 1200)).not.toEqual(expect.arrayContaining(['106', '107']));
    expect(() => nodesInRadius('missing', 1200)).toThrow(/socket|position/i);
  });
  it('uses PoE2 Small = 1000 * 1.2 and Time-Lost small-passive restrictions', () => {
    const result = findRadiusEffectJewels([{ socketNodeId: '26196', jewelName: 'Time-Lost Ruby', mods: ['Radius: Small', 'Small Passive Skills in Radius also grant 3% increased Armour'] }], new Set(['26196','101','103','105','106','107']));
    expect(result.jewels[0].radius).toBe(1200);
    expect(result.jewels[0].affectedAllocated).toEqual(['101']);
  });
  it('honours Time-Lost radius upgrades and notable-only effects', () => {
    const result = findRadiusEffectJewels([{ socketNodeId: '26196', jewelName: 'Time-Lost Ruby', mods: ['Radius: Small', 'Upgrades Radius to Very Large', 'Notable Passive Skills in Radius also grant +5 to Strength'] }], new Set(['26196','101','103','105']));
    expect(result.jewels[0].radius).toBe(1800);
    expect(result.jewels[0].affectedAllocated).toEqual(['103']);
  });
  it('uses both inclusive Medium Ring boundaries and exposes eligible unallocated nodes', () => {
    const result: any = findRadiusEffectJewels([{ socketNodeId: '26196', jewelName: 'Controlled Metamorphosis', mods: ['Radius: Variable', 'Only affects Passives in Medium Ring', 'Passives in Radius can be Allocated without being connected to your tree'] }], new Set(['26196','102']));
    expect(result.jewels[0].radius).toBe(1680);
    expect(result.jewels[0].innerRadius).toBe(1320);
    expect(result.jewels[0].affectedAllocated).toEqual(['102']);
    expect(result.jewels[0].eligibleUnallocated).toEqual(['103']);
  });
  it('rejects ambiguous variable radius and unsupported legacy threshold evaluation', () => {
    expect(() => findRadiusEffectJewels([{ socketNodeId: '26196', jewelName: 'Controlled Metamorphosis', mods: ['Radius: Variable', 'Passives in Radius can be Allocated without being connected to your tree'] }], new Set())).toThrow(/radius.*unknown|ring.*unknown|unavailable/i);
    expect(() => evaluateThreshold({ attribute: 'Strength', requiredAmount: 40, rawMod: 'With at least 40 Strength in Radius, effect' }, '26196', new Set(), 1200)).toThrow(/PoE2.*threshold|threshold.*PoE2/);
  });
  it('identifies actual PoE2 Timeless conquest separately from generic radius effects', () => {
    expect(isRadiusEffectMod('Passives in radius are Conquered by the Kalguur')).toBe(false);
    expect(isRadiusEffectMod('Passives in radius are Conquered by the Abyssals')).toBe(false);
  });
  it('does not claim an inactive socket or an unmodeled self-effect modifies allocated nodes', () => {
    const jewel = { socketNodeId: '26196', jewelName: 'Time-Lost Ruby', mods: ['Radius: Small', 'Small Passive Skills in Radius also grant 3% increased Armour'] };
    expect(findRadiusEffectJewels([jewel], new Set(['101'])).jewels[0].affectedAllocated).toEqual([]);
    jewel.mods[1] = 'Grants all bonuses of Unallocated Small Passive Skills in Radius';
    expect(() => findRadiusEffectJewels([jewel], new Set(['26196','101']))).toThrow(/unavailable|unimplemented/);
  });
  it('does not pick a Variable ring or substitute PoE1 constants for missing native angles/data', () => {
    expect(() => getJewelRadius('Variable')).toThrow(/unknown|unavailable|variant/i);
    delete (tree.constants as any).orbitAnglesByOrbit;
    expect(getNodePositionById('6712')).toBeNull();
    fs.rmSync(path.join(directory, 'Data/Misc.lua'));
    expect(() => getJewelRadius('Small')).toThrow();
  });
  it('preserves legacy irregular 40-position orbits and rejects invalid bounds', () => {
    tree = legacyJewelTree(); process.env.POE_GAME = 'poe1';
    expect(angleForOrbitIndex(4, 5)).toBeCloseTo(45);
    expect(() => nodesInRadius('26196', -1)).toThrow(/bounds/);
    expect(() => nodesInRadius('26196', { inner: 100, outer: 50 })).toThrow(/bounds/);
  });
});
