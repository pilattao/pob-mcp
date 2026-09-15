import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { BuildService } from '../../src/services/buildService';
import { BuildExportService } from '../../src/services/buildExportService';
import { WatchService } from '../../src/services/watchService';
import { ContextBuilder } from '../../src/utils/contextBuilder';
import { routeToolCall } from '../../src/server/toolRouter';
import { persistenceXml, document, eventually } from './poe2PersistenceFixtures';

it('runs the actual MCP file routes through start/change/history/snapshot/restore/export/stop in a temporary PoB2 directory', async () => {
  const root = await fs.mkdtemp(path.join(process.env.POE2_FILE_TEST_ROOT || os.tmpdir(), 'poe2-workflow-'));
  await fs.mkdir(path.join(root, 'Forbidden Rites')); await fs.mkdir(path.join(root, 'Archive'));
  const first = path.join(root, 'Forbidden Rites', 'Synthetic.XML');
  const second = path.join(root, 'Archive', 'Synthetic.XML');
  await fs.writeFile(first, persistenceXml()); await fs.writeFile(second, persistenceXml());
  const buildService = new BuildService(root), exportService = new BuildExportService(root);
  const watchService = new WatchService(root, buildService);
  const getLuaClient = jest.fn(() => null), ensureLuaClient = jest.fn(async () => { throw new Error('Native calls forbidden in this file-only fixture'); });
  const contextBuilder = new ContextBuilder({ buildService, exportService, watchService, pobDirectory: root,
    treeService: {}, validationService: {}, skillGemService: {}, getLuaClient, ensureLuaClient, luaEnabled: false } as any);
  const deps = { contextBuilder, toolGate: { checkGate: () => {} }, getLuaClient, ensureLuaClient } as any;
  const call = (name: string, args: Record<string, unknown> = {}) => routeToolCall(name, args, deps);
  try {
    await buildService.readBuild('Forbidden Rites\\Synthetic.XML'); await buildService.readBuild('Archive/Synthetic.XML');
    await call('start_watching'); // Must not return before chokidar's initial scan is ready.
    await fs.writeFile(first, persistenceXml(82)); await fs.writeFile(second, persistenceXml(83));
    await eventually(() => watchService.getRecentChangesCount() === 2);
    expect((await buildService.readBuild('Forbidden Rites/Synthetic.XML')).Build?.level).toBe('82');
    expect((await buildService.readBuild('Archive\\Synthetic.XML')).Build?.level).toBe('83');
    const changes = (await call('get_recent_changes', { limit: 2 })).content[0].text;
    expect(changes).toContain('Forbidden Rites/Synthetic.XML'); expect(changes).toContain('Archive/Synthetic.XML');
    await call('snapshot_build', { build_name: 'Forbidden Rites\\Synthetic.XML', tag: 'roundtrip' });
    expect((await call('list_snapshots', { build_name: 'Forbidden Rites/Synthetic.XML' })).content[0].text).toContain('roundtrip');
    await fs.writeFile(first, persistenceXml(90));
    await call('restore_snapshot', { build_name: 'Forbidden Rites\\Synthetic.XML', snapshot_id: 'roundtrip', backup_current: false });
    expect(await fs.readFile(first, 'utf8')).toBe(persistenceXml(82));
    await call('export_build', { build_name: 'Forbidden Rites\\Synthetic.XML', output_name: 'nested\\Export.XML' });
    expect(document(await fs.readFile(path.join(root, '.pob-mcp', 'exports', 'nested', 'Export.XML'), 'utf8'))).toEqual(document(persistenceXml(82)));
    await call('save_tree', { build_name: 'Forbidden Rites\\Synthetic.XML', nodes: ['101', '102', '103', '104'] });
    expect(buildService.parseAllocatedNodes(await buildService.readBuild('Forbidden Rites/Synthetic.XML'))).toEqual(['101', '102', '103', '104']);
    expect((await call('list_snapshots', { build_name: 'Forbidden Rites/Synthetic.XML', tag_filter: 'backup' })).content[0].text).toContain('[backup]');
    await call('stop_watching');
    const count = watchService.getRecentChangesCount();
    await fs.writeFile(first, persistenceXml(91));
    await new Promise(resolve => setTimeout(resolve, 700));
    expect(watchService.getRecentChangesCount()).toBe(count);
    expect((await call('watch_status')).content[0].text).toContain('DISABLED');
    expect(ensureLuaClient).not.toHaveBeenCalled();
  } finally { await watchService.stopWatching(); await fs.rm(root, { recursive: true, force: true }); }
}, 15000);
