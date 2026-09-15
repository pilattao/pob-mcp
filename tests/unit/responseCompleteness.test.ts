import { describe, it, expect } from '@jest/globals';
import { truncateResponse, wrapWithTruncation } from '../../src/server/responseUtils.js';

describe('full response mode', () => {
  it('retains every item and validation section when the limit is explicitly zero', () => {
    const text = 'Equipment\n' + 'item details\n'.repeat(1000) + 'FINAL VALIDATION SECTION';
    expect(truncateResponse(text, 0)).toBe(text);
  });

  it('honors configured full responses without losing tool error metadata', () => {
    const previous = process.env.POB_MAX_RESPONSE_CHARS;
    process.env.POB_MAX_RESPONSE_CHARS = '0';
    try {
      const text = 'detail '.repeat(1000) + 'END';
      const result = { isError: true, content: [{ type: 'text', text }] };
      const wrapped = wrapWithTruncation(result);
      expect(wrapped.content[0].text).toBe(text);
      expect(wrapped.isError).toBe(true);
    } finally {
      if (previous === undefined) delete process.env.POB_MAX_RESPONSE_CHARS;
      else process.env.POB_MAX_RESPONSE_CHARS = previous;
    }
  });
});
