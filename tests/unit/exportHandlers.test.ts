import { describe, it, expect, jest } from '@jest/globals';
import { handleRestoreSnapshot } from '../../src/handlers/exportHandlers';
import type { ExportHandlerContext } from '../../src/handlers/exportHandlers';

const RESTORED_XML = '<PathOfBuilding><Build level="85"/></PathOfBuilding>';

function makeContext(opts: {
  luaClient?: any;
  restoreThrows?: boolean;
} = {}) {
  const exportService = {
    restoreSnapshot: jest.fn<() => Promise<any>>().mockResolvedValue({
      message: 'Build restored from snapshot: pre-sim (2026-08-03T00-00-00Z)',
      restoredXml: RESTORED_XML,
    }),
  };
  const buildService = {
    invalidateBuild: jest.fn(),
  };
  return {
    context: {
      exportService,
      buildService,
      luaClient: opts.luaClient,
    } as unknown as ExportHandlerContext,
    exportService,
    buildService,
  };
}

function makeLuaClient(loadThrows = false) {
  return {
    loadBuildXml: jest
      .fn<(xml: string, name: string) => Promise<any>>()
      .mockImplementation(async () => {
        if (loadThrows) throw new Error('open_build_xml failed');
        return { ok: true };
      }),
  };
}

// Regression: restore_snapshot wrote the build FILE and returned "Build restored", but left a
// live TCP session holding the pre-restore build in memory. Every stat read afterwards was
// computed against state the user believed had been rolled back — a simulated item stayed
// equipped and active across a "restore", silently contaminating later measurements.
describe('handleRestoreSnapshot — live session sync', () => {
  it('pushes the restored XML into a live Lua session', async () => {
    const luaClient = makeLuaClient();
    const { context } = makeContext({ luaClient });

    const result = await handleRestoreSnapshot(context, {
      build_name: 'MyBuild.xml',
      snapshot_id: 'pre-sim',
      reload_live: !!luaClient,
    });

    expect(luaClient.loadBuildXml).toHaveBeenCalledTimes(1);
    const [xml, name] = luaClient.loadBuildXml.mock.calls[0];
    expect(xml).toBe(RESTORED_XML);
    expect(name).toBe('MyBuild'); // .xml stripped
    expect(result.content[0].text).toContain('Live PoB session reloaded');
  });

  it('returns an error and unknown live state when reload verification fails after file restore', async () => {
    const luaClient = makeLuaClient(true);
    const { context } = makeContext({ luaClient });

    const result = await handleRestoreSnapshot(context, {
      build_name: 'MyBuild.xml',
      snapshot_id: 'pre-sim',
      reload_live: !!luaClient,
    });

    const text = result.content[0].text;
    expect(result).toMatchObject({ isError: true, structuredContent: {
      fileRestored: true, liveReloadVerified: false, liveState: 'unknown',
    } });
    expect(text).toContain('open_build_xml failed');
    expect(text).toMatch(/live.*state.*unknown/i);
    expect(text).toMatch(/read.*again/i);
    expect(text).not.toMatch(/still holding|pre-restore build|NOT reflect this restore/);
    expect(text).not.toContain('Live PoB session reloaded');
  });

  it('does not attempt a live push when no Lua client is active (file-only mode)', async () => {
    const { context } = makeContext({ luaClient: undefined });

    const result = await handleRestoreSnapshot(context, {
      build_name: 'MyBuild.xml',
      snapshot_id: 'pre-sim',
      reload_live: false,
    });

    expect(result.content[0].text).toContain('Build restored from snapshot');
    expect(result.content[0].text).not.toContain('WARNING');
  });

  it('invalidates the cached build', async () => {
    const luaClient = makeLuaClient();
    const { context, buildService } = makeContext({ luaClient });

    await handleRestoreSnapshot(context, {
      build_name: 'MyBuild.xml',
      snapshot_id: 'pre-sim',
      reload_live: !!luaClient,
    });

    expect(buildService.invalidateBuild).toHaveBeenCalledWith('MyBuild.xml');
  });
});
