import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { BuildService } from '../../src/services/buildService';
import { BuildExportService } from '../../src/services/buildExportService';
import { handleRestoreSnapshot, handleExportBuildSummary } from '../../src/handlers/exportHandlers';
import { document, persistenceXml, questKey, questChoice } from './poe2PersistenceFixtures';

let root: string, builds: BuildService, exporter: BuildExportService, source: string;
beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'poe2-persistence-'));
  await fs.mkdir(path.join(root, 'Forbidden Rites'));
  source = path.join(root, 'Forbidden Rites', 'Synthetic.XML');
  await fs.writeFile(source, persistenceXml());
  builds = new BuildService(root); exporter = new BuildExportService(root);
});
afterEach(async () => { jest.useRealTimers(); jest.restoreAllMocks(); await fs.rm(root, { recursive: true, force: true }); });

it('exports nested Windows-style names and upper-case extensions while preserving every PoB2 section', async () => {
  const build = await builds.readBuild('Forbidden Rites\\Synthetic.XML');
  const result = await exporter.exportBuild(build, { outputName: 'variants\\Copied.XML' });
  expect(result.filePath).toBe(path.join(root, '.pob-mcp', 'exports', 'variants', 'Copied.XML'));
  expect(document(await fs.readFile(result.filePath, 'utf8'))).toEqual(document(persistenceXml()));
  expect(await fs.readFile(source, 'utf8')).toBe(persistenceXml());
});

it('appends notes only to the exported copy, including when overwrite is rejected', async () => {
  const build = await builds.readBuild('Forbidden Rites/Synthetic.XML');
  const original = structuredClone(build);
  const result = await exporter.exportBuild(build, { outputName: 'Copy', notes: 'Export-only notes' });
  expect(await fs.readFile(result.filePath, 'utf8')).toContain('Export-only notes');
  expect(build).toEqual(original);
  await expect(exporter.exportBuild(build, { outputName: 'Copy', notes: 'Rejected notes' })).rejects.toThrow(/already exists/i);
  expect(await builds.readBuild('Forbidden Rites\\Synthetic.XML')).toEqual(original);
});

it('carries the real multi-line Medallion choice through file export and exact snapshot restore', async () => {
  const build = await builds.readBuild('Forbidden Rites/Synthetic.XML');
  const result = await exporter.exportBuild(build, { outputName: 'Quest' });
  const written = await fs.readFile(result.filePath, 'utf8');
  expect(written).toContain(`name="${questKey}" string="${questChoice}"`);
  const snapshot = await exporter.snapshotBuild(builds, { buildName: 'Forbidden Rites/Synthetic.XML' });
  await fs.writeFile(source, persistenceXml().replace(questChoice, 'None'));
  await exporter.restoreSnapshot({ buildName: 'Forbidden Rites/Synthetic.XML', snapshotId: snapshot.snapshotId, backupCurrent: false });
  expect(await fs.readFile(source, 'utf8')).toBe(persistenceXml());
});

it('enforces overwrite=false when two exports race for the same output', async () => {
  const build = await builds.readBuild('Forbidden Rites/Synthetic.XML');
  const results = await Promise.allSettled([
    exporter.exportBuild(build, { outputName: 'Race', notes: 'First' }),
    exporter.exportBuild(build, { outputName: 'Race', notes: 'Second' }),
  ]);
  expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
  expect(results.filter(result => result.status === 'rejected')).toHaveLength(1);
});

it('captures metadata from the exact snapshot bytes, not an older BuildService cache entry', async () => {
  await builds.readBuild('Forbidden Rites/Synthetic.XML');
  await fs.writeFile(source, persistenceXml(82, 2400));
  const snapshot = await exporter.snapshotBuild(builds, { buildName: 'Forbidden Rites\\Synthetic.XML', tag: 'Before' });
  const list = await exporter.listSnapshots('Forbidden Rites/Synthetic.XML');
  expect(list.snapshots[0].metadata.statsSnapshot.life).toBe(2400);
  expect(list.snapshots[0].metadata.statsSnapshot.dps).toBe(0);
  expect(await fs.readFile(snapshot.snapshotPath, 'utf8')).toBe(persistenceXml(82, 2400));
  expect(exporter.formatSnapshotList(list)).toContain('DPS: 0');
});

