/** All transcript data is synthetic; no real client history is opened. */
import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import * as path from 'node:path';
import * as os from 'node:os';
import { handleGetContextUsage } from '../../src/handlers/contextHandlers';

const fs = require('node:fs') as typeof import('node:fs');
const realOpenSync = fs.openSync;
const realAsyncOpen = fs.promises.open;
let directory: string;
const id = 'synthetic-codex-thread';
const meta = { type: 'session_meta', payload: { id } };
const usage = (input: number, cached = 800, output = 50) => ({
  input_tokens: input, cached_input_tokens: cached, output_tokens: output,
  reasoning_output_tokens: 10, total_tokens: input + output,
});
const event = (last = usage(1000), cumulative = usage(710000, 690000, 10000)) => ({
  timestamp: '2026-09-15T10:00:00Z', type: 'event_msg', payload: {
    type: 'token_count', info: { last_token_usage: last, total_token_usage: cumulative, model_context_window: 272000 },
    rate_limits: { primary: { used_percent: 99 } },
  },
});
const codex = (...records: unknown[]) => [meta, { type: 'turn_context', payload: { model: 'synthetic-codex-model' } }, ...records];
function file(records: unknown[], name = 'synthetic.jsonl'): string {
  const location = path.join(directory, name);
  fs.writeFileSync(location, records.map(row => JSON.stringify(row)).join('\n') + '\n');
  return location;
}
async function call(args?: Record<string, unknown>) {
  // Cast supports the existing zero-argument handler while testing the new contract.
  const result = await (handleGetContextUsage as (args?: Record<string, unknown>) => Promise<{ content: Array<{ text: string }>; isError?: boolean }>)(args);
  return { result, data: JSON.parse(result.content[0].text) };
}

beforeEach(() => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), 'pob-context-synthetic-'));
  // The old implementation ignores arguments. These guards must protect every
  // test, including a red run against that old implementation.
  jest.spyOn(require('node:os'), 'homedir').mockReturnValue(directory);
  jest.spyOn(fs, 'readdirSync').mockImplementation(() => { throw new Error('Directory scanning is forbidden'); });
  jest.spyOn(fs, 'openSync').mockImplementation((location, flags, mode) => {
    if (!String(location).startsWith(directory + path.sep)) throw new Error('Non-fixture file access is forbidden');
    return realOpenSync(location, flags, mode);
  });
  jest.spyOn(fs.promises, 'open').mockImplementation(async (location, flags, mode) => {
    if (!String(location).startsWith(directory + path.sep)) throw new Error('Non-fixture file access is forbidden');
    return realAsyncOpen(location, flags, mode);
  });
});
afterEach(() => { jest.restoreAllMocks(); fs.rmSync(directory, { recursive: true, force: true }); });

