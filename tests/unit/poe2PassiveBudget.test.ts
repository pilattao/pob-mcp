import { TreeService } from '../../src/services/treeService.js';
import { BuildService } from '../../src/services/buildService.js';
import { handleAnalyzeBuild } from '../../src/handlers/buildHandlers.js';
import { ValidationService } from '../../src/services/validationService.js';
import type { PoBBuild, PassiveTreeNode } from '../../src/types.js';
import { poe2PassiveBudget } from '../../src/services/passiveBudget.js';

// Synthetic counts from the 0_5 case; no private character XML is stored here.
function fixture(one = 24, two = 24) {
  const nodes: PassiveTreeNode[] = Array.from({ length: 92 + one + two }, (_, i) => ({ skill: i + 1 }));
  nodes.push(...Array.from({ length: 8 }, (_, i) => ({ skill: 300 + i, ascendancyName: 'Blood Mage' })));
  nodes.push({ skill: 400, classesStart: ['Witch'] } as any);
  nodes.push({ skill: 401, ascendancyName: 'Blood Mage', isAscendancyStart: true });
  nodes.push({ skill: 402, name: 'Sanguimancy', ascendancyName: 'Blood Mage', isFreeAllocate: true } as any);
  const spec = {
    treeVersion: '0_5', nodes: nodes.map(n => n.skill).join(','),
    WeaponSet1: { nodes: nodes.slice(92, 92 + one).map(n => n.skill).join(',') },
    WeaponSet2: { nodes: nodes.slice(92 + one, 92 + one + two).map(n => n.skill).join(',') },
  };
  const build: PoBBuild = { __xmlRoot: 'PathOfBuilding2', Build: { level: '93' }, Tree: { Spec: spec } };
  const builds = new BuildService('/unused');
  const trees = new TreeService(builds);
  jest.spyOn(trees, 'getTreeData').mockResolvedValue({ version: '0_5', nodes: new Map(nodes.map(n => [String(n.skill), n])) });
  return { build, builds, trees, spec, nodes };
}

