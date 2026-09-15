import { describe, it, expect } from '@jest/globals';
import { getPobNode, getPobTreeData, getLoadedVersion } from '../../src/services/pobTreeDataLoader';

// These tests depend on the PathOfBuilding submodule being checked out
// with at least one TreeData/X_Y/tree.lua present. CI environments without
// the submodule will skip via the existence check.
import { existsSync } from 'fs';
import { resolve } from 'path';

const pobDir = process.env.POB_DIRECTORY ?? resolve(process.cwd(), '..', 'PathOfBuilding');
const hasPobSubmodule = existsSync(resolve(pobDir, 'src', 'TreeData'));

const describeIfPob = hasPobSubmodule ? describe : describe.skip;

describeIfPob('pobTreeDataLoader', () => {
  it('finds a current tree version directory', () => {
    const version = getLoadedVersion();
    expect(version).toMatch(/^\d+_\d+$/);
  });

  it('parses tree.lua and returns a tree object with nodes and groups', () => {
    const tree = getPobTreeData();
    expect(tree).toBeDefined();
    expect(tree.nodes).toBeDefined();
    expect(typeof tree.nodes).toBe('object');
    expect(Object.keys(tree.nodes).length).toBeGreaterThan(1000); // PoE has thousands of passives
    expect(tree.groups).toBeDefined();
    expect(typeof tree.groups).toBe('object');
  });

  it('returns null for an unknown node ID', () => {
    const node = getPobNode('99999999');
    expect(node).toBeNull();
  });

  it('returns the known static node for the selected game without jewel-derived stats', () => {
    const poe2 = getLoadedVersion().startsWith('0_');
    const node = getPobNode(poe2 ? '31223' : '11730');
    expect(node).not.toBeNull();
    if (!node) return;
    expect(node.isNotable).toBe(true);
    if (poe2) {
      expect(node.name).toBe('Crimson Power');
      expect(node.stats).toEqual(['Gain additional maximum Life equal to 100% of the Item Energy Shield on Equipped Body Armour']);
    } else {
      expect(node.name).toBe('Endurance');
      expect(node.stats).toEqual(['+1 to Maximum Endurance Charges']);
    }
    expect(node.stats.some(stat => stat.toLowerCase().includes('leech'))).toBe(false);
  });

  it("normalizes connection fields without assuming the other game's graph", () => {
    const poe2 = getLoadedVersion().startsWith('0_');
    const node = getPobNode(poe2 ? '31223' : '11730')!;
    expect(Array.isArray(node.in)).toBe(true);
    expect(Array.isArray(node.out)).toBe(true);
    if (poe2) {
      expect([...node.in, ...node.out].map(String)).toContain('50192');
    } else {
      expect(node.in.length).toBeGreaterThan(0);
      expect(node.out.length).toBe(0);
    }
  });

  it('caches tree data — second call is fast', () => {
    const t0 = Date.now();
    getPobTreeData();
    const firstMs = Date.now() - t0;
    const t1 = Date.now();
    getPobTreeData();
    const secondMs = Date.now() - t1;
    // First call may be cache hit too (other tests run first), so we just
    // assert both are reasonable times. The cache is keyed by mtime so the
    // file hasn't changed between calls.
    expect(firstMs).toBeLessThan(500);
    expect(secondMs).toBeLessThan(50);
  });
});
