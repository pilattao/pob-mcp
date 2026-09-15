import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { handleGetActiveLeagues } from '../../src/handlers/leagueStatusHandler';

function getText(result: { content: Array<{ type: string; text: string }> }): string {
  return result.content.map((c) => c.text).join('\n');
}

function makeFakeClient(leagueIds: string[]) {
  return {
    getLeagues: async () => ({
      result: leagueIds.map((id) => ({ id, realm: 'pc', text: id })),
    }),
  } as unknown as import('../../src/services/tradeClient').TradeApiClient;
}

describe('handleGetActiveLeagues', () => {
  const originalEnv = process.env.POE_LEAGUE;
  const originalGame = process.env.POE_GAME;
  beforeEach(() => { process.env.POE_GAME = 'poe1'; });

  afterEach(() => {
    if (originalGame === undefined) delete process.env.POE_GAME;
    else process.env.POE_GAME = originalGame;
    if (originalEnv === undefined) delete process.env.POE_LEAGUE;
    else process.env.POE_LEAGUE = originalEnv;
  });

  it('returns isError when trade client is null', async () => {
    const r = await handleGetActiveLeagues({ tradeClient: null });
    expect(r.isError).toBe(true);
    expect(getText(r)).toMatch(/Trade API is not enabled/);
  });

  it('reports the active league when POE_LEAGUE matches a real league', async () => {
    process.env.POE_LEAGUE = 'Mirage';
    const client = makeFakeClient(['Standard', 'Hardcore', 'Mirage', 'Hardcore Mirage']);
    const r = await handleGetActiveLeagues({ tradeClient: client });
    expect(r.isError).toBeUndefined();
    const text = getText(r);
    expect(text).toMatch(/POE_LEAGUE env var: Mirage/);
    expect(text).toMatch(/Active\./);
    expect(text).not.toMatch(/WARNING/);
    // Temp leagues should appear with parent mapping
    expect(text).toMatch(/Mirage.*→ ends to "Standard"/);
    expect(text).toMatch(/Hardcore Mirage.*→ ends to "Hardcore"/);
    // Permanent leagues section present
    expect(text).toMatch(/Permanent leagues/);
  });

  it('warns when POE_LEAGUE is stale (no longer in active list)', async () => {
    process.env.POE_LEAGUE = 'Mirage';
    // Mirage league has ended — no longer in the active list
    const client = makeFakeClient(['Standard', 'Hardcore', 'Settlers', 'Hardcore Settlers']);
    const r = await handleGetActiveLeagues({ tradeClient: client });
    const text = getText(r);
    expect(text).toMatch(/WARNING/);
    expect(text).toMatch(/league-transition\.md/);
  });

  it('falls back gracefully when POE_LEAGUE is unset', async () => {
    delete process.env.POE_LEAGUE;
    const client = makeFakeClient(['Standard', 'Hardcore']);
    const r = await handleGetActiveLeagues({ tradeClient: client });
    const text = getText(r);
    expect(text).toMatch(/unset, falls back to 'Standard'/);
  });

  it('reports trade API errors with the configured league context', async () => {
    process.env.POE_LEAGUE = 'Mirage';
    const failing = {
      getLeagues: async () => {
        throw new Error('network down');
      },
    } as unknown as import('../../src/services/tradeClient').TradeApiClient;
    const r = await handleGetActiveLeagues({ tradeClient: failing });
    expect(r.isError).toBe(true);
    const text = getText(r);
    expect(text).toMatch(/network down/);
    expect(text).toMatch(/Mirage/);
  });
});

describe('PoE2 league identity', () => {
  const originalGame = process.env.POE_GAME;
  const originalLeague = process.env.POE_LEAGUE;
  beforeEach(() => { process.env.POE_GAME = 'poe2'; });
  afterEach(() => {
    if (originalGame === undefined) delete process.env.POE_GAME; else process.env.POE_GAME = originalGame;
    if (originalLeague === undefined) delete process.env.POE_LEAGUE; else process.env.POE_LEAGUE = originalLeague;
  });
  it('lists concurrent leagues without selecting a default or inventing migration targets', async () => {
    delete process.env.POE_LEAGUE;
    const r = await handleGetActiveLeagues({tradeClient: makeFakeClient(['Forbidden Rites', 'Runes of Aldur', 'HC Forbidden Rites'])});
    const data = JSON.parse(getText(r));
    expect(data.configuredLeague).toBeNull();
    expect(data.configuredLeagueIsListed).toBeNull();
    expect(data.leagues.map((l: any) => l.id)).toEqual(['Forbidden Rites', 'Runes of Aldur', 'HC Forbidden Rites']);
    expect(data.migrationTargets).toContain('no destinations inferred');
  });
  it('reports an unlisted requested league instead of silently substituting another league', async () => {
    process.env.POE_LEAGUE = 'Missing league';
    const r = await handleGetActiveLeagues({tradeClient: makeFakeClient(['Forbidden Rites'])});
    const data = JSON.parse(getText(r));
    expect(data.configuredLeague).toBe('Missing league');
    expect(data.configuredLeagueIsListed).toBe(false);
  });
});
