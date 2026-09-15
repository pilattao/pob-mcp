import { describe, it, expect, beforeEach, afterEach, jest } from '@jest/globals';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { handleGetStatBreakdown } from '../../src/handlers/statBreakdownHandler';

function getText(result: { content: Array<{ type: string; text: string }> }): string {
  return result.content.map((c) => c.text).join('\n');
}

function makeContext(breakdown: unknown, info?: unknown) {
  return {
    ensureLuaClient: async () => {},
    getLuaClient: () =>
      ({
        getStatBreakdown: async () => breakdown,
        ...(info ? { getBuildInfo: async () => info } : {}),
      }) as unknown as import('../../src/pobLuaBridge').AnyLuaClient,
  };
}

describe('handleGetStatBreakdown', () => {
  it('rejects missing stat', async () => {
    const r = await handleGetStatBreakdown(makeContext({}), { stat: '' });
    expect(r.isError).toBe(true);
  });

  it('formats contributions grouped by mod type', async () => {
    const breakdown = {
      stat: 'Life',
      actor: 'player',
      output_value: 4200,
      contributions: [
        { modType: 'BASE', value: 99, source: 'Tree:55834', name: 'Life', flags: 0 },
        { modType: 'BASE', value: 38, source: 'Item:5:Belt', name: 'Life', flags: 0 },
        { modType: 'INC', value: 8, source: 'Tree:12345', name: 'Life', flags: 0 },
        { modType: 'INC', value: 12, source: 'Item', name: 'Life', flags: 0 },
        { modType: 'BASE', value: 50, source: 'Base', name: 'Life', flags: 0 },
      ],
    };
    const r = await handleGetStatBreakdown(makeContext(breakdown), { stat: 'Life' });
    const text = getText(r);
    expect(text).toMatch(/Breakdown: Life \(player\)/);
    expect(text).toMatch(/Current output value: 4200/);
    expect(text).toMatch(/--- BASE/);
    expect(text).toMatch(/--- INC/);
    // Source humanizing: Item slot label surfaces
    expect(text).toMatch(/Item: Belt/);
    expect(text).toMatch(/Base \(innate\)/);
    // INC values rendered as percentages
    expect(text).toMatch(/\+12%/);
  });

  it('resolves Tree: sources to passive node names when available', async () => {
    // Decoration is optional: unavailable build/tree metadata cannot discard
    // successfully returned native contributions.
    const breakdown = {
      stat: 'Life',
      actor: 'player',
      output_value: 100,
      contributions: [{ modType: 'BASE', value: 10, source: 'Tree:55834', name: 'Life', flags: 0 }],
    };
    const r = await handleGetStatBreakdown(makeContext(breakdown), { stat: 'Life' });
    expect(getText(r)).toMatch(/Passive/);
  });

  it('handles an empty contribution list with guidance', async () => {
    const breakdown = { stat: 'Wibble', actor: 'player', output_value: null, contributions: [] };
    const r = await handleGetStatBreakdown(makeContext(breakdown), { stat: 'Wibble' });
    const text = getText(r);
    expect(text).toMatch(/No contributing modifiers/);
    expect(text).toMatch(/skill-conditional|internal mod name/);
  });

  it('returns raw JSON with humanized sources when requested', async () => {
    const breakdown = {
      stat: 'FireResist',
      actor: 'player',
      output_value: 75,
      contributions: [{ modType: 'BASE', value: 48, source: 'Item:3:Helmet', name: 'FireResist', flags: 0 }],
    };
    const r = await handleGetStatBreakdown(makeContext(breakdown), { stat: 'FireResist', raw_json: true });
    const parsed = JSON.parse(getText(r));
    expect(parsed.stat).toBe('FireResist');
    expect(parsed.contributions[0].sourceHuman).toMatch(/Item: Helmet/);
  });
});