describe('explicit context usage source', () => {
  it('does zero filesystem work without a supplied source and identity', async () => {
    const scan = jest.spyOn(fs, 'readdirSync').mockImplementation(() => { throw new Error('No transcript scanning allowed'); });
    const exists = jest.spyOn(fs, 'existsSync').mockReturnValue(false);
    const syncOpen = jest.spyOn(fs, 'openSync').mockImplementation(() => { throw new Error('No transcript reads allowed'); });
    const asyncOpen = jest.spyOn(fs.promises, 'open').mockImplementation(async () => { throw new Error('No transcript reads allowed'); });
    const { data } = await call();
    expect(data.status).toBe('unavailable');
    expect(data.reason).toBe('explicit_source_required');
    expect(data.context_occupancy.used_tokens).toBeNull();
    expect(data.account_limits.status).toBe('not_inspected');
    for (const spy of [scan, exists, syncOpen, asyncOpen]) expect(spy).not.toHaveBeenCalled();
  });

  it.each([
    { client: 'codex' },
    { client: 'codex', transcript_path: '/not/a/real/transcript.jsonl' },
    { transcript_path: '/not/a/real/transcript.jsonl', thread_id: id },
    { client: 'codex', thread_id: id },
  ])('requires client, path and thread identity before any read: %p', async args => {
    const open = jest.spyOn(fs.promises, 'open').mockImplementation(async () => { throw new Error('Unexpected read'); });
    const scan = jest.spyOn(fs, 'readdirSync').mockImplementation(() => { throw new Error('Unexpected scan'); });
    const sync = jest.spyOn(fs, 'openSync').mockImplementation(() => { throw new Error('Unexpected read'); });
    const exists = jest.spyOn(fs, 'existsSync').mockReturnValue(false);
    const { data } = await call(args);
    expect(data.status).toBe('unavailable');
    for (const spy of [open, scan, sync, exists]) expect(spy).not.toHaveBeenCalled();
  });

  it('separates last request, cumulative usage, capacity and account limits', async () => {
    const transcript = file(codex(event()));
    const { data } = await call({ client: 'codex', transcript_path: transcript, thread_id: id });
    expect(data.status).toBe('available');
    expect(data.last_request.input_tokens).toBe(1000);
    expect(data.last_request.cached_input_tokens).toBe(800);
    expect(data.last_request.uncached_input_tokens).toBe(200);
    expect(data.last_request.total_tokens).toBe(1050);
    expect(data.cumulative_usage.input_tokens).toBe(710000);
    expect(data.cumulative_usage.total_tokens).toBe(720000);
    expect(data.reported_context_window_tokens).toBe(272000);
    expect(data.context_occupancy).toMatchObject({ status: 'unavailable', used_tokens: null, percent_used: null });
    expect(data.account_limits.status).toBe('not_inspected');
    expect(data).not.toHaveProperty('model_notes');
    expect(data.model).toBe('synthetic-codex-model');
  });

  it('does not open a tail after identifying the wrong Codex session', async () => {
    const transcript = file([{ type: 'session_meta', payload: { id: 'different-session' } }, event()]);
    const { data } = await call({ client: 'codex', transcript_path: transcript, thread_id: id });
    expect(data.status).toBe('unavailable');
    expect(data.reason).toBe('session_mismatch');
    expect(data.last_request).toBeNull();
    expect(JSON.stringify(data)).not.toContain('different-session');
  });

  it('rejects missing or conflicting session metadata instead of trusting the filename', async () => {
    for (const rows of [[event()], [meta, event(), { type: 'session_meta', payload: { id: 'different' } }, event()]]) {
      const { data } = await call({ client: 'codex', transcript_path: file(rows), thread_id: id });
      expect(data.status).toBe('unavailable');
      expect(data.last_request).toBeNull();
    }
  });

  it('cannot read Claude usage as a Codex session', async () => {
    const transcript = file([{ type: 'assistant', sessionId: id, message: { model: 'unrelated-claude', usage: { input_tokens: 710000, output_tokens: 10 } } }]);
    const { data } = await call({ client: 'codex', transcript_path: transcript, thread_id: id });
    expect(data.status).toBe('unavailable');
    expect(JSON.stringify(data)).not.toContain('unrelated-claude');
  });

  it('keeps the latest record rather than summing repeated cumulative events', async () => {
    const transcript = file(codex(event(), event(), event(usage(900, 500), usage(720000, 700000, 10050))));
    const { data } = await call({ client: 'codex', transcript_path: transcript, thread_id: id });
    expect(data.cumulative_usage.total_tokens).toBe(730050);
    expect(data.last_request.input_tokens).toBe(900);
  });

  it('does not take a future turn model or rate-only event as usage', async () => {
    const transcript = file(codex(event(), { type: 'turn_context', payload: { model: 'future-model' } },
      { type: 'event_msg', payload: { type: 'token_count', info: null, rate_limits: { used_percent: 99 } } }));
    const { data } = await call({ client: 'codex', transcript_path: transcript, thread_id: id });
    expect(data.model).toBe('synthetic-codex-model');
    expect(data.last_request.input_tokens).toBe(1000);
    expect(data.account_limits.status).toBe('not_inspected');
  });

  it('does not reuse a prior path for subsequent sessions or no-source calls', async () => {
    const first = file(codex(event()), 'first.jsonl');
    expect((await call({ client: 'codex', transcript_path: first, thread_id: id })).data.status).toBe('available');
    expect((await call()).data.status).toBe('unavailable');
    const next = file([{ type: 'session_meta', payload: { id: 'next' } }, event(usage(300, 100))], 'next.jsonl');
    expect((await call({ client: 'codex', transcript_path: next, thread_id: 'next' })).data.last_request.input_tokens).toBe(300);
  });

  it('supports explicitly identified Claude usage with separate cache creation and read counts', async () => {
    const transcript = file([{ type: 'assistant', sessionId: 'claude-session', message: { model: 'synthetic-claude', usage: {
      input_tokens: 100, cache_read_input_tokens: 800, cache_creation_input_tokens: 200, output_tokens: 50,
    } } }]);
    const { data } = await call({ client: 'claude', transcript_path: transcript, thread_id: 'claude-session' });
    expect(data.last_request.input_tokens).toBe(1100);
    expect(data.last_request.cached_input_tokens).toBe(800);
    expect(data.last_request.cache_creation_input_tokens).toBe(200);
    expect(data.last_request.uncached_input_tokens).toBe(300);
    expect(data.last_request.total_tokens).toBe(1150);
    expect(data.cumulative_usage).toBeNull();
    expect(data.reported_context_window_tokens).toBeNull();
  });

  it('rejects a foreign Claude record instead of picking another message model', async () => {
    const transcript = file([{ type: 'assistant', sessionId: 'different', message: { model: 'foreign', usage: { input_tokens: 1, output_tokens: 2 } } }]);
    const { data } = await call({ client: 'claude', transcript_path: transcript, thread_id: id });
    expect(data.reason).toBe('session_mismatch');
    expect(data.model).toBeNull();
  });
});

  it('returns unavailable for a missing file without returning a path or raw exception', async () => {
    const missing = path.join(directory, 'missing.jsonl');
    const { data } = await call({ client: 'codex', transcript_path: missing, thread_id: id });
    expect(data.reason).toBe('source_read_failed');
    expect(JSON.stringify(data)).not.toContain(missing);
  });

  it.each([
    { input_tokens: -1, cached_input_tokens: 0, output_tokens: 5, total_tokens: 4 },
    { input_tokens: 100, cached_input_tokens: 101, output_tokens: 5, total_tokens: 105 },
    { input_tokens: '100', cached_input_tokens: 0, output_tokens: 5, total_tokens: 105 },
    { input_tokens: 100, cached_input_tokens: 0, output_tokens: 5, reasoning_output_tokens: 6, total_tokens: 105 },
  ])('rejects invalid counts without falling back to an older valid record: %p', async last => {
    const bad = { type: 'event_msg', payload: { type: 'token_count', info: { last_token_usage: last } } };
    const { data } = await call({ client: 'codex', transcript_path: file(codex(event(), bad)), thread_id: id });
    expect(data.reason).toBe('invalid_usage_record');
    expect(data.last_request).toBeNull();
  });

  it('does not convert unknown cache counts into zero cache hits', async () => {
    const countWithoutCache = { type: 'event_msg', payload: { type: 'token_count', info: {
      last_token_usage: { input_tokens: 1000, output_tokens: 100, total_tokens: 1100 },
    } } };
    const { data } = await call({ client: 'codex', transcript_path: file(codex(countWithoutCache)), thread_id: id });
    expect(data.last_request.cached_input_tokens).toBeNull();
    expect(data.last_request.uncached_input_tokens).toBeNull();
    expect(data.last_request.total_tokens).toBe(1100);
  });

  it('does not confuse rate limits alone with context usage', async () => {
    const ratesOnly = { type: 'event_msg', payload: { type: 'token_count', info: null, rate_limits: { primary: { used_percent: 10 } } } };
    const { data } = await call({ client: 'codex', transcript_path: file(codex(ratesOnly)), thread_id: id });
    expect(data.reason).toBe('usage_not_found');
    expect(data.context_occupancy.percent_used).toBeNull();
    expect(data.account_limits.status).toBe('not_inspected');
  });

  it('handles an incomplete final write but fails on a malformed complete record', async () => {
    const transcript = file(codex(event()));
    fs.appendFileSync(transcript, '{"synthetic_incomplete":');
    const { data } = await call({ client: 'codex', transcript_path: transcript, thread_id: id });
    expect(data.status).toBe('available');
    expect(data.source.trailing_partial_record_ignored).toBe(true);
    fs.appendFileSync(transcript, '\n');
    expect((await call({ client: 'codex', transcript_path: transcript, thread_id: id })).data.reason).toBe('malformed_transcript');
  });

  it('finds a foreign session boundary beyond the old four-megabyte tail limit', async () => {
    const transcript = file(codex(event(), { type: 'session_meta', payload: { id: 'foreign-hidden-in-middle' } },
      { type: 'response_item', payload: { text: 'x'.repeat(5 * 1024 * 1024) } }, event()));
    const { data } = await call({ client: 'codex', transcript_path: transcript, thread_id: id });
    expect(data.reason).toBe('session_mismatch');
    expect(data.cumulative_usage).toBeNull();
  });

  it('refuses symlinks and oversized files without opening another source', async () => {
    const transcript = file(codex(event()));
    const link = path.join(directory, 'link.jsonl');
    fs.symlinkSync(transcript, link);
    expect((await call({ client: 'codex', transcript_path: link, thread_id: id })).data.reason).toBe('source_not_regular_file');
    const fd = fs.openSync(transcript, 'r+');
    fs.ftruncateSync(fd, 129 * 1024 * 1024);
    fs.closeSync(fd);
    expect((await call({ client: 'codex', transcript_path: transcript, thread_id: id })).data.reason).toBe('source_too_large');
  });

  it('never returns embedded messages, instructions or unrelated account details', async () => {
    const secretMarker = 'SYNTHETIC_CONTENT_MUST_NOT_ESCAPE';
    const transcript = file(codex({ type: 'response_item', payload: { role: 'user', content: secretMarker } }, event()));
    const { result } = await call({ client: 'codex', transcript_path: transcript, thread_id: id });
    expect(result.content[0].text).not.toContain(secretMarker);
  });

  it('requires self-identifying Claude usage and rejects sidechain/subagent records', async () => {
    for (const extra of [{}, { sessionId: id, isSidechain: true }]) {
      const transcript = file([{ type: 'user', sessionId: id }, { type: 'assistant', ...extra, message: {
        model: 'synthetic-claude', usage: { input_tokens: 1, output_tokens: 2 },
      } }]);
      const { data } = await call({ client: 'claude', transcript_path: transcript, thread_id: id });
      expect(data.status).toBe('unavailable');
      expect(data.last_request).toBeNull();
    }
  });
