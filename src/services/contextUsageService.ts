/**
 * Explicit-source transcript usage. Never discover files, consult client homes,
 * reuse another request's path, or estimate current context occupancy.
 *
 * Codex adapter: session_meta + event_msg/token_count (info.last_token_usage /
 * total_token_usage). This JSONL adapter is version-dependent: unsupported
 * records yield unavailable. Public per-thread usage documentation:
 * https://developers.openai.com/codex/app-server
 * Claude input/cache semantics:
 * https://platform.claude.com/docs/en/build-with-claude/prompt-caching
 *
 * Integration owned elsewhere: route args into handleGetContextUsage(args), and
 * expose optional client ('codex'|'claude'), transcript_path, thread_id fields.
 * All three are required as a group before this service opens any file.
 */
import { constants, promises as fs } from 'node:fs';
import * as path from 'node:path';
import { StringDecoder } from 'node:string_decoder';

export interface ContextUsageOptions {
  client?: 'codex' | 'claude';
  transcript_path?: string;
  thread_id?: string;
}

export const MAX_TRANSCRIPT_BYTES = 128 * 1024 * 1024;
export const MAX_LINE_CHARACTERS = 8 * 1024 * 1024;

type ObjectValue = Record<string, unknown>;
interface UsageCounts {
  /** Normalized complete input, including cached input exactly once. */
  input_tokens: number;
  cached_input_tokens: number | null;
  uncached_input_tokens: number | null;
  cache_creation_input_tokens: number | null;
  output_tokens: number;
  reasoning_output_tokens: number | null;
  total_tokens: number;
}
interface UsageRecord {
  last_request: UsageCounts | null;
  cumulative_usage: UsageCounts | null;
  reported_context_window_tokens: number | null;
  model: string | null;
  recorded_at: string | null;
}
class Unavailable extends Error {
  constructor(readonly reason: string) { super(reason); }
}
function object(value: unknown): ObjectValue | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as ObjectValue : null;
}
function count(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) throw new Unavailable('invalid_usage_record');
  return value;
}
function optionalCount(value: unknown): number | null {
  return value === undefined || value === null ? null : count(value);
}
function identifier(value: unknown): string | null {
  return typeof value === 'string' && /^[A-Za-z0-9_.:/-]{1,200}$/.test(value) ? value : null;
}
function timestamp(value: unknown): string | null {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(value) && Number.isFinite(Date.parse(value)) ? value : null;
}
function codexCounts(value: unknown): UsageCounts | null {
  if (value === null || value === undefined) return null;
  const raw = object(value);
  if (!raw) throw new Unavailable('invalid_usage_record');
  const input = count(raw.input_tokens);
  const output = count(raw.output_tokens);
  const cached = optionalCount(raw.cached_input_tokens);
  const reasoning = optionalCount(raw.reasoning_output_tokens);
  if ((cached !== null && cached > input) || (reasoning !== null && reasoning > output)) throw new Unavailable('invalid_usage_record');
  return { input_tokens: input, cached_input_tokens: cached,
    uncached_input_tokens: cached === null ? null : input - cached,
    cache_creation_input_tokens: null, output_tokens: output,
    reasoning_output_tokens: reasoning, total_tokens: count(raw.total_tokens) };
}
function claudeCounts(value: unknown): UsageCounts {
  const raw = object(value);
  if (!raw) throw new Unavailable('invalid_usage_record');
  const uncached = count(raw.input_tokens);
  const cached = raw.cache_read_input_tokens === undefined ? 0 : count(raw.cache_read_input_tokens);
  const created = raw.cache_creation_input_tokens === undefined ? 0 : count(raw.cache_creation_input_tokens);
  const input = count(uncached + cached + created);
  const output = count(raw.output_tokens);
  return { input_tokens: input, cached_input_tokens: cached,
    uncached_input_tokens: count(uncached + created), cache_creation_input_tokens: created,
    output_tokens: output, reasoning_output_tokens: null, total_tokens: count(input + output) };
}

/** Keeps only usage metadata; never retains message/tool content in its state. */
class TranscriptUsage {
  private verified = false;
  private currentModel: string | null = null;
  latest: UsageRecord | null = null;
  trailingPartial = false;
  constructor(private readonly client: 'codex' | 'claude', private readonly threadId: string) {}

