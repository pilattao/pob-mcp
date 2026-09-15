import { useLegacyCraftFixture } from '../fixtures/coreCraftLegacy';
let legacy: ReturnType<typeof useLegacyCraftFixture>;
beforeAll(() => { legacy = useLegacyCraftFixture(); });
afterAll(() => legacy.cleanup());
import { describe, it, expect, beforeAll, afterAll } from '@jest/globals';

import {
  ensureBasesLoaded,
  findBasesMatching,
  getBase,
  getBaseCount,
  getBasesByTag,
} from '../../src/services/pobBaseDataLoader';


describe('pobBaseDataLoader', () => {
  it('parses each selected equipment base file', () => {
    ensureBasesLoaded();
    expect(getBaseCount()).toBe(4);
  });

  it('returns Astral Plate with the expected tag chain', () => {
    const b = getBase('Astral Plate');
    expect(b).not.toBeNull();
    if (!b) return;
    expect(b.type).toBe('Body Armour');
    expect(b.subType).toBe('Armour');
    expect(b.tags).toContain('armour');
    expect(b.tags).toContain('body_armour');
    expect(b.tags).toContain('str_armour');
    expect(b.req.level).toBeDefined();
    expect(b.implicit).toMatch(/Elemental Resistances/);
  });

  it('is case-insensitive on lookup', () => {
    expect(getBase('astral plate')).not.toBeNull();
    expect(getBase('ASTRAL PLATE')).not.toBeNull();
    expect(getBase('Astral Plate')).not.toBeNull();
  });

  it('returns null for unknown bases', () => {
    expect(getBase('Not A Real Base Item Name')).toBeNull();
  });

  it('findBasesMatching surfaces partial matches', () => {
    const hits = findBasesMatching('hubris', 5);
    expect(hits.length).toBeGreaterThan(0);
    expect(hits.some((b) => b.name === 'Hubris Circlet')).toBe(true);
  });

  it('getBasesByTag returns every base sharing the tag', () => {
    const rings = getBasesByTag('ring');
    expect(rings.map(b => b.name)).toEqual(['Sapphire Ring', 'Ruby Ring']);
    expect(rings.every((b) => b.type === 'Ring')).toBe(true);
  });
});
