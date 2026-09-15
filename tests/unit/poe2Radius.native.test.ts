import { describe, it, expect } from '@jest/globals';
import { execFileSync } from 'child_process';
import path from 'path';
import { getPobTreeData } from '../../src/services/pobTreeDataLoader.js';
import { getJewelRadius, getNodePositionById, nodesInRadius } from '../../src/services/radiusUtils.js';
import { findRadiusEffectJewels } from '../../src/services/radiusEffectJewelService.js';

const install = process.env.POE2_RADIUS_NATIVE_INSTALL;
const native = install ? describe : describe.skip;
native('installed PoB2 jewel radius proof', () => {
  it('matches native ProcessNode, all 12 radius bands, and native Time-Lost target functions', () => {
    const proof = JSON.parse(execFileSync(process.env.POE2_RADIUS_PYTHON ?? path.resolve('..', '.venv', 'bin', 'python'),
      [path.resolve('tests/unit/poe2RadiusNative.py'), install!, '0_5'], { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 }));
    const context = { treeVersion: '0_5', tree: getPobTreeData('0_5') };
    expect(proof.radii).toHaveLength(12);
    for (const sample of Object.values(proof.positions) as any[]) {
      const pos = getNodePositionById(sample.id, context)!;
      expect(pos.x).toBeCloseTo(sample.x, 8); expect(pos.y).toBeCloseTo(sample.y, 8);
    }
    for (const [socketId, socket] of Object.entries(proof.sockets) as [string, any][]) {
      for (const expected of proof.radii) {
        const radius = getJewelRadius(expected.index, context);
        expect(radius).toMatchObject(expected);
        expect(nodesInRadius(socketId, radius, undefined, context).sort()).toEqual(socket.memberships[String(expected.index)]);
      }
      const allocated = new Set(Object.keys(context.tree.nodes));
      const result = findRadiusEffectJewels([
        { socketNodeId: socketId, jewelName: 'Time-Lost Ruby', mods: ['Radius: Small', '10% increased Effect of Small Passive Skills in Radius'] },
        { socketNodeId: socketId, jewelName: 'Time-Lost Ruby', mods: ['Radius: Small', 'Upgrades Radius to Very Large', '10% increased Effect of Notable Passive Skills in Radius'] },
      ], allocated, context);
      expect(result.jewels[0].affectedAllocated.sort()).toEqual(socket.smallTargets);
      expect(result.jewels[1].affectedAllocated.sort()).toEqual(socket.notableTargets);
      const ring = findRadiusEffectJewels([{ socketNodeId: socketId, jewelName: 'Controlled Metamorphosis', mods: [
        'Radius: Variable', 'Only affects Passives in Medium Ring', 'Passives in Radius can be Allocated without being connected to your tree',
      ] }], new Set([socketId]), context);
      expect(ring.jewels[0].eligibleUnallocated!.sort()).toEqual(socket.mediumRingTargets);
    }
    expect(proof.catalog).toContain('Controlled Metamorphosis');
    expect(proof.catalog).toContain('Heroic Tragedy');
    expect(proof.catalog).toContain('Undying Hate');
    for (const absent of ['Energy From Within', 'Healthy Mind', 'Brawn', 'Might of the Meek', 'Frozen Trail']) expect(proof.catalog).not.toContain(absent);
    expect(proof.attributeThresholdItems).toEqual([]);
    expect(proof.attributeThresholdAffixes).toEqual([]);
    expect(proof.timeLostBases).toHaveLength(4);
  }, 30000);
});