  consume(line: string, trailing = false): void {
    if (!line.trim()) return;
    let record: ObjectValue | null;
    try { record = object(JSON.parse(line)); }
    catch {
      if (trailing) { this.trailingPartial = true; return; }
      throw new Unavailable('malformed_transcript');
    }
    if (!record) throw new Unavailable('malformed_transcript');
    if (this.client === 'codex') this.codex(record);
    else this.claude(record);
  }
  private checkIdentity(value: unknown): void {
    if (typeof value !== 'string') throw new Unavailable('missing_session_identity');
    if (value !== this.threadId) throw new Unavailable('session_mismatch');
    this.verified = true;
  }
  private codex(record: ObjectValue): void {
    if (record.sessionId !== undefined) throw new Unavailable('client_mismatch');
    const payload = object(record.payload);
    if (record.type === 'session_meta') {
      this.checkIdentity(payload?.id);
      return;
    }
    if (record.type === 'turn_context') {
      if (!this.verified) throw new Unavailable('missing_session_identity');
      if (payload?.thread_id !== undefined) this.checkIdentity(payload.thread_id);
      this.currentModel = identifier(payload?.model);
      return;
    }
    if (record.type !== 'event_msg' || payload?.type !== 'token_count') return;
    if (!this.verified) throw new Unavailable('missing_session_identity');
    if (payload.thread_id !== undefined) this.checkIdentity(payload.thread_id);
    // Rate-limit-only events carry info=null and cannot establish token usage.
    if (payload.info === null || payload.info === undefined) return;
    const info = object(payload.info);
    if (!info) throw new Unavailable('invalid_usage_record');
    const last = codexCounts(info.last_token_usage);
    const cumulative = codexCounts(info.total_token_usage);
    if (!last && !cumulative) throw new Unavailable('invalid_usage_record');
    this.latest = { last_request: last, cumulative_usage: cumulative,
      reported_context_window_tokens: optionalCount(info.model_context_window),
      model: this.currentModel, recorded_at: timestamp(record.timestamp) };
  }
  private claude(record: ObjectValue): void {
    if (record.type === 'session_meta' || record.type === 'event_msg' || record.type === 'turn_context') throw new Unavailable('client_mismatch');
    if (record.sessionId !== undefined) this.checkIdentity(record.sessionId);
    const message = object(record.message);
    if (record.type !== 'assistant' || message?.usage === undefined) return;
    // Claude usage must be self-identifying, not inherited from an older line.
    this.checkIdentity(record.sessionId);
    if (record.isSidechain === true) throw new Unavailable('sidechain_source');
    this.latest = { last_request: claudeCounts(message.usage), cumulative_usage: null,
      reported_context_window_tokens: null, model: identifier(message.model), recorded_at: timestamp(record.timestamp) };
  }
  finish(): UsageRecord {
    if (!this.verified) throw new Unavailable('missing_session_identity');
    if (!this.latest) throw new Unavailable('usage_not_found');
    return this.latest;
  }
}

function baseReport() {
  return { last_request: null as UsageCounts | null, cumulative_usage: null as UsageCounts | null,
    reported_context_window_tokens: null as number | null, model: null as string | null,
    recorded_at: null as string | null,
    context_occupancy: { status: 'unavailable', used_tokens: null, remaining_tokens: null, percent_used: null },
    account_limits: { status: 'not_inspected' },
    note: 'Recorded request/cumulative token usage is not current context occupancy. Cached input and reasoning output are subsets, not extra tokens. Account limits are a separate client/account metric.' };
}
function unavailable(reason: string) {
  return { status: 'unavailable', reason, ...baseReport() };
}

export async function readContextUsage(options: ContextUsageOptions = {}) {
  // Deliberately before stat/open: no environment, CWD, home or previous-call fallback.
  if (!options || !options.client || !options.transcript_path || !options.thread_id) return unavailable('explicit_source_required');
  if ((options.client !== 'codex' && options.client !== 'claude') || typeof options.transcript_path !== 'string' || typeof options.thread_id !== 'string' ||
      !path.isAbsolute(options.transcript_path) || !options.transcript_path.endsWith('.jsonl') || !options.thread_id.trim() || options.thread_id.length > 200 ||
      /[\u0000-\u001f]/.test(options.thread_id)) return unavailable('invalid_source_options');
  let handle: Awaited<ReturnType<typeof fs.open>> | undefined;
  try {
    // Refuse indirect/non-file sources; only this explicit path is inspected.
    const info = await fs.lstat(options.transcript_path);
    if (!info.isFile() || info.isSymbolicLink()) throw new Unavailable('source_not_regular_file');
    if (info.size > MAX_TRANSCRIPT_BYTES) throw new Unavailable('source_too_large');
    handle = await fs.open(options.transcript_path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
    const opened = await handle.stat();
    if (!opened.isFile() || opened.ino !== info.ino || opened.dev !== info.dev) throw new Unavailable('source_changed');
    if (opened.size > MAX_TRANSCRIPT_BYTES) throw new Unavailable('source_too_large');
    const parser = new TranscriptUsage(options.client, options.thread_id);
    const decoder = new StringDecoder('utf8');
    const buffer = Buffer.alloc(64 * 1024);
    let readBytes = 0;
    let pending = '';
    // Read one bounded file snapshot, validating every identity marker. Never
    // jump over an unseen session boundary by sampling unrelated head/tail data.
    while (readBytes < opened.size) {
      const read = await handle.read(buffer, 0, Math.min(buffer.length, opened.size - readBytes), readBytes);
      if (!read.bytesRead) throw new Unavailable('source_changed');
      readBytes += read.bytesRead;
      pending += decoder.write(buffer.subarray(0, read.bytesRead));
      let end = pending.indexOf('\n');
      while (end !== -1) {
        if (end > MAX_LINE_CHARACTERS) throw new Unavailable('record_too_large');
        parser.consume(pending.slice(0, end));
        pending = pending.slice(end + 1);
        end = pending.indexOf('\n');
      }
      if (pending.length > MAX_LINE_CHARACTERS) throw new Unavailable('record_too_large');
    }
    pending += decoder.end();
    if (pending) parser.consume(pending, true);
    const usage = parser.finish();
    return { status: 'available', ...baseReport(), ...usage,
      source: { client: options.client, thread_id: options.thread_id, identity_verified: true,
        read_bytes: readBytes, file_snapshot_bytes: opened.size,
        trailing_partial_record_ignored: parser.trailingPartial },
      semantics: options.client === 'codex'
        ? 'Codex input_tokens already includes cached_input_tokens. Cumulative counters are reported directly, never summed across token_count events.'
        : 'Claude normalized input_tokens = reported input_tokens + cache_read_input_tokens + cache_creation_input_tokens. No cumulative session total is inferred.' };
  } catch (error) {
    // No paths, transcript snippets, foreign IDs or exception text escape here.
    return unavailable(error instanceof Unavailable ? error.reason : 'source_read_failed');
  } finally {
    await handle?.close().catch(() => undefined);
  }
}