it('keeps concurrent snapshots distinct within the same millisecond', async () => {
  jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate'] });
  jest.setSystemTime(new Date('2026-09-15T12:00:00Z'));
  const snapshots = await Promise.all([1, 2].map(() => exporter.snapshotBuild(builds, { buildName: 'Forbidden Rites/Synthetic.XML', tag: 'same' })));
  expect(new Set(snapshots.map(s => s.snapshotId)).size).toBe(2);
  expect((await exporter.listSnapshots('Forbidden Rites\\Synthetic.XML')).total).toBe(2);
});

it('lists and restores the automatic pre-restore backup as a complete snapshot', async () => {
  const original = await exporter.snapshotBuild(builds, { buildName: 'Forbidden Rites/Synthetic.XML', tag: 'original' });
  await fs.writeFile(source, persistenceXml(88, 2500));
  const restored = await exporter.restoreSnapshot({ buildName: 'Forbidden Rites\\Synthetic.XML', snapshotId: original.snapshotId });
  expect(await fs.readFile(source, 'utf8')).toBe(persistenceXml());
  const list = await exporter.listSnapshots('Forbidden Rites/Synthetic.XML');
  expect(list.snapshots.some(s => s.id === restored.backupId && s.metadata.tag === 'before-restore')).toBe(true);
  await exporter.restoreSnapshot({ buildName: 'Forbidden Rites/Synthetic.XML', snapshotId: restored.backupId!, backupCurrent: false });
  expect(await fs.readFile(source, 'utf8')).toBe(persistenceXml(88, 2500));
});

it('rejects a damaged snapshot before changing the target file', async () => {
  const snapshot = await exporter.snapshotBuild(builds, { buildName: 'Forbidden Rites/Synthetic.XML' });
  await fs.writeFile(snapshot.snapshotPath, '<unrelated/>');
  await fs.writeFile(source, persistenceXml(88, 2500));
  await expect(exporter.restoreSnapshot({ buildName: 'Forbidden Rites/Synthetic.XML', snapshotId: snapshot.snapshotId })).rejects.toThrow(/XML|root|build|snapshot/i);
  expect(await fs.readFile(source, 'utf8')).toBe(persistenceXml(88, 2500));
});

it('rejects changed snapshot bytes even when they still form valid build XML', async () => {
  const snapshot = await exporter.snapshotBuild(builds, { buildName: 'Forbidden Rites/Synthetic.XML' });
  await fs.writeFile(snapshot.snapshotPath, persistenceXml(99));
  await expect(exporter.restoreSnapshot({ buildName: 'Forbidden Rites/Synthetic.XML', snapshotId: snapshot.snapshotId })).rejects.toThrow(/checksum/);
  expect(await fs.readFile(source, 'utf8')).toBe(persistenceXml());
});

it('preserves the current file and cleans temporary output when atomic replacement fails', async () => {
  const before = await builds.readBuild('Forbidden Rites/Synthetic.XML');
  jest.spyOn(fs, 'rename').mockRejectedValueOnce(Object.assign(new Error('synthetic replacement denied'), { code: 'EACCES' }));
  await expect(exporter.saveTree(builds, { buildName: 'Forbidden Rites/Synthetic.XML', nodes: ['104'], backup: false })).rejects.toThrow(/replacement denied/);
  expect(await fs.readFile(source, 'utf8')).toBe(persistenceXml());
  expect(await builds.readBuild('Forbidden Rites/Synthetic.XML')).toEqual(before);
  expect(await fs.readdir(path.dirname(source))).toEqual(['Synthetic.XML']);
});

it('keeps valid history available when one metadata file is corrupt and honors tag/zero limits', async () => {
  expect((await exporter.listSnapshots('Forbidden Rites/Synthetic.XML')).total).toBe(0);
  const snapshot = await exporter.snapshotBuild(builds, { buildName: 'Forbidden Rites/Synthetic.XML', tag: 'good' });
  await fs.writeFile(path.join(path.dirname(snapshot.snapshotPath), 'bad_metadata.json'), '{broken');
  const all = await exporter.listSnapshots('Forbidden Rites/Synthetic.XML');
  expect(all.total).toBe(1); expect(all.warnings?.[0]).toContain('bad_metadata.json');
  expect((await exporter.listSnapshots('Forbidden Rites/Synthetic.XML', { tagFilter: 'different' })).total).toBe(0);
  const empty = await exporter.listSnapshots('Forbidden Rites/Synthetic.XML', { limit: 0 });
  expect(empty.snapshots).toEqual([]); expect(empty.total).toBe(1);
});

