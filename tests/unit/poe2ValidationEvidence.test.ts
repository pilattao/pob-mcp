import fs from 'fs';
import path from 'path';
import { BuildService } from '../../src/services/buildService.js';
import { TreeService } from '../../src/services/treeService.js';
import { ValidationService } from '../../src/services/validationService.js';
import { handleAnalyzeBuild } from '../../src/handlers/buildHandlers.js';

// Optional read-only local verification. Private inputs are never copied into fixtures.
const snapshot = process.env.POE2_VALIDATION_SNAPSHOT;
const install = process.env.POB_INSTALL_DIR;
const local = snapshot && install ? describe : describe.skip;
local('installed PoB2 and private snapshot validation evidence', () => {
  it('reproduces native 0_5 counts and the corrected report without a live runtime', async () => {
    const before = fs.readFileSync(snapshot!);
    const builds = new BuildService(path.dirname(snapshot!));
    const build = builds.parseBuildContent(before.toString('utf8'));
    const trees = new TreeService(builds);
    const native = await trees.analyzePassiveTree(build);
    expect(builds.parseAllocatedNodes(build)).toHaveLength(151);
    expect(native!.passiveBudget).toMatchObject({ nonAscendancyPoints: 140, sharedPoints: 92, weaponSetPoints: [24, 24], perWeaponPoints: [116, 116], ascendancyPoints: 8 });
    const quests = fs.readFileSync(path.join(install!, 'Data/QuestRewards.lua'), 'utf8');
    expect([...quests.matchAll(/\["questPoints"\]\s*=\s*(\d+)/g)].reduce((sum, m) => sum + Number(m[1]), 0)).toBe(24);
    const runtime = jest.fn(() => null);
    const result = await handleAnalyzeBuild({ buildService: builds, treeService: trees, validationService: new ValidationService(), pobDirectory: path.dirname(snapshot!), ensureLuaClient: async () => {}, getLuaClient: runtime }, path.basename(snapshot!));
    expect(result.content[0].text).toMatch(/Weapon set 1: 116 \/ 116/);
    expect(result.content[0].text).toContain('Blood Mage (8 points)');
    expect(result.content[0].text).toMatch(/Freeze protection is conditional/);
    expect(result.content[0].text.includes('141 / 114')).toBe(false);
    const validation = result.content[0].text.split('=== Build Validation Report ===')[1];
    // Raw native exports may still contain legacy-named fields with zero values.
    expect(/5500|Scion|of Heat|Pantheon|suppression/i.test(validation)).toBe(false);
    expect(fs.readFileSync(snapshot!)).toEqual(before);
  });
});
