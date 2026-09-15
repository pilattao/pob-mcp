import { afterEach, describe, expect, it, jest } from '@jest/globals';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import { XMLParser } from 'fast-xml-parser';
import { BuildService } from '../../src/services/buildService.js';
import { ValidationService } from '../../src/services/validationService.js';
import { handleGetBuildIssues, formatIssuesResponse } from '../../src/handlers/buildGoalsHandlers.js';
import { PoBLuaTcpClient } from '../../src/pobLuaBridge.js';

const hash = (data: string | Buffer) => createHash('sha256').update(data).digest('hex');
const savedGame = process.env.POE_GAME;
afterEach(() => { if (savedGame === undefined) delete process.env.POE_GAME; else process.env.POE_GAME = savedGame; });
const snapshot = process.env.POE2_QUICK_SNAPSHOT;
const local = snapshot && process.env.POB_INSTALL_DIR ? describe : describe.skip;

// Opt-in private source evidence: read only, never write/copy XML into fixtures.
local('private snapshot quick-scan evidence', () => {
  it('validates saved native outputs and selected XML without UI placeholder warnings', async () => {
    process.env.POE_GAME = 'poe2';
    const before = fs.readFileSync(snapshot!);
    const xml = before.toString('utf8');
    const build = new BuildService('').parseBuildContent(xml);
    const original = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '' }).parse(xml).PathOfBuilding2;
    const stats = Object.fromEntries(original.Build.PlayerStat.map((stat: any) => [stat.stat, stat.value]));
    const getItems = jest.fn<() => Promise<never>>().mockRejectedValue(new Error('UI placeholder slots must not be queried'));
    const client: any = { exportBuildXml: async () => xml,
      getStats: async (fields: string[]) => Object.fromEntries(fields.filter(key => key in stats).map(key => [key, stats[key]])), getItems };
    const result = await handleGetBuildIssues({ ensureLuaClient: async () => {}, getLuaClient: () => client });
    const text = formatIssuesResponse(result.issues, result.stats).content[0].text;
    const expected = new ValidationService().validateBuild(build, null, result.stats);
    for (const issue of [...expected.criticalIssues, ...expected.warnings]) {
      // Boolean assertions prevent private build text appearing in assertion logs.
      expect(result.issues.some(row => row.message === issue.description)).toBe(true);
    }
    expect(/PoE2 passive spending: weapon set 1 \d+ \/ \d+; weapon set 2 \d+ \/ \d+/.test(text)).toBe(true);
    expect(/Freeze protection is conditional/.test(text)).toBe(true);
    expect(/empty|unspent|suppression|wasted|4000\+|5000\+|\/5 flask/i.test(text)).toBe(false);
    for (const [field, label] of [['Life', 'Life'], ['EnergyShield', 'ES'], ['Mana', 'Mana'], ['Spirit', 'Spirit']]) {
      expect(result.stats[field]).toBe(Number(stats[field]));
      expect(text.includes(`${label}: `)).toBe(true);
    }
    if (!('Ward' in stats)) expect(text.includes('Ward: unknown')).toBe(true);
    expect(getItems).not.toHaveBeenCalled();
    expect(hash(fs.readFileSync(snapshot!))).toBe(hash(before));
  });
});

const port = process.env.POE2_QUICK_LIVE_PORT;
const live = port && process.env.POB_INSTALL_DIR ? describe : describe.skip;
live('read-only native quick-scan protocol evidence', () => {
  it('uses only export/stats reads and leaves the open build XML unchanged', async () => {
    process.env.POE_GAME = 'poe2';
    const client = new PoBLuaTcpClient({ host: process.env.POE2_QUICK_LIVE_HOST ?? '127.0.0.1', port: Number(port), timeoutMs: 10000 });
    try {
      await client.start();
      const before = await client.exportBuildXml();
      const actions: string[] = [];
      const send = (client as any).send.bind(client);
      jest.spyOn(client as any, 'send').mockImplementation(async (request: any) => {
        if (!['export_build_xml', 'get_stats'].includes(request.action)) throw new Error('Unexpected non-read action');
        actions.push(request.action);
        return send(request);
      });
      const result = await handleGetBuildIssues({ ensureLuaClient: async () => {}, getLuaClient: () => client });
      const after = await client.exportBuildXml();
      const text = formatIssuesResponse(result.issues, result.stats).content[0].text;
      expect(actions).toEqual(['export_build_xml', 'get_stats', 'export_build_xml']);
      expect(hash(after)).toBe(hash(before));
      expect(/empty|unspent|suppression|wasted|\/5 flask/i.test(text)).toBe(false);
      expect(/PoE2 passive spending:/.test(text)).toBe(true);
      for (const key of ['Life', 'EnergyShield', 'Mana', 'Spirit']) expect(typeof result.stats[key]).toBe('number');
      expect(text.includes('Overall viability')).toBe(true);
    } finally {
      await client.stop(); // TCP disconnect only; never sends quit to PoB.
      jest.restoreAllMocks();
    }
  }, 45000);
});
