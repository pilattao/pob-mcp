/** Caller-only tests: real router, handlers and bridge methods; no native runtime calls. */
import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { PoBLuaTcpClient } from '../../src/pobLuaBridge.js';
import { routeToolCall } from '../../src/server/toolRouter.js';
import { getLuaToolSchemas } from '../../src/server/toolSchemas.js';

function schema(name: string) {
  const tool = getLuaToolSchemas().find(t => t.name === name);
  if (!tool) throw new Error(`Missing tool ${name}`);
  return tool;
}

function callers() {
  const requests: Array<{ action: string; params?: Record<string, unknown> }> = [];
  const client = new PoBLuaTcpClient({ port: 1 }); // Never started/connected.
  jest.spyOn(client as any, 'send').mockImplementation(async (request: any) => {
    requests.push(request);
    if (request.action === 'get_stats') return { ok: true, stats: {} };
    if (request.action === 'list_spectres' || request.action === 'set_spectres') {
      return { ok: true, result: { active: [{ id: 'monster', name: 'Test Spectre', groupIndex: 3, gemIndex: 2, enabled: false }] } };
    }
    return { ok: true };
  });
  const context = { getLuaClient: () => client, ensureLuaClient: async () => undefined };
  const deps: any = {
    toolGate: { checkGate: () => undefined },
    contextBuilder: {
      buildHandlerContext: () => ({}), buildWatchContext: () => ({}), buildTreeContext: () => ({}),
      buildLuaContext: () => context, buildItemSkillContext: () => context,
      buildOptimizationContext: () => ({}), buildExportContext: () => ({}), buildSkillGemContext: () => ({}),
    },
    getLuaClient: () => null, // Suppress the cosmetic GUI tab switch.
    ensureLuaClient: async () => undefined,
  };
  return { requests, call: (name: string, args: Record<string, unknown>) => routeToolCall(name, args, deps) };
}

let originalGame: string | undefined;
beforeEach(() => { originalGame = process.env.POE_GAME; process.env.POE_GAME = 'poe2'; });
afterEach(() => {
  if (originalGame === undefined) delete process.env.POE_GAME; else process.env.POE_GAME = originalGame;
  jest.restoreAllMocks();
});

