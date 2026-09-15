/** Explicit current-client/session usage only; no automatic transcript discovery. */
import { readContextUsage, type ContextUsageOptions } from '../services/contextUsageService.js';

/**
 * No arguments is intentionally safe and returns unavailable without filesystem
 * access. Router/schema owners should pass optional client, transcript_path,
 * thread_id inputs together. No provider call or account-limit inspection occurs.
 */
export async function handleGetContextUsage(options: ContextUsageOptions = {}) {
  const report = await readContextUsage(options);
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(report, null, 2) }],
  };
}