describe('PoE2 stat breakdown source semantics', () => {
  let directory: string;
  let saved: NodeJS.ProcessEnv;
  const info = { game: 'poe2', treeVersion: '0_5', name: 'Synthetic' };
  const contribution = { modType: 'BASE', value: 389, source: 'Tree:31223', name: 'Life', flags: 0 };
  const breakdown = () => ({ stat: 'Life', actor: 'player', config: 'global', output_value: 2502, inc_sum: 11, more_multiplier: 1, contributions: [{ ...contribution }] });
  const writeTree = (version: string, name: string) => {
    const dir = path.join(directory, 'TreeData', version);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'tree.lua'), `return { tree="${version}", nodes={ [31223]={skill=31223,name="${name}",stats={},connections={}} }, groups={}, classes={} }`);
  };
  beforeEach(() => {
    saved = { ...process.env };
    directory = fs.mkdtempSync(path.join(os.tmpdir(), 'stat-breakdown-'));
    process.env.POB_INSTALL_DIR = directory;
    process.env.POE_MCP_SUITE_ROOT = directory;
    process.env.POE_GAME = 'poe2';
    writeTree('0_5', 'Current passive');
  });
  afterEach(() => {
    for (const key of ['POB_INSTALL_DIR', 'POE_MCP_SUITE_ROOT', 'POE_GAME']) {
      if (saved[key] === undefined) delete process.env[key]; else process.env[key] = saved[key];
    }
    fs.rmSync(directory, { recursive: true, force: true });
  });

  it('resolves the active build version even when a newer PoE2 tree is installed', async () => {
    writeTree('0_4', 'Older active passive');
    writeTree('0_99', 'Newest wrong passive');
    const parsed = JSON.parse(getText(await handleGetStatBreakdown(makeContext(breakdown(), { ...info, treeVersion: '0_4' }), { stat: 'Life', raw_json: true })));
    expect(parsed.contributions[0]).toMatchObject({ ...contribution, sourceHuman: 'Passive: Older active passive (31223)' });
    expect(parsed.source_context.treeVersion).toBe('0_4');
  });

  it('keeps native contributions when the requested tree is missing and blocks the PoE1 fallback', async () => {
    fs.rmSync(path.join(directory, 'TreeData'), { recursive: true });
    const dir = path.join(directory, 'reference_data', 'skilltree'); fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'data.json'), JSON.stringify({ nodes: { 31223: { name: 'Wrong PoE1 fallback' } }, groups: {} }));
    const result = await handleGetStatBreakdown(makeContext(breakdown(), info), { stat: 'Life', raw_json: true });
    expect(result.isError).not.toBe(true);
    const parsed = JSON.parse(getText(result));
    expect(parsed.contributions[0]).toMatchObject(contribution);
    expect(parsed.contributions[0].sourceHuman).toContain('Passive node 31223');
    expect(parsed.source_context.notes.join(' ')).toMatch(/unavailable/);
    expect(getText(result)).not.toContain('Wrong PoE1 fallback');
  });

  it('does not use the latest installed tree when live metadata is unavailable', async () => {
    const parsed = JSON.parse(getText(await handleGetStatBreakdown(makeContext(breakdown()), { stat: 'Life', raw_json: true })));
    expect(parsed.contributions[0].sourceHuman).toContain('Passive node 31223');
    expect(parsed.source_context.treeVersion).toBeNull();
    expect(getText({ content: [{ type: 'text', text: JSON.stringify(parsed) }] })).not.toContain('Current passive');
  });

  it.each([{ game: 'poe1', treeVersion: '3_26' }, { game: 'poe2', treeVersion: '3_26' }])('rejects conflicting live game/tree provenance: %j', async metadata => {
    const result = await handleGetStatBreakdown(makeContext(breakdown(), metadata), { stat: 'Life' });
    expect(result.isError).toBe(true);
    expect(getText(result)).toMatch(/PoE2|poe2/);
  });

  it('uses explicit native PoE2 provenance even without POE_GAME and never names from PoE1', async () => {
    delete process.env.POE_GAME;
    writeTree('3_29', 'Wrong PoE1 passive');
    const text = getText(await handleGetStatBreakdown(makeContext(breakdown(), info), { stat: 'Life' }));
    expect(text).toContain('Current passive');
    expect(text).not.toContain('Wrong PoE1 passive');
  });

  it('preserves item ID and the full native item name, including colons', async () => {
    const b = breakdown(); b.contributions = [{ ...contribution, source: 'Item:6:Keep: Variant, Sorcerous Tiara' }];
    const parsed = JSON.parse(getText(await handleGetStatBreakdown(makeContext(b, info), { stat: 'Life', raw_json: true })));
    expect(parsed.contributions[0].source).toBe('Item:6:Keep: Variant, Sorcerous Tiara');
    expect(parsed.contributions[0].sourceHuman).toBe('Item: Keep: Variant, Sorcerous Tiara (item 6)');
  });

  it('relays native aggregates and output independently instead of reconstructing a stat total', async () => {
    const b = { stat: 'CritMultiplier', actor: 'player', config: 'skill', config_note: 'Lightning Bolt', output_value: 6.06, inc_sum: 406, more_multiplier: 0.67,
      contributions: [{ ...contribution, modType: 'INC', value: 21 }, { ...contribution, modType: 'MORE', value: -20 }] };
    const text = getText(await handleGetStatBreakdown(makeContext(b, info), { stat: b.stat, use_skill_config: true }));
    expect(text).toContain('Current output value: 6.06');
    expect(text).toContain('Native INC sum: +406%');
    expect(text).toContain('Native MORE multiplier: 0.67');
    expect(text).toContain('20% less');
    expect(text).toMatch(/single modifier name|single mod name/i);
    expect(text).toContain('get_calc_breakdown');
  });

  it('does not describe nil-config queries as unconditional or complete', async () => {
    const text = getText(await handleGetStatBreakdown(makeContext(breakdown(), info), { stat: 'Life' }));
    expect(text).toMatch(/conditions|conditional/);
    expect(text).not.toMatch(/unconditional mods only|Accurate for unconditional|captures skill-conditional mods/);
  });

  it('preserves unavailable output and zero-valued aggregates', async () => {
    const b = { ...breakdown(), output_value: null, inc_sum: 0, more_multiplier: 0 };
    const text = getText(await handleGetStatBreakdown(makeContext(b, info), { stat: 'Life' }));
    expect(text).toMatch(/Current output value: unavailable/);
    expect(text).toContain('Native INC sum: 0%');
    expect(text).toContain('Native MORE multiplier: 0');
  });

  it('rejects malformed native results instead of claiming there are no contributions', async () => {
    const result = await handleGetStatBreakdown(makeContext({ stat: 'Life', actor: 'player' }, info), { stat: 'Life' });
    expect(result.isError).toBe(true);
    expect(getText(result)).toMatch(/invalid|unavailable|malformed/i);
  });

  it('keeps native data but leaves names unknown when the active build changes during a query', async () => {
    const client = { getStatBreakdown: async () => breakdown(), getBuildInfo: jest.fn<() => Promise<unknown>>()
      .mockResolvedValueOnce(info).mockResolvedValueOnce({ ...info, treeVersion: '0_4' }) };
    const parsed = JSON.parse(getText(await handleGetStatBreakdown({ ensureLuaClient: async () => {}, getLuaClient: () => client as any }, { stat: 'Life', raw_json: true })));
    expect(parsed.contributions[0]).toMatchObject(contribution);
    expect(parsed.source_context.treeVersion).toBeNull();
    expect(parsed.source_context.notes.join(' ')).toMatch(/changed/);
    expect(parsed.contributions[0].sourceHuman).not.toContain('Current passive');
  });

  it('handles unavailable metadata without discarding a successful query', async () => {
    const client = { getStatBreakdown: async () => breakdown(), getBuildInfo: async () => { throw new Error('metadata unsupported'); } };
    const result = await handleGetStatBreakdown({ ensureLuaClient: async () => {}, getLuaClient: () => client as any }, { stat: 'Life' });
    expect(result.isError).not.toBe(true);
    expect(getText(result)).toContain('Passive node 31223');
  });

  it('does not relabel a player response as a requested minion breakdown', async () => {
    const result = await handleGetStatBreakdown(makeContext(breakdown(), info), { stat: 'Life', actor: 'minion' });
    expect(result.isError).toBe(true);
    expect(getText(result)).toMatch(/actor does not match/);
  });

  it('preserves zero overrides, false flags, unknown source shapes and returned mod types', async () => {
    const b = { ...breakdown(), contributions: [
      { ...contribution, modType: 'OVERRIDE', value: 0, source: 'Config' },
      { ...contribution, modType: 'FLAG', value: false, source: 'Quest:Interlude 2: Khari Crossing' },
      { ...contribution, modType: 'MAX', value: 20, source: 'Unknown:source:shape' },
    ] };
    const text = getText(await handleGetStatBreakdown(makeContext(b, info), { stat: 'Life' }));
    expect(text).toMatch(/0.*Config/);
    expect(text).toMatch(/false.*Quest:Interlude 2: Khari Crossing/);
    expect(text).toMatch(/20.*Unknown:source:shape/);
  });
});
