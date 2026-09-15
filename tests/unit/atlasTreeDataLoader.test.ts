import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';
import { writeFileSync, utimesSync } from 'fs';
import { join } from 'path';
import { getAtlasTreeData, getAtlasNode, getAtlasVariantInfo } from '../../src/services/atlasTreeDataLoader';
import { nativeAtlasEnvelope, useAtlasFixture } from './poe2AtlasFixtures';

let fixture: ReturnType<typeof useAtlasFixture>;
beforeEach(() => { fixture = useAtlasFixture(); });
afterEach(() => fixture.cleanup());

describe('atlasTreeDataLoader — native PoE2 graph', () => {
  it('loads PoE2 definitions with explicit game, export version and provenance', async () => {
    const tree = await getAtlasTreeData();
    expect(tree.tree).toBe('Atlas');
    expect(tree.game).toBe('poe2');
    expect(tree.version).toBe('4.5.5.2');
    expect(Object.keys(tree.nodes)).toHaveLength(9);
    expect(tree.provenance).toMatchObject({ transport: 'file', source: nativeAtlasEnvelope().source });
    expect((tree.provenance as { sha256: string }).sha256).toMatch(/^[a-f0-9]{64}$/);
  });

  it('maps native graph positions and actual orbit constants without inventing point caps', async () => {
    const tree = await getAtlasTreeData();
    expect(tree.groups['1']).toMatchObject({ x: 120, y: -500 });
    expect(tree.nodes['692']).toMatchObject({ group: 1, orbit: 7, orbitIndex: 6 });
    expect(tree.constants?.orbitRadii).toEqual([0, 82, 162, 335, 493, 662, 846, 251, 1080, 1332]);
    expect(tree.points).toBeUndefined();
  });

  it('returns null for an unknown ID and does not manufacture a synthetic root', async () => {
    expect(await getAtlasNode('99999999')).toBeNull();
    expect(await getAtlasNode('root')).toBeNull();
  });

  it('returns a verified PoE2 notable, decoded stats and bidirectional connections', async () => {
    expect(await getAtlasNode('692')).toMatchObject({ name: 'Living Metal', isNotable: true,
      stats: ['Azmeri Spirits may seek out and Possess Strongboxes'], out: ['9980'] });
    expect((await getAtlasNode('9980'))?.in).toContain('692');
    expect((await getAtlasNode('12162'))?.in).toContain('9980');
  });

  it('caches unchanged files but never leaks the cache across directories with identical mtimes', async () => {
    const fixed = new Date('2026-09-01T00:00:00Z');
    utimesSync(fixture.path, fixed, fixed);
    const a = await getAtlasTreeData();
    expect(await getAtlasTreeData()).toBe(a);
    const other = join(fixture.dir, 'another.json');
    const changed = nativeAtlasEnvelope();
    changed.data.passives['692'].name = 'Altered Name';
    writeFileSync(other, JSON.stringify(changed));
    utimesSync(other, fixed, fixed);
    process.env.POE2_ATLAS_FILE = other;
    expect((await getAtlasNode('692'))?.name).toBe('Altered Name');
  });

  it('reports the selected PoE2 source file, not the PoE1 reference_data path', () => {
    expect(getAtlasVariantInfo()).toMatchObject({ path: fixture.path, exists: true, game: 'poe2' });
  });

  it.each(['league', 'ruthless', 'ruthless-league', 'bogus'])('rejects unsupported PoE2 variant %s', async variant => {
    await expect(getAtlasTreeData(variant as 'default')).rejects.toThrow(/PoE2.*variant/i);
  });

  it('rejects PoE1-shaped or unlabelled data in PoE2 mode, even with a valid PoE1 file nearby', async () => {
    writeFileSync(join(fixture.dir, 'data.json'), JSON.stringify({ tree: 'Atlas', nodes: {}, groups: {} }));
    writeFileSync(fixture.path, JSON.stringify({ tree: 'Atlas', nodes: {}, groups: {} }));
    await expect(getAtlasTreeData()).rejects.toThrow(/PoE2/);
    writeFileSync(fixture.path, JSON.stringify({ ...nativeAtlasEnvelope(), game: 'poe1' }));
    await expect(getAtlasTreeData()).rejects.toThrow(/PoE2/);
  });

  it('rejects missing metadata, dangling connections and missing native descriptions', async () => {
    writeFileSync(fixture.path, JSON.stringify({ ...nativeAtlasEnvelope(), version: '' }));
    await expect(getAtlasTreeData()).rejects.toThrow(/version/i);
    const dangling = nativeAtlasEnvelope();
    dangling.data.groups[0].passives[0].connections.push(999999);
    dangling.data.groups[0].passives[0].splines.push(0);
    writeFileSync(fixture.path, JSON.stringify(dangling));
    await expect(getAtlasTreeData()).rejects.toThrow(/999999/);
    const missing = nativeAtlasEnvelope();
    delete (missing.data.passives as Record<string, unknown>)['692'];
    writeFileSync(fixture.path, JSON.stringify(missing));
    await expect(getAtlasTreeData()).rejects.toThrow(/692/);
  });

  it('retains selector and display-only distinctions without inferring effects or allocation costs', async () => {
    const tree = await getAtlasTreeData();
    expect(tree.nodes['361']).toMatchObject({ isDisplayOnly: true });
    expect(tree.nodes['182']).toMatchObject({ subtree: 'Expedition', hasUnresolvedOptions: true });
    expect(tree.capabilities).toMatchObject({ pathing: 'topology-only', allocationValidation: false });
    expect(tree.nodes['182'].allocationCost).toBeUndefined();
  });

  it('never applies a PoE1 patch overlay to PoE2 data', async () => {
    writeFileSync(join(fixture.dir, 'data_patches.json'), JSON.stringify({ '692': { name_replace: 'PoE1 corruption' } }));
    expect((await getAtlasNode('692'))?.name).toBe('Living Metal');
  });
});

describe('atlasTreeDataLoader — isolated PoE1 compatibility', () => {
  it('retains local export variants and their patch overlay', async () => {
    process.env.POE_GAME = 'poe1';
    const data = { tree: 'Atlas', nodes: { '1670': { skill: 1670, name: "Fortune's Favour", isNotable: true,
      stats: ['A fixture modifier'], group: 1, orbit: 0, orbitIndex: 0, in: [], out: [] } }, groups: { '1': { x: 0, y: 0 } } };
    writeFileSync(join(fixture.dir, 'data.json'), JSON.stringify(data));
    writeFileSync(join(fixture.dir, 'league.json'), JSON.stringify({ ...data, tree: 'AtlasCurrentLeague' }));
    writeFileSync(join(fixture.dir, 'data_patches.json'), JSON.stringify({ '1670': { stats_add: ['Patched fixture modifier'] } }));
    expect((await getAtlasNode('1670'))?.stats).toEqual(['A fixture modifier', 'Patched fixture modifier']);
    expect((await getAtlasTreeData('league')).tree).toBe('AtlasCurrentLeague');
    expect((await getAtlasTreeData()).game).toBe('poe1');
    expect(getAtlasVariantInfo().path).toBe(join(fixture.dir, 'data.json'));
  });
});