it('rejects unsafe export paths and incompatible PoE1 tree inputs before writing any file', async () => {
  const build = await builds.readBuild('Forbidden Rites/Synthetic.XML');
  await expect(exporter.exportBuild(build, { outputName: '..\\escape' })).rejects.toThrow(/traversal/);
  await expect(exporter.saveTree(builds, { buildName: 'Forbidden Rites/Synthetic.XML', nodes: ['NaN'] })).rejects.toThrow(/numeric node/);
  await expect(exporter.saveTree(builds, { buildName: 'Forbidden Rites/Synthetic.XML', nodes: ['101'], masteryEffects: { '101': 1 } })).rejects.toThrow(/PoE1 mastery/);
  expect(await fs.readFile(source, 'utf8')).toBe(persistenceXml());
});

it('fails an unknown snapshot selector without creating backups or changing the build', async () => {
  await expect(exporter.restoreSnapshot({ buildName: 'Forbidden Rites/Synthetic.XML', snapshotId: 'missing' })).rejects.toThrow(/Snapshot not found/);
  expect(await fs.readFile(source, 'utf8')).toBe(persistenceXml());
});

it('restores a deleted build without requiring a nonexistent current-state backup', async () => {
  const snapshot = await exporter.snapshotBuild(builds, { buildName: 'Forbidden Rites/Synthetic.XML' });
  await fs.unlink(source);
  const result = await exporter.restoreSnapshot({ buildName: 'Forbidden Rites/Synthetic.XML', snapshotId: snapshot.snapshotId });
  expect(result.backupId).toBeUndefined();
  expect(await fs.readFile(source, 'utf8')).toBe(persistenceXml());
});

it('recovers a broken current file while retaining its exact bytes in a labeled backup', async () => {
  const snapshot = await exporter.snapshotBuild(builds, { buildName: 'Forbidden Rites/Synthetic.XML' });
  await fs.writeFile(source, '<PathOfBuilding2><Build');
  const result = await exporter.restoreSnapshot({ buildName: 'Forbidden Rites/Synthetic.XML', snapshotId: snapshot.snapshotId });
  const backup = (await exporter.listSnapshots('Forbidden Rites/Synthetic.XML')).snapshots.find(s => s.id === result.backupId)!;
  expect(await fs.readFile(backup.filePath, 'utf8')).toBe('<PathOfBuilding2><Build');
  expect(backup.metadata.description).toMatch(/unparsed/i);
  expect(await fs.readFile(source, 'utf8')).toBe(persistenceXml());
});

it('finds and restores legacy XML-only backups that predate metadata-backed backups', async () => {
  const directory = path.join(root, '.pob-mcp', 'snapshots', 'Forbidden Rites', 'Synthetic.XML');
  await fs.mkdir(directory, { recursive: true });
  const id = '2026-09-15T12-00-00-000Z';
  await fs.writeFile(path.join(directory, `${id}_before-restore.xml`), persistenceXml(80));
  const list = await exporter.listSnapshots('Forbidden Rites/Synthetic.XML');
  expect(list.snapshots[0].id).toBe(id);
  expect(list.snapshots[0].metadata.description).toMatch(/legacy/i);
  await exporter.restoreSnapshot({ buildName: 'Forbidden Rites/Synthetic.XML', snapshotId: id, backupCurrent: false });
  expect(await fs.readFile(source, 'utf8')).toBe(persistenceXml(80));
});

it('saves only the selected tree and preserves sets, weapon specialisations, runes and gems', async () => {
  const cached = await builds.readBuild('Forbidden Rites/Synthetic.XML');
  const before = structuredClone(cached);
  const result = await exporter.saveTree(builds, { buildName: 'Forbidden Rites\\Synthetic.XML', nodes: ['101', '102', '103', '104'] });
  const expected = document(persistenceXml());
  expected.PathOfBuilding2.Tree.Spec[1]['@_nodes'] = '101,102,103,104';
  expect(document(await fs.readFile(source, 'utf8'))).toEqual(expected);
  expect(cached).toEqual(before);
  expect(builds.parseAllocatedNodes(await builds.readBuild('Forbidden Rites/Synthetic.XML'))).toEqual(['101', '102', '103', '104']);
  const list = await exporter.listSnapshots('Forbidden Rites/Synthetic.XML');
  expect(list.snapshots.some(s => s.filePath === result.backupPath)).toBe(true);
});

