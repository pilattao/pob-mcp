import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { EventEmitter } from 'events';
import chokidar from 'chokidar';
import { WatchService } from '../src/services/watchService';
import { BuildService } from '../src/services/buildService';

jest.mock('chokidar', () => ({ __esModule: true, default: { watch: jest.fn() } }));
let root: string, service: WatchService, builds: BuildService;
let events: EventEmitter & { close: jest.Mock }, autoReady: boolean;
const watch = jest.mocked(chokidar.watch);
const until = async (condition: () => boolean) => {
  for (let i = 0; !condition(); i++) {
    if (i > 100) throw new Error('Watcher did not initialize');
    await new Promise(resolve => setTimeout(resolve, 5));
  }
};
beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'poe2-watch-lifecycle-'));
  builds = new BuildService(root);
  service = new WatchService(root, builds);
  events = Object.assign(new EventEmitter(), { close: jest.fn().mockResolvedValue(undefined) });
  autoReady = true;
  watch.mockReset().mockImplementation(() => {
    if (autoReady) setImmediate(() => events.emit('ready'));
    return events as unknown as ReturnType<typeof chokidar.watch>;
  });
});
afterEach(async () => { await service.stopWatching(); jest.useRealTimers(); jest.restoreAllMocks(); await fs.rm(root, { recursive: true, force: true }); });

it('does not claim readiness before initial directory discovery finishes', async () => {
  autoReady = false;
  const start = service.startWatching();
  await until(() => watch.mock.calls.length === 1);
  expect(service.isWatchEnabled()).toBe(false);
  events.emit('ready'); await start;
  expect(service.isWatchEnabled()).toBe(true);
});

it('coalesces concurrent starts into one ready watcher', async () => {
  await Promise.all([service.startWatching(), service.startWatching()]);
  expect(watch).toHaveBeenCalledTimes(1);
  expect(service.isWatchEnabled()).toBe(true);
});

it('fails a missing directory instead of reporting a successful watcher', async () => {
  await fs.rm(root, { recursive: true });
  await expect(service.startWatching()).rejects.toThrow(/ENOENT/);
  expect(watch).not.toHaveBeenCalled();
  expect(service.isWatchEnabled()).toBe(false);
  expect(service.getLastError()).toContain('ENOENT');
});

it('coalesces each relative path independently and accepts uppercase XML', async () => {
  const invalidation = jest.spyOn(builds, 'invalidateBuild');
  await service.startWatching(); jest.useFakeTimers();
  events.emit('change', path.join(root, 'First', 'Same.XML'));
  events.emit('change', path.join(root, 'First', 'Same.XML'));
  events.emit('add', path.join(root, 'Second', 'Same.XML'));
  events.emit('change', path.join(root, 'ignore.txt'));
  jest.advanceTimersByTime(600);
  expect(invalidation.mock.calls.map(call => call[0])).toEqual(['First/Same.XML', 'Second/Same.XML']);
  expect(service.getRecentChanges()).toMatchObject([{ file: 'Second/Same.XML', type: 'added' }, { file: 'First/Same.XML', type: 'modified' }]);
});

it('cancels queued events on stop so no stale event invalidates a subsequent session', async () => {
  await service.startWatching(); jest.useFakeTimers();
  events.emit('change', path.join(root, 'build.xml'));
  await service.stopWatching(); jest.advanceTimersByTime(1000);
  expect(service.getRecentChangesCount()).toBe(0);
  expect(events.close).toHaveBeenCalledTimes(1);
});

it('stops a pending startup and permits an immediate fresh start', async () => {
  autoReady = false;
  const pending = service.startWatching();
  const rejected = expect(pending).rejects.toThrow(/cancelled/);
  await until(() => watch.mock.calls.length === 1);
  await service.stopWatching();
  autoReady = true;
  await service.startWatching();
  await rejected;
  expect(service.isWatchEnabled()).toBe(true);
});

it('marks a failed active watcher disabled and exposes its error', async () => {
  await service.startWatching();
  events.emit('error', new Error('synthetic filesystem failure'));
  await service.stopWatching();
  expect(service.isWatchEnabled()).toBe(false);
  expect(service.getLastError()).toContain('synthetic filesystem failure');
});

it('rejects startup filesystem errors without leaving an enabled watcher', async () => {
  autoReady = false;
  const start = service.startWatching();
  const failure = expect(start).rejects.toThrow(/synthetic denied/);
  await until(() => watch.mock.calls.length === 1);
  events.emit('error', new Error('synthetic denied'));
  await failure;
  expect(service.isWatchEnabled()).toBe(false);
});

it('keeps deletion events and a bounded newest-first history without exposing internal state', async () => {
  await service.startWatching(); jest.useFakeTimers();
  for (let i = 0; i < 60; i++) events.emit('unlink', path.join(root, `build-${i}.xml`));
  jest.advanceTimersByTime(600);
  expect(service.getRecentChangesCount()).toBe(50);
  const changes = service.getRecentChanges(2);
  expect(changes.map(c => c.file)).toEqual(['build-59.xml', 'build-58.xml']);
  expect(changes[0].type).toBe('deleted');
  changes[0].file = 'changed outside';
  expect(service.getRecentChanges(1)[0].file).toBe('build-59.xml');
  expect(service.getRecentChanges(0)).toEqual([]);
});

it.each([-1, 51, 1.5, NaN, Infinity])('rejects invalid history limit %s', limit => {
  expect(() => service.getRecentChanges(limit)).toThrow(/limit/);
});
