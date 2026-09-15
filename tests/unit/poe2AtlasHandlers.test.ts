import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';
import { writeFileSync } from 'fs';
import { handleFindAtlasPathToNode, handleGetAtlasNode, handleSearchAtlasNodes } from '../../src/handlers/atlasTreeHandlers';
import { nativeAtlasEnvelope, useAtlasFixture } from './poe2AtlasFixtures';

let fixture: ReturnType<typeof useAtlasFixture>;
beforeEach(() => { fixture = useAtlasFixture(); });
afterEach(() => fixture.cleanup());
const text = (result: { content: Array<{ text: string }> }) => result.content.map(c => c.text).join('\n');

describe('PoE2 atlas tools', () => {
  it('returns a useful native detail response and machine-readable provenance', async () => {
    const result = await handleGetAtlasNode('692', 'default', true);
    expect(JSON.parse(text(result))).toMatchObject({ game: 'poe2', version: '4.5.5.2',
      provenance: { source: nativeAtlasEnvelope().source }, node: { name: 'Living Metal', subtree: 'Atlas' } });
    expect(text(await handleGetAtlasNode('692'))).toMatch(/PoE2.*4\.5\.5\.2/);
  });

  it('searches native display text case-insensitively and respects node type and limit', async () => {
    const result = text(await handleSearchAtlasNodes('STRONGBOX', 'notable', 1));
    expect(result).toContain('Living Metal');
    expect(result).not.toContain('**Strongbox Chance**');
    expect(result).toContain('4.5.5.2');
    expect(result).toContain('repoe-fork.github.io/poe2/');
    expect(text(await handleSearchAtlasNodes('Map Bosses'))).toContain('Hunt the Apex');
  });

  it('finds a reverse path using native numeric connections and reports distance rather than point cost', async () => {
    const result = text(await handleFindAtlasPathToNode('692', '12162'));
    expect(result).toContain('Graph distance: 2');
    expect(result).toMatch(/12162[\s\S]*9980[\s\S]*692/);
    expect(result).not.toContain('Total cost:');
    expect(result).toMatch(/quest|unlock/i);
  });

  it('keeps the main atlas and Ritual subtree disconnected', async () => {
    const result = text(await handleFindAtlasPathToNode('31048', '25703'));
    expect(result).toMatch(/No path.*published graph/i);
    expect(result).not.toContain('Total cost:');
  });

  it('does not return icon-only decorations as searchable or routable passives', async () => {
    expect(text(await handleSearchAtlasNodes('AtlasGenericMastery28'))).toContain('Found 0');
    expect(await handleFindAtlasPathToNode('361', '692')).toMatchObject({ isError: true });
    expect(text(await handleGetAtlasNode('361'))).toMatch(/display.only/i);
  });

  it('does not use display-only nodes as bridges', async () => {
    const data = nativeAtlasEnvelope();
    data.data.groups[4].passives[0].connections = [692, 18887];
    data.data.groups[4].passives[0].splines = [0, 0];
    writeFileSync(fixture.path, JSON.stringify(data));
    expect(text(await handleFindAtlasPathToNode('31048', '692'))).toMatch(/No path.*published graph/i);
  });

  it('handles identical source/target with provenance and zero graph distance', async () => {
    const result = text(await handleFindAtlasPathToNode('692', '692'));
    expect(result).toContain('Graph distance: 0');
    expect(result).toContain('4.5.5.2');
  });

  it('exposes unresolved selector effects in node details', async () => {
    expect(text(await handleGetAtlasNode('182'))).toMatch(/selector|choice|option/i);
    const raw = JSON.parse(text(await handleGetAtlasNode('182', 'default', true)));
    expect(raw.node.statIds).toEqual({ dummy_display_expedition_explosive_bonus_selector: 1 });
  });

  it('returns explicit errors for bad sources, variants and path endpoints', async () => {
    expect(await handleFindAtlasPathToNode('692', 'missing')).toMatchObject({ isError: true });
    expect(await handleSearchAtlasNodes('Strongbox', undefined, 0)).toMatchObject({ isError: true });
    expect(await handleSearchAtlasNodes('Strongbox', 'made-up-type')).toMatchObject({ isError: true });
    for (const call of [() => handleGetAtlasNode('692', 'ruthless'),
      () => handleSearchAtlasNodes('Strongbox', undefined, 30, 'ruthless'),
      () => handleFindAtlasPathToNode('692', '9980', 'ruthless')]) {
      expect(await call()).toMatchObject({ isError: true });
    }
    writeFileSync(fixture.path, 'not JSON');
    for (const call of [() => handleGetAtlasNode('692'), () => handleSearchAtlasNodes('Strongbox'),
      () => handleFindAtlasPathToNode('692', '9980')]) expect(await call()).toMatchObject({ isError: true });
  });
});
