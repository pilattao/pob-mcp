/**
 * Response Utilities
 *
 * Utilities for formatting and processing MCP tool responses
 */

export type ToolResponse = {
  content: Array<{
    type: string;
    text: string;
  }>;
};

/**
 * Truncate response text if it exceeds a reasonable limit for Claude Desktop.
 * This prevents timeouts and reduces token usage when responses are too large.
 *
 * @param text - The text to truncate
 * @param maxLength - Maximum length before truncation (default: 5000 to minimize tokens)
 * @returns Truncated text with helpful message if truncated
 */
export function truncateResponse(text: string, maxLength: number = 5000): string {
  if (maxLength === 0) return text;
  if (text.length <= maxLength) {
    return text;
  }

  const truncated = text.substring(0, maxLength);
  const lastNewline = truncated.lastIndexOf('\n');
  const safeText = lastNewline > 0 ? truncated.substring(0, lastNewline) : truncated;

  const remaining = text.length - safeText.length;
  const remainingLines = text.substring(safeText.length).split('\n').length;

  return safeText + `\n\n[Response truncated: ${remaining} characters, ~${remainingLines} lines remaining]\n` +
         `[Use more specific queries to see detailed information]`;
}

/**
 * Wrap handler result with truncation for large responses
 *
 * @param result - The handler result to wrap
 * @param maxLength - Maximum length before truncation (default: 5000 to minimize tokens)
 * @returns The result with text truncated if needed
 */
function configuredLimit(): number {
  const value = Number(process.env.POB_MAX_RESPONSE_CHARS ?? 5000);
  return Number.isSafeInteger(value) && value >= 0 ? value : 5000;
}

export function wrapWithTruncation<T extends ToolResponse>(
  result: T,
  maxLength: number = configuredLimit()
): T {
  if (result.content[0] && result.content[0].type === 'text') {
    result.content[0].text = truncateResponse(result.content[0].text, maxLength);
  }
  return result;
}
