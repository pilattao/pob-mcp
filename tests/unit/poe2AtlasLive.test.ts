import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';
import { getAtlasTreeData, type AtlasTreeData } from '../../src/services/atlasTreeDataLoader';
import { handleFindAtlasPathToNode, handleGetAtlasNode, handleSearchAtlasNodes } from '../../src/handlers/atlasTreeHandlers';

// Opt-in primary-source HTTPS check. No user account/API/builds, file writes,
// bulk repository data or persistent cache. Three cold requests, then cache.
const live = process.env.POE2_ATLAS_LIVE === '1' ? describe : describe.skip;
const keys = ['POE_GAME', 'POE2_ATLAS_FILE', 'ATLASTREE_DIRECTORY'] as const;
const saved = keys.map(key => process.env[key]);
let tree: AtlasTreeData;
live('live public PoE2 atlas graph', () => {
  beforeAll(async () => {
    process.env.POE_GAME = 'poe2';
    delete process.env.POE2_ATLAS_FILE;
    delete process.env.ATLASTREE_DIRECTORY;
    tree = await getAtlasTreeData();
  }, 60000);
  afterAll(() => keys.forEach((key, i) => {
    if (saved[i] === undefined) delete process.env[key]; else process.env[key] = saved[i];
  }));

  it('loads the native graph, roots and subtrees with reproducible source identity', () => {
    expect(tree.game).toBe('poe2');
    expect(tree.version).toMatch(/^\d+(?:\.\d+)+$/);
    expect(tree.coverage.nodes).toBeGreaterThan(500);
    expect(tree.coverage.edges).toBeGreaterThan(500);
    expect(tree.roots).toContain('25703');
    expect(tree.nodes['18887'].subtree).toBe('Ritual');
    expect(tree.nodes.root).toBeUndefined();
    expect(tree.provenance.transport).toBe('https');
    expect(tree.provenance.sha256).toMatch(/^[a-f0-9]{64}$/);
    console.info('PoE2 atlas live evidence:', JSON.stringify({ version: tree.version,
      provenance: tree.provenance, roots: tree.roots, coverage: tree.coverage,
      selectors: Object.values(tree.nodes).filter(node => node.hasUnresolvedOptions).length }));
  });

  it('returns real node details and stat searches through the tool handlers', async () => {
    const detail = await handleGetAtlasNode('692', 'default', true);
    expect(JSON.parse(detail.content[0].text)).toMatchObject({ game: 'poe2',
      node: { name: 'Living Metal', stats: ['Azmeri Spirits may seek out and Possess Strongboxes'] } });
    const search = await handleSearchAtlasNodes('Strongbox', 'notable', 100);
    expect(search.content[0].text).toContain('Living Metal');
    expect(search.isError).not.toBe(true);
  });

  it('finds the verified reverse path and cannot jump between atlas subtrees', async () => {
    const reverse = await handleFindAtlasPathToNode('692', '12162');
    expect(reverse.content[0].text).toContain('Graph distance: 2');
    expect(reverse.content[0].text).toContain('via: 9980');
    const separate = await handleFindAtlasPathToNode('18887', '25703');
    expect(separate.content[0].text).toMatch(/No path.*published graph/);
  });

  it('keeps display-only nodes and selectors explicit without guessed budgets', async () => {
    expect(tree.nodes['361'].isDisplayOnly).toBe(true);
    expect(tree.nodes['182'].hasUnresolvedOptions).toBe(true);
    expect(tree.points).toBeUndefined();
    await expect(getAtlasTreeData('ruthless')).rejects.toThrow(/PoE2.*variant/i);
  });
});
