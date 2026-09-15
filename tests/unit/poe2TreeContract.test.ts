import { describe, it, expect, beforeEach, afterEach, jest } from '@jest/globals';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { getPobTreeData, getLoadedVersion } from '../../src/services/pobTreeDataLoader.js';
import { TreeService } from '../../src/services/treeService.js';
import { BuildService } from '../../src/services/buildService.js';

function tree(name: string) {
  return `return {nodes={
    [101]={skill=101,name="${name}",stats={[1]="10% increased Spell Damage",[2]="+10 to Intelligence"},connections={[1]={id=102,orbit=0}},group=1,orbit=0,orbitIndex=0},
    [102]={skill=102,name="Second",stats={},connections={},group=1,orbit=1,orbitIndex=0}
  },groups={[1]={x=0,y=0,nodes={[1]=101,[2]=102},orbits={[1]=0,[2]=1}}},classes={},tree="0_5"}`;
}

describe('PoE2 installed tree contract', () => {
  let directory: string;
  const saved = { install: process.env.POB_INSTALL_DIR, game: process.env.POE_GAME, suite: process.env.POE_MCP_SUITE_ROOT };
  beforeEach(() => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), 'poe2-tree-'));
    fs.mkdirSync(path.join(directory, 'TreeData', '0_5'), { recursive: true });
    fs.writeFileSync(path.join(directory, 'TreeData', '0_5', 'tree.lua'), tree('First'));
    process.env.POB_INSTALL_DIR = directory;
    process.env.POE_GAME = 'poe2';
  });
  afterEach(() => {
    for (const [key, value] of Object.entries({ POB_INSTALL_DIR: saved.install, POE_GAME: saved.game, POE_MCP_SUITE_ROOT: saved.suite })) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    fs.rmSync(directory, { recursive: true, force: true });
  });

  it('loads installed layout and normalizes numbered stats, groups and connections', () => {
    const data = getPobTreeData();
    expect(getLoadedVersion()).toBe('0_5');
    expect(data.nodes['101'].stats).toEqual(['10% increased Spell Damage', '+10 to Intelligence']);
    expect(data.nodes['101'].out).toContain('102');
    expect(data.nodes['102'].out).toContain('101');
    expect(data.groups['1'].nodes).toEqual(['101', '102']);
  });

  it('does not select a PoE1 tree when both versions are present', () => {
    fs.mkdirSync(path.join(directory, 'TreeData', '3_29'));
    fs.writeFileSync(path.join(directory, 'TreeData', '3_29', 'tree.lua'), tree('Wrong Game'));
    expect(getLoadedVersion()).toBe('0_5');
    expect(() => getPobTreeData('3_29')).toThrow(/PoE2|poe2|game/i);
  });

  it('does not reuse another installation cache with identical version and timestamps', () => {
    const firstPath = path.join(directory, 'TreeData', '0_5', 'tree.lua');
    const first = getPobTreeData();
    const other = path.join(directory, 'other');
    fs.mkdirSync(path.join(other, 'TreeData', '0_5'), { recursive: true });
    const otherPath = path.join(other, 'TreeData', '0_5', 'tree.lua');
    fs.writeFileSync(otherPath, tree('Other'));
    const stat = fs.statSync(firstPath); fs.utimesSync(otherPath, stat.atime, stat.mtime);
    process.env.POB_INSTALL_DIR = other;
    expect(first.nodes['101'].name).toBe('First');
    expect(getPobTreeData().nodes['101'].name).toBe('Other');
  });

  it('fails rather than falling back to a PoE1 GGG export', () => {
    fs.rmSync(path.join(directory, 'TreeData'), { recursive: true });
    const fallback = path.join(directory, 'reference_data', 'skilltree');
    fs.mkdirSync(fallback, { recursive: true });
    fs.writeFileSync(path.join(fallback, 'data.json'), JSON.stringify({ nodes: { 999: { name: 'PoE1 Only' } }, groups: {} }));
    process.env.POE_MCP_SUITE_ROOT = directory;
    expect(() => getPobTreeData()).toThrow(/PoE2|poe2/);
  });

  it('uses the native PoB2 graph in the main build-analysis service', async () => {
    const service = new TreeService(new BuildService(directory));
    const oldSource = jest.spyOn(service, 'fetchTreeDataFromRepo').mockRejectedValue(new Error('PoE1 network source must not be used'));
    try {
      const tree = await service.getTreeData('0_5');
      expect(tree.version).toBe('0_5');
      expect(tree.nodes.get('101')?.name).toBe('First');
      expect(tree.nodes.get('102')?.out).toContain('101');
    } finally { oldSource.mockRestore(); }
  });
});