describe('PoE2 passive budget and analyze_build', () => {
  it('rejects the legacy aggregate counter for PoE2 instead of using a PoE1 budget', () => {
    const { build, trees } = fixture();
    expect(() => trees.calculatePassivePoints(build, 141)).toThrow(/PoE2.*analyzePassiveTree/);
  });

  it('counts both weapon trees separately and excludes starts and free ascendancy nodes', async () => {
    const { build, trees } = fixture();
    const result: any = await trees.analyzePassiveTree(build);
    expect(result.totalPoints).toBe(116);
    expect(result.availablePoints).toBe(116);
    expect(result.passiveBudget).toMatchObject({ nonAscendancyPoints: 140, sharedPoints: 92, weaponSetPoints: [24, 24], perWeaponPoints: [116, 116], ascendancyPoints: 8 });
  });

  it('uses the larger weapon set, never an average or the union', async () => {
    const { build, trees } = fixture(24, 12);
    const result: any = await trees.analyzePassiveTree(build);
    expect(result.totalPoints).toBe(116);
    expect(result.passiveBudget.perWeaponPoints).toEqual([116, 104]);
  });

  it('detects weapon-specific overspend independently of total spend', async () => {
    const { build, trees } = fixture(25, 1);
    build.Build!.level = '100';
    const result: any = await trees.analyzePassiveTree(build);
    expect(result.totalPoints).toBeLessThan(result.availablePoints);
    expect(result.passiveBudget.warnings.join(' ')).toMatch(/Weapon set 1.*25.*24/);
  });

  it('uses the selected spec, deduplicates nodes, and excludes free granted nodes', async () => {
    const { build, trees, spec, nodes } = fixture(0, 0);
    Object.assign(nodes[0], { isGrantedPassive: true, isFreeAllocate: true });
    spec.nodes += ',2,2';
    build.Tree = { activeSpec: '2', Spec: [{ treeVersion: '0_5', nodes: '2' }, spec] };
    const result: any = await trees.analyzePassiveTree(build);
    expect(result.totalPoints).toBe(91);
    expect(result.passiveBudget.ascendancyPoints).toBe(8);
  });

  it('leaves budgets for unverified tree versions unknown', async () => {
    const { build, trees, spec, nodes } = fixture();
    spec.treeVersion = '0_99';
    jest.spyOn(trees, 'getTreeData').mockResolvedValue({ version: '0_99', nodes: new Map(nodes.map(n => [String(n.skill), n])) });
    const log = jest.spyOn(console, 'error').mockImplementation(() => {});
    try { await expect(trees.analyzePassiveTree(build)).rejects.toThrow(/budget unknown/i); }
    finally { log.mockRestore(); }
  });

  it('uses native extra and converted points without adding converted points to the total pool', async () => {
    const { build, trees } = fixture(26, 26);
    const result = await trees.analyzePassiveTree(build, { ExtraPoints: 2, PassivePointsToWeaponSetPoints: 2 });
    expect(result!.totalPoints).toBe(118);
    expect(result!.availablePoints).toBe(118);
    expect(result!.passiveBudget!.weaponSetLimit).toBe(26);
    expect(result!.passiveBudget!.warnings).toEqual([]);
  });

  it('distinguishes proven overspend from missing native extra-point information', () => {
    const { build, nodes } = fixture(25, 25);
    const known = poe2PassiveBudget(build, nodes, { ExtraPoints: 0, PassivePointsToWeaponSetPoints: 0 });
    expect(known.warnings.join(' ')).toMatch(/exceeds the budget/);
    const unknown = poe2PassiveBudget(build, nodes);
    expect(unknown.warnings.join(' ')).toMatch(/baseline.*native extra points must be checked/);
    expect(unknown.warnings.join(' ')).not.toMatch(/impossible|exceeds the budget/);
  });

  it('does not invent a level, and rejects ambiguous weapon assignments', () => {
    const { build, nodes, spec } = fixture();
    delete build.Build!.level;
    expect(poe2PassiveBudget(build, nodes).availablePoints).toBeNull();
    spec.WeaponSet2.nodes = spec.WeaponSet1.nodes;
    expect(() => poe2PassiveBudget(build, nodes)).toThrow(/assigned to both weapon sets/);
  });

  it('excludes ascendancy choice options and keeps separate ascendancy caps', () => {
    const { build, nodes } = fixture();
    nodes.push({ skill: 500, ascendancyName: 'Blood Mage', isMultipleChoiceOption: true } as any);
    nodes.push(...Array.from({ length: 8 }, (_, i) => ({ skill: 600 + i, ascendancyName: 'Secondary' })));
    expect(poe2PassiveBudget(build, nodes).ascendancyPoints).toBe(16);
    expect(poe2PassiveBudget(build, nodes).warnings).toEqual([]);
    nodes.push({ skill: 700, ascendancyName: 'Blood Mage' });
    expect(poe2PassiveBudget(build, nodes).warnings.join(' ')).toMatch(/Blood Mage spends 9 \/ 8/);
  });

  it('passes selected live items/spec and native extra points to validation and budgeting', async () => {
    const { build, builds, trees } = fixture(25, 25);
    jest.spyOn(builds, 'readBuild').mockResolvedValue(build);
    build.Items = { ItemSet: {} };
    const validation = new ValidationService();
    const validated = jest.spyOn(validation, 'validateBuild');
    const lua = {
      getBuildInfo: async () => ({ name: 'synthetic' }),
      getStats: async () => ({ ExtraPoints: 1, PassivePointsToWeaponSetPoints: 1 }),
      listSpecs: async () => ({ specs: [{ active: true, index: 1 }] }),
      listItemSets: async () => ({ itemSets: [{ active: true, id: 2 }] }),
    };
    const result = await handleAnalyzeBuild({ buildService: builds, treeService: trees, validationService: validation, pobDirectory: '/unused', ensureLuaClient: async () => {}, getLuaClient: () => lua as any }, 'synthetic.xml');
    expect(validated.mock.calls[0][0].Items).toMatchObject({ activeItemSet: '2' });
    expect(validated.mock.calls[0][0].Tree).toMatchObject({ activeSpec: '1' });
    expect(result.content[0].text).toContain('Weapon set 1: 117 / 117');
  });

  it('reports 116 per weapon and 8 ascendancy points without declaring the snapshot impossible', async () => {
    const { build, builds, trees } = fixture();
    jest.spyOn(builds, 'readBuild').mockResolvedValue(build);
    const result = await handleAnalyzeBuild({ buildService: builds, treeService: trees, validationService: new ValidationService(), pobDirectory: '/unused', ensureLuaClient: async () => {}, getLuaClient: () => null }, 'synthetic.xml');
    const text = result.content[0].text;
    expect(text).toContain('Weapon set 1: 116 / 116');
    expect(text).toContain('Weapon set 2: 116 / 116');
    expect(text).toContain('Blood Mage (8 points)');
    expect(text).not.toMatch(/141 \/ 114|10 points|not possible in the actual game/);
    expect(text).toMatch(/quest.*unverified/i);
  });

  it('reports paid points separately for primary and secondary ascendancies', async () => {
    const { build, builds, trees } = fixture();
    jest.spyOn(builds, 'readBuild').mockResolvedValue(build);
    const analysis = (await trees.analyzePassiveTree(build))!;
    analysis.allocatedNodes.push({ skill: 900, ascendancyName: 'Secondary', name: 'Secondary passive' });
    jest.spyOn(trees, 'analyzePassiveTree').mockResolvedValue(analysis);
    const result = await handleAnalyzeBuild({ buildService: builds, treeService: trees, validationService: new ValidationService(), pobDirectory: '/unused', ensureLuaClient: async () => {}, getLuaClient: () => null }, 'synthetic.xml');
    expect(result.content[0].text).toContain('Blood Mage (8 points)');
    expect(result.content[0].text).toContain('Secondary (1 points)');
  });
});
