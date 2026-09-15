import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { handleLuaGetTree } from '../../src/handlers/luaHandlers.js';
import { PoBLuaTcpClient } from '../../src/pobLuaBridge.js';

const savedGame = process.env.POE_GAME;
beforeEach(() => { process.env.POE_GAME = 'poe2'; });
afterEach(() => { if (savedGame === undefined) delete process.env.POE_GAME; else process.env.POE_GAME = savedGame; });

function context(info: unknown = { game: 'poe2', treeVersion: '0_5', className: 'Witch', ascendClassName: 'Blood Mage' }, tree: Record<string, unknown> = {}) {
  const client: any = {
    getTree: jest.fn<() => Promise<any>>().mockResolvedValue({ treeVersion: '0_5', classId: 1, ascendClassId: 2, nodes: [10, 20], ...tree }),
    getBuildInfo: jest.fn<() => Promise<any>>().mockImplementation(async () => { if (info instanceof Error) throw info; return info; }),
  };
  return { client, getLuaClient: () => client, ensureLuaClient: async () => {}, stopLuaClient: async () => {}, pobDirectory: '/unused', luaEnabled: true };
}

describe('PoE2 tree identity rendering', () => {
  it('renders native Witch/Blood Mage names for IDs that mean Marauder/Berserker in PoE1', async () => {
    const text = (await handleLuaGetTree(context(), true)).content[0].text;
    expect(text).toContain('Class: Witch (ID: 1)');
    expect(text).toContain('Ascendancy: Blood Mage (ID: 2)');
    expect(text).toContain('Node IDs: 10, 20');
    expect(text).not.toMatch(/Marauder|Berserker/);
  });

  it.each([null, {}, { className: '', ascendClassName: '  ' }, new Error('native read unavailable')])('keeps names unknown when native identity is missing', async info => {
    const text = (await handleLuaGetTree(context(info))).content[0].text;
    expect(text).toContain('Class: Unknown (ID: 1)');
    expect(text).toContain('Ascendancy: Unknown (ID: 2)');
    expect(text).not.toMatch(/Marauder|Berserker/);
  });

  it.each([
    { game: 'poe1', treeVersion: '0_5', className: 'Marauder', ascendClassName: 'Berserker' },
    { game: 'poe2', treeVersion: '3_29', className: 'Marauder', ascendClassName: 'Berserker' },
  ])('does not attach names from mismatched native metadata', async info => {
    const text = (await handleLuaGetTree(context(info))).content[0].text;
    expect(text).toContain('Class: Unknown (ID: 1)');
    expect(text).toContain('Ascendancy: Unknown (ID: 2)');
    expect(text).not.toMatch(/Marauder|Berserker/);
  });

  it('uses native zero ascendancy as evidence of no selection', async () => {
    const text = (await handleLuaGetTree(context(null, { ascendClassId: 0 }))).content[0].text;
    expect(text).toContain('Ascendancy: None (ID: 0)');
  });

  it('does not guess names or IDs when both are absent', async () => {
    const text = (await handleLuaGetTree(context(null, { classId: undefined, ascendClassId: undefined }))).content[0].text;
    expect(text).toContain('Class: Unknown (ID: Unknown)');
    expect(text).toContain('Ascendancy: Unknown (ID: Unknown)');
  });

  it('keeps explicit PoE1 rendering for a PoE1 tree', async () => {
    process.env.POE_GAME = 'poe1';
    const ctx = context(null, { treeVersion: '3_29' });
    const text = (await handleLuaGetTree(ctx)).content[0].text;
    expect(text).toContain('Class: Marauder (ID: 1)');
    expect(ctx.client.getBuildInfo).not.toHaveBeenCalled();
  });

  it('does not send a native PoE2 tree through PoE1 numeric labels', async () => {
    process.env.POE_GAME = 'poe1';
    const text = (await handleLuaGetTree(context())).content[0].text;
    expect(text).toContain('Class: Witch (ID: 1)');
    expect(text).not.toMatch(/Marauder|Berserker/);
  });
});

const live = process.env.POE2_TREE_IDENTITY_PORT ? describe : describe.skip;
live('native tree identity read-only evidence', () => {
  it('uses native get_tree/get_build_info names on the running PoB2 instance', async () => {
    const client = new PoBLuaTcpClient({ host: '127.0.0.1', port: Number(process.env.POE2_TREE_IDENTITY_PORT), timeoutMs: 10000 });
    try {
      await client.start();
      const info = await client.getBuildInfo();
      const ctx: any = { getLuaClient: () => client, ensureLuaClient: async () => {} };
      const text = (await handleLuaGetTree(ctx)).content[0].text;
      expect(info.game).toBe('poe2');
      expect(typeof info.className).toBe('string');
      // Booleans prevent unexpected private build metadata appearing in failures.
      expect(text.includes(`Class: ${info.className} (ID:`)).toBe(true);
      if (info.ascendClassName) expect(text.includes(`Ascendancy: ${info.ascendClassName} (ID:`)).toBe(true);
      expect(text.includes('Source: native PoB2 build info')).toBe(true);
    } finally { await client.stop(); }
  }, 30000);
});
