import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import {
  handleStartWatching,
  handleStopWatching,
  handleGetRecentChanges,
  handleWatchStatus,
} from '../../src/handlers/watchHandlers';
import type { WatchHandlerContext } from '../../src/handlers/watchHandlers';

function makeContext(overrides: Partial<{
  isWatchEnabled: boolean;
  directory: string;
  recentChanges: any[];
}>  = {}): WatchHandlerContext {
  const { isWatchEnabled = false, directory = '/builds', recentChanges = [] } = overrides;
  return {
    watchService: {
      isWatchEnabled: jest.fn<() => boolean>().mockReturnValue(isWatchEnabled),
      startWatching: jest.fn<() => void>(),
      stopWatching: jest.fn<() => Promise<void>>().mockResolvedValue(undefined),
      getDirectory: jest.fn<() => string>().mockReturnValue(directory),
      getRecentChanges: jest.fn<() => any[]>().mockReturnValue(recentChanges),
      getRecentChangesCount: jest.fn<() => number>().mockReturnValue(recentChanges.length),
    } as any,
    buildService: {} as any,
    treeService: {} as any,
  };
}

describe('handleStartWatching', () => {
  it('starts watching and reports the directory', async () => {
    const ctx = makeContext({ isWatchEnabled: false, directory: '/my/builds' });
    const result = await handleStartWatching(ctx);
    expect(ctx.watchService.startWatching).toHaveBeenCalled();
    expect(result.content[0].text).toContain('/my/builds');
  });

  it('reports already-enabled when watching is active', async () => {
    const ctx = makeContext({ isWatchEnabled: true });
    const result = await handleStartWatching(ctx);
    expect(ctx.watchService.startWatching).not.toHaveBeenCalled();
    expect(result.content[0].text).toContain('already enabled');
  });
});

describe('handleStopWatching', () => {
  it('stops watching when active', async () => {
    const ctx = makeContext({ isWatchEnabled: true });
    const result = await handleStopWatching(ctx);
    expect(ctx.watchService.stopWatching).toHaveBeenCalled();
    expect(result.content[0].text).toContain('stopped');
  });

  it('reports not-watching when already inactive', async () => {
    const ctx = makeContext({ isWatchEnabled: false });
    const result = await handleStopWatching(ctx);
    expect(ctx.watchService.stopWatching).toHaveBeenCalled();
    expect(result.content[0].text).toContain('not currently enabled');
  });
});

describe('handleGetRecentChanges', () => {
  it('returns message when no changes exist', () => {
    const ctx = makeContext({ recentChanges: [] });
    const result = handleGetRecentChanges(ctx);
    expect(result.content[0].text).toContain('No recent changes');
  });

  it('lists recent changes when present', () => {
    const ctx = makeContext({
      recentChanges: [
        { file: 'my-build.xml', timestamp: Date.now(), type: 'change' },
        { file: 'other-build.xml', timestamp: Date.now() - 1000, type: 'change' },
      ],
    });
    const result = handleGetRecentChanges(ctx);
    expect(result.content[0].text).toContain('my-build.xml');
    expect(result.content[0].text).toContain('other-build.xml');
  });

  it('passes limit parameter to watchService', () => {
    const ctx = makeContext({ recentChanges: [{ file: 'a.xml', timestamp: Date.now(), type: 'change' }] });
    handleGetRecentChanges(ctx, 5);
    expect(ctx.watchService.getRecentChanges).toHaveBeenCalledWith(5);
  });
});

describe('handleWatchStatus', () => {
  it('reports watching active with directory', () => {
    const ctx = makeContext({ isWatchEnabled: true, directory: '/builds' });
    const result = handleWatchStatus(ctx);
    expect(result.content[0].text).toContain('/builds');
  });

  it('reports watching inactive', () => {
    const ctx = makeContext({ isWatchEnabled: false });
    const result = handleWatchStatus(ctx);
    expect(result.content[0].text).toMatch(/not.*active|inactive|disabled/i);
  });

  it('shows the last filesystem failure without presenting the watcher as active', () => {
    const ctx = makeContext({ isWatchEnabled: false });
    ctx.watchService.getLastError = () => 'synthetic read error';
    const text = handleWatchStatus(ctx).content[0].text;
    expect(text).toContain('DISABLED'); expect(text).toContain('synthetic read error');
  });
});
