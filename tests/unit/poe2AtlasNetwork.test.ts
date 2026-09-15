import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { atlasIndex, atlasSource, nativeAtlasFixture, useAtlasFixture } from './poe2AtlasFixtures';

let fixture: ReturnType<typeof useAtlasFixture>;
beforeEach(() => {
  fixture = useAtlasFixture();
  delete process.env.ATLASTREE_DIRECTORY;
  delete process.env.POE2_ATLAS_FILE;
  jest.resetModules();
});
afterEach(() => { jest.restoreAllMocks(); fixture.cleanup(); });

function index(version = '4.5.5.2') {
  return new Response(`<title>RePoE - PoE2 version ${version}</title>`, { status: 200 });
}
function graph() { return new Response(JSON.stringify(nativeAtlasFixture()), { status: 200, headers: { 'last-modified': 'Fri, 11 Sep 2026 13:04:24 GMT' } }); }

describe('PoE2 atlas public-source loading', () => {
  it('fetches the real source shape once for concurrent callers, with explicit version and provenance', async () => {
    const fetchMock = jest.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(index()).mockResolvedValueOnce(graph()).mockResolvedValueOnce(index());
    const { getAtlasTreeData, getAtlasNode } = await import('../../src/services/atlasTreeDataLoader');
    const [first, second] = await Promise.all([getAtlasTreeData(), getAtlasTreeData()]);
    expect(first).toBe(second);
    expect(first.game).toBe('poe2');
    expect(first.version).toBe('4.5.5.2');
    expect(first.provenance).toMatchObject({ source: atlasSource, versionSource: atlasIndex, transport: 'https' });
    expect((await getAtlasNode('692'))?.name).toBe('Living Metal');
    expect(fetchMock.mock.calls.map(call => String(call[0]))).toEqual([atlasIndex, atlasSource, atlasIndex]);
  });

  it('rejects a PoE1 index without trying its graph or a local fallback', async () => {
    const fetchMock = jest.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('<title>RePoE - PoE1 version 3.29</title>'));
    const { getAtlasTreeData } = await import('../../src/services/atlasTreeDataLoader');
    await expect(getAtlasTreeData()).rejects.toThrow(/PoE2.*version/i);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('rejects an update occurring between version discovery and graph retrieval', async () => {
    jest.spyOn(globalThis, 'fetch').mockResolvedValueOnce(index()).mockResolvedValueOnce(graph()).mockResolvedValueOnce(index('4.5.6.0'));
    const { getAtlasTreeData } = await import('../../src/services/atlasTreeDataLoader');
    await expect(getAtlasTreeData()).rejects.toThrow(/changed|publication/i);
  });

  it('honors Retry-After and does not repeatedly hammer a failing provider', async () => {
    let now = Date.now();
    jest.spyOn(Date, 'now').mockImplementation(() => now);
    const fetchMock = jest.spyOn(globalThis, 'fetch').mockResolvedValueOnce(new Response('', { status: 429, headers: { 'retry-after': '120' } }));
    const { getAtlasTreeData } = await import('../../src/services/atlasTreeDataLoader');
    await expect(getAtlasTreeData()).rejects.toThrow(/429/);
    now += 119000;
    await expect(getAtlasTreeData()).rejects.toThrow(/429/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    now += 2000;
    fetchMock.mockResolvedValueOnce(index()).mockResolvedValueOnce(graph()).mockResolvedValueOnce(index());
    expect((await getAtlasTreeData()).nodes['692'].name).toBe('Living Metal');
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it('does not serve expired data as fresh when a refresh fails', async () => {
    let now = Date.now();
    jest.spyOn(Date, 'now').mockImplementation(() => now);
    const fetchMock = jest.spyOn(globalThis, 'fetch').mockResolvedValueOnce(index()).mockResolvedValueOnce(graph()).mockResolvedValueOnce(index());
    const { getAtlasTreeData } = await import('../../src/services/atlasTreeDataLoader');
    expect((await getAtlasTreeData()).nodes['692'].name).toBe('Living Metal');
    now += 3600001;
    fetchMock.mockResolvedValueOnce(new Response('', { status: 503 }));
    await expect(getAtlasTreeData()).rejects.toThrow(/503/);
  });

  it('fails a configured missing file without making any network request', async () => {
    process.env.POE2_ATLAS_FILE = fixture.path + '.missing';
    const fetchMock = jest.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('unexpected network request'));
    const { getAtlasTreeData } = await import('../../src/services/atlasTreeDataLoader');
    await expect(getAtlasTreeData()).rejects.toThrow(/PoE2|ENOENT/);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
