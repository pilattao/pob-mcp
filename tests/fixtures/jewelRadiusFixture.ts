import type { PobTreeData } from '../../src/services/pobTreeDataLoader.js';

/** Synthetic geometry, deliberately independent of an installed game. */
export function legacyJewelTree(): PobTreeData {
  const node = (skill: number, group: number, stats: string[] = [], extra = {}) => ({
    skill, group, orbit: 0, orbitIndex: 0, name: `Fixture ${skill}`, stats, in: [], out: [], ...extra,
  });
  return {
    tree: '3_26', classes: [],
    constants: { orbitRadii: [0, 82, 162, 335, 493, 662, 846], skillsPerOrbit: [1, 6, 16, 16, 40, 72, 72] },
    groups: {
      '1': { x: 0, y: 0, nodes: [], orbits: [0] },
      '2': { x: 1000, y: 0, nodes: [], orbits: [0] },
      '3': { x: 10000, y: 0, nodes: [], orbits: [0] },
      '4': { x: 10200, y: 0, nodes: [], orbits: [0] },
    },
    nodes: {
      '26196': node(26196, 1, [], { isJewelSocket: true }),
      '6712': node(6712, 2, ['5% increased maximum Life']),
      '7162': node(7162, 3, [], { isJewelSocket: true }),
      '40': node(40, 4),
    },
  } as PobTreeData;
}