it('restores only the file by default even when a live client exists', async () => {
  const snapshot = await exporter.snapshotBuild(builds, { buildName: 'Forbidden Rites/Synthetic.XML' });
  await fs.writeFile(source, persistenceXml(88));
  const native = { loadBuildXml: jest.fn() } as any;
  const result = await handleRestoreSnapshot({ buildService: builds, exportService: exporter, luaClient: native }, {
    build_name: 'Forbidden Rites\\Synthetic.XML', snapshot_id: snapshot.snapshotId, backup_current: false,
  });
  expect(native.loadBuildXml).not.toHaveBeenCalled();
  expect(result.content[0].text).toMatch(/file.*restored|restored.*file/i);
  expect(await fs.readFile(source, 'utf8')).toBe(persistenceXml());
});

it('reports file success and unknown live state after a queued reload changes state then fails verification', async () => {
  const snapshot = await exporter.snapshotBuild(builds, { buildName: 'Forbidden Rites/Synthetic.XML' });
  await fs.writeFile(source, persistenceXml(90));
  await builds.readBuild('Forbidden Rites/Synthetic.XML');
  let simulatedLiveXml = persistenceXml(90);
  const native = { loadBuildXml: jest.fn(async (xml: string) => {
    simulatedLiveXml = xml; // The queued open took effect before the response failed.
    throw new Error('queued open verification timed out after acceptance');
  }) } as any;
  const result = await handleRestoreSnapshot({ buildService: builds, exportService: exporter, luaClient: native }, {
    build_name: 'Forbidden Rites/Synthetic.XML', snapshot_id: snapshot.snapshotId, reload_live: true,
  });
  expect(await fs.readFile(source, 'utf8')).toBe(persistenceXml());
  expect((await builds.readBuild('Forbidden Rites/Synthetic.XML')).Build?.level).toBe('81');
  expect(simulatedLiveXml).toBe(persistenceXml());
  expect(result).toMatchObject({ isError: true, structuredContent: {
    fileRestored: true, liveReloadVerified: false, liveState: 'unknown',
    buildName: 'Forbidden Rites/Synthetic.XML', snapshotId: snapshot.snapshotId,
  } });
  const backupId = (result as any).structuredContent.backupId;
  const backup = (await exporter.listSnapshots('Forbidden Rites/Synthetic.XML')).snapshots.find(s => s.id === backupId)!;
  expect(await fs.readFile(backup.filePath, 'utf8')).toBe(persistenceXml(90));
  expect(result.content[0].text).toMatch(/state.*unknown/i);
  expect(result.content[0].text).not.toMatch(/still holding|pre-restore build|Live PoB session reloaded/);
  expect(native.loadBuildXml).toHaveBeenCalledTimes(1);
});

it.each([-1, NaN, Infinity, 1.5])('rejects invalid snapshot list limit %s', async limit => {
  await expect(exporter.listSnapshots('Forbidden Rites/Synthetic.XML', { limit })).rejects.toThrow(/limit/i);
});

it('shows a native PoE2 class name and zero DPS without substituting a PoE1 class or different DPS', async () => {
  const result = await handleExportBuildSummary({ buildService: builds, exportService: exporter, luaClient: {
    getBuildInfo: async () => ({ name: 'Synthetic', class: 'Sorceress', ascendancy: 'Stormweaver', level: 81, game: 'poe2' }),
    getStats: async () => ({ Life: 1200, EnergyShield: 50, CombinedDPS: 0, TotalDPS: 900, TotalEHP: 0 }),
    getSkills: async () => ({ mainSocketGroup: 2, groups: [{ index: 1, gems: [{ name: 'Frost Bomb' }] }, { index: 2, gems: [{ name: 'Spark' }, { name: 'Rapid Casting II', enabled: false }] }] }),
    getTree: async () => ({ classId: 0 }),
  } as any });
  const text = result.content[0].text;
  expect(text).toContain('Sorceress'); expect(text).not.toContain('Scion');
  expect(text).toContain('| DPS | 0 |'); expect(text).toContain('Spark');
  expect(text).toContain('| Energy Shield | 50 |');
  expect(text).not.toContain('Frost Bomb'); expect(text).not.toContain('Rapid Casting II');
});

it('does not manufacture zero stats when summary reads fail', async () => {
  const failure = async () => { throw new Error('synthetic unavailable'); };
  const result = await handleExportBuildSummary({ buildService: builds, exportService: exporter, luaClient: {
    getBuildInfo: failure, getStats: failure, getSkills: failure, getTree: failure,
  } as any });
  expect(result.content[0].text).toMatch(/unavailable|unknown/i);
  expect(result.content[0].text).not.toMatch(/\| Life \| 0|\| DPS \| 0|\| Total EHP \| 0/);
});
