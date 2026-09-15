import { describe, expect, it } from '@jest/globals';
import { handleGetGemDetail } from '../../src/handlers/luaHandlers.js';

async function render(caps: Record<string, unknown>) {
  const context: any = {
    ensureLuaClient: async () => {},
    getLuaClient: () => ({ getGemDetail: async () => ({ name: 'Spark', support: false, ...caps }) }),
  };
  return (await handleGetGemDetail(context, 'Spark')).content[0].text;
}

describe('gem level cap labels', () => {
  it('separates the natural gem cap from the calculation-data cap', async () => {
    const text = await render({ naturalMaxLevel: 20, maxLevel: 40 });
    expect(text).toContain('**Natural gem level cap:** 20');
    expect(text).toContain('**Calculation data level cap:** 40');
    expect(text).not.toContain('**Max Level:** 40');
  });

  it('does not infer a natural cap from available calculation levels', async () => {
    const text = await render({ maxLevel: 40 });
    expect(text).toContain('**Natural gem level cap:** unknown');
    expect(text).toContain('**Calculation data level cap:** 40');
  });

  it('keeps missing or invalid caps unknown', async () => {
    const text = await render({ naturalMaxLevel: NaN, maxLevel: Infinity });
    expect(text).toContain('**Natural gem level cap:** unknown');
    expect(text).toContain('**Calculation data level cap:** unknown');
    expect(text).not.toMatch(/NaN|Infinity/);
  });
});