describe('PoE2 mutation caller contracts', () => {
  it('advertises exactly one flask index or explicit consumable slot', () => {
    const input = schema('toggle_flask').inputSchema;
    expect(input.required).toEqual(['active']);
    expect(input.properties.flask_number).toMatchObject({ type: 'integer', minimum: 1, maximum: 2 });
    expect(input.properties.slotName.enum).toEqual(['Flask 1', 'Flask 2', 'Charm 1', 'Charm 2', 'Charm 3']);
    expect(input.oneOf).toEqual([{ required: ['flask_number'] }, { required: ['slotName'] }]);
  });

  it('forwards a charm through router, handler and bridge without a phantom flask index', async () => {
    const { call, requests } = callers();
    const response = await call('toggle_flask', { slotName: 'Charm 3', active: true });
    expect(requests[0]).toEqual({ action: 'set_flask_active', params: { slotName: 'Charm 3', active: true } });
    expect(response.content[0].text).toContain('Charm 3 activated');
    expect(response.content[0].text).not.toContain('undefined');
  });

  it.each([1, 2])('retains numeric flask %i requests', async number => {
    const { call, requests } = callers();
    await call('toggle_flask', { flask_number: number, active: false });
    expect(requests[0]).toEqual({ action: 'set_flask_active', params: { index: number, active: false } });
  });

  it.each([
    { active: true }, { flask_number: 3, active: true }, { flask_number: 1.5, active: true },
    { flask_number: 1, slotName: 'Charm 1', active: true }, { slotName: 'Charm 4', active: true },
    { slotName: 'Weapon 1', active: true }, { slotName: 'Charm 1', active: 'false' },
    { flask_number: null, active: true },
  ])('rejects invalid activation before transport: %j', async args => {
    const { call, requests } = callers();
    await expect(call('toggle_flask', args)).rejects.toThrow();
    expect(requests).toEqual([]);
  });

  it.each(['add_item', 'clear_item_slot'])('%s advertises PoE2 equipment and consumable slots', name => {
    const slot = schema(name).inputSchema.properties.slot_name;
    expect(slot.enum).toEqual(expect.arrayContaining(['Weapon 1 Swap', 'Weapon 2 Swap', 'Ring 3', 'Charm 1', 'Charm 2', 'Charm 3', 'Flask 1', 'Flask 2']));
    expect(slot.enum).not.toEqual(expect.arrayContaining(['Flask 3']));
    expect(slot.description).not.toContain('1-5');
  });

  it.each(['create_socket_group', 'setup_skill_with_gems'])('%s offers slot-linked PoE2 support groups', name => {
    const slots = schema(name).inputSchema.properties.slot.enum;
    expect(slots).toEqual(expect.arrayContaining(['Weapon 1 Swap', 'Weapon 2 Swap', 'Ring 3']));
    expect(slots.some((s: string) => /Flask|Charm/.test(s))).toBe(false);
  });

  it('advertises one spectre per gem and forwards both indices', async () => {
    const tool = schema('set_spectres');
    expect(tool.inputSchema.required).toEqual(['spectres', 'group_index', 'gem_index']);
    expect(tool.inputSchema.properties.spectres).toMatchObject({ minItems: 1, maxItems: 1 });
    expect(tool.inputSchema.properties.mode.enum).toEqual(['replace']);
    expect(tool.description).toContain('per gem');
    const { call, requests } = callers();
    const response = await call('set_spectres', { spectres: ['monster'], group_index: 3, gem_index: 2 });
    expect(requests[0]).toEqual({ action: 'set_spectres', params: { spectres: ['monster'], groupIndex: 3, gemIndex: 2 } });
    expect(response.content[0].text).toContain('group 3, gem 2');
    expect(response.content[0].text).not.toMatch(/persist across|zoo|list replaced/);
  });

  it.each([
    { spectres: ['monster'] }, { spectres: ['one', 'two'], group_index: 3, gem_index: 2 },
    { spectres: ['monster'], group_index: 3, gem_index: 2, mode: 'add' },
    { spectres: ['monster'], group_index: 0, gem_index: 2 },
    { spectres: ['monster'], group_index: 3, gem_index: 1.5 },
  ])('rejects a non-per-gem PoE2 spectre request: %j', async args => {
    const { call, requests } = callers();
    await expect(call('set_spectres', args)).rejects.toThrow();
    expect(requests).toEqual([]);
  });

  it('labels listed spectres with gem selection and disabled state', async () => {
    const { call } = callers();
    const result = await call('list_spectres', {});
    expect(result.content[0].text).toContain('group 3, gem 2');
    expect(result.content[0].text).toContain('disabled');
    expect(schema('list_spectres').description).not.toMatch(/generic spectres|Determination|raised/);
  });

  it('forwards the PoE2 stat-set index and existing selection fields', async () => {
    expect(schema('set_main_skill').inputSchema.properties.stat_set).toMatchObject({ type: 'integer', minimum: 1 });
    const { call, requests } = callers();
    const response = await call('set_main_skill', { group_index: 3, active_skill_index: 2, skill_part: 1, stat_set: 2 });
    expect(requests[0]).toEqual({ action: 'set_main_selection', params: { mainSocketGroup: 3, mainActiveSkill: 2, skillPart: 1, statSet: 2 } });
    expect(response.content[0].text).toContain('stat set 2');
  });

  it.each([0, 1.5, '2'])('rejects invalid stat-set index %j before transport', async value => {
    const { call, requests } = callers();
    await expect(call('set_main_skill', { group_index: 3, stat_set: value })).rejects.toThrow();
    expect(requests).toEqual([]);
  });

  it('retains PoE1 flask and global spectre contracts after PoE2 schema use', async () => {
    const { call, requests } = callers();
    await call('toggle_flask', { flask_number: 1, active: false });
    process.env.POE_GAME = 'poe1';
    expect(schema('toggle_flask').inputSchema.required).toEqual(['flask_number', 'active']);
    expect(schema('toggle_flask').inputSchema.properties.flask_number.maximum).toBe(5);
    expect(schema('toggle_flask').inputSchema.properties.slotName).toBeUndefined();
    expect(schema('set_spectres').inputSchema.required).toEqual(['spectres']);
    expect(schema('set_spectres').inputSchema.properties.mode.enum).toEqual(['replace', 'add']);
    expect(schema('add_item').inputSchema.properties.slot_name.enum).toContain('Flask 5');
    await call('toggle_flask', { flask_number: 5, active: true });
    await call('set_spectres', { spectres: ['one', 'two'], mode: 'add' });
    expect(requests.find(r => r.action === 'set_spectres')?.params).toEqual({ spectres: ['one', 'two'], mode: 'add' });
  });
});
