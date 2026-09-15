import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import {
  classifyLeague,
  getDefaultLeague,
  getParentLeague,
  PERMANENT_LEAGUES,
  resolveLeague,
} from '../../src/services/leagueResolver';

describe('leagueResolver', () => {
  const originalEnv = process.env.POE_LEAGUE;
  const originalGame = process.env.POE_GAME;
  beforeEach(()=>{process.env.POE_GAME='poe1';});

  afterEach(() => {
    if(originalGame===undefined)delete process.env.POE_GAME;else process.env.POE_GAME=originalGame;
    if (originalEnv === undefined) delete process.env.POE_LEAGUE;
    else process.env.POE_LEAGUE = originalEnv;
  });

  describe('getDefaultLeague', () => {
    it('returns POE_LEAGUE env value when set', () => {
      process.env.POE_LEAGUE = 'Mirage';
      expect(getDefaultLeague()).toBe('Mirage');
    });

    it('trims whitespace from env value', () => {
      process.env.POE_LEAGUE = '  Mirage  ';
      expect(getDefaultLeague()).toBe('Mirage');
    });

    it('falls back to Standard when env is unset', () => {
      delete process.env.POE_LEAGUE;
      expect(getDefaultLeague()).toBe('Standard');
    });

    it('falls back to Standard when env is empty', () => {
      process.env.POE_LEAGUE = '';
      expect(getDefaultLeague()).toBe('Standard');
    });

    it('falls back to Standard when env is whitespace only', () => {
      process.env.POE_LEAGUE = '   ';
      expect(getDefaultLeague()).toBe('Standard');
    });
  });

  describe('resolveLeague', () => {
    beforeEach(() => {
      process.env.POE_LEAGUE = 'Mirage';
    });

    it('returns explicit value when provided', () => {
      expect(resolveLeague('Hardcore')).toBe('Hardcore');
    });

    it('falls back to env default when explicit is undefined', () => {
      expect(resolveLeague(undefined)).toBe('Mirage');
    });

    it('falls back to env default when explicit is empty', () => {
      expect(resolveLeague('')).toBe('Mirage');
    });

    it('falls back when explicit is null', () => {
      expect(resolveLeague(null)).toBe('Mirage');
    });

    it('trims whitespace from explicit value', () => {
      expect(resolveLeague('  Standard  ')).toBe('Standard');
    });
  });

  describe('getParentLeague', () => {
    it('returns Standard for softcore challenge leagues', () => {
      expect(getParentLeague('Mirage')).toBe('Standard');
      expect(getParentLeague('Settlers')).toBe('Standard');
      expect(getParentLeague('Keepers of the Flame')).toBe('Standard');
    });

    it('returns Hardcore for HC challenge leagues', () => {
      expect(getParentLeague('Hardcore Mirage')).toBe('Hardcore');
      expect(getParentLeague('Hardcore Settlers')).toBe('Hardcore');
    });

    it('returns SSF Standard for SSF challenge leagues', () => {
      expect(getParentLeague('SSF Mirage')).toBe('SSF Standard');
      expect(getParentLeague('Solo Self-Found SSF Mirage')).toBe('SSF Standard');
    });

    it('returns SSF Hardcore for HC+SSF challenge leagues', () => {
      expect(getParentLeague('Hardcore SSF Mirage')).toBe('SSF Hardcore');
    });

    it('returns Ruthless variants when ruthless flag is present', () => {
      expect(getParentLeague('Ruthless Mirage')).toBe('Ruthless');
      expect(getParentLeague('Hardcore Ruthless Mirage')).toBe('Hardcore Ruthless');
    });

    it('returns input unchanged for permanent leagues', () => {
      for (const perm of PERMANENT_LEAGUES) {
        expect(getParentLeague(perm)).toBe(perm);
      }
    });
  });

  describe('classifyLeague', () => {
    it('classifies a softcore challenge league', () => {
      const c = classifyLeague('Mirage');
      expect(c.name).toBe('Mirage');
      expect(c.isPermanent).toBe(false);
      expect(c.parent).toBe('Standard');
      expect(c.isHardcore).toBe(false);
      expect(c.isSsf).toBe(false);
      expect(c.isRuthless).toBe(false);
    });

    it('classifies a Hardcore SSF challenge league', () => {
      const c = classifyLeague('Hardcore SSF Mirage');
      expect(c.isPermanent).toBe(false);
      expect(c.parent).toBe('SSF Hardcore');
      expect(c.isHardcore).toBe(true);
      expect(c.isSsf).toBe(true);
    });

    it('classifies Standard as permanent', () => {
      const c = classifyLeague('Standard');
      expect(c.isPermanent).toBe(true);
      expect(c.parent).toBe('Standard');
    });
  });
});


describe('explicit PoE2 league selection',()=>{
  const game=process.env.POE_GAME,league=process.env.POE_LEAGUE;
  afterEach(()=>{if(game===undefined)delete process.env.POE_GAME;else process.env.POE_GAME=game;if(league===undefined)delete process.env.POE_LEAGUE;else process.env.POE_LEAGUE=league;});
  it('never silently chooses Standard without a league',()=>{process.env.POE_GAME='poe2';delete process.env.POE_LEAGUE;expect(()=>resolveLeague()).toThrow(/explicit PoE2 league/);});
  it('recognizes the actual HC prefix',()=>{expect(classifyLeague('HC Forbidden Rites').isHardcore).toBe(true);});
});
