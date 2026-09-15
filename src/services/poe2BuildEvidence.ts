import type { BuildService } from './buildService.js';
import type { AnyLuaClient } from '../pobLuaBridge.js';
import type { PoBBuild } from '../types.js';
import { validationStat } from './passiveBudget.js';

export interface EvidenceContext {
  buildService: BuildService;
  getLuaClient?: () => AnyLuaClient | null;
  ensureLuaClient?: () => Promise<void>;
}
export interface PoE2BuildEvidence {
  build: PoBBuild;
  stats: Record<string, any>;
  source: 'file' | 'live';
  note: string;
}
function check(build: PoBBuild): void {
  if (build.__xmlRoot !== 'PathOfBuilding2') throw new Error('PoE2 analysis requires PathOfBuilding2 XML');
}
function fileStats(build: PoBBuild): Record<string, number> {
  const source = build.Build?.PlayerStat;
  const rows = Array.isArray(source) ? source : source ? [source] : [];
  return Object.fromEntries(rows.flatMap(row => {
    const value = validationStat(row, 'value');
    return value === null ? [] : [[row.stat, value]];
  }));
}
const derivedValidationFields = [
  'MissingFireResist','MissingColdResist','MissingLightningResist','MissingChaosResist',
  'ReqStr','ReqDex','ReqInt','LifeCost','ManaCost','LifeUnreserved','ManaUnreserved',
  'SpiritUnreserved','NetManaRegen','FreezeAvoidChance','BleedAvoidChance','PoisonAvoidChance',
  'LifeRegenRecovery','LifeLeechGainRate','EnergyShieldRegenRecovery','EnergyShieldLeechGainRate',
  'EnergyShieldRecharge','ManaRegenRecovery','DeflectChance','CharmLimit',
];
const identity = (name: string) => name.replace(/\\/g, '/').replace(/\.xml$/i, '').toLowerCase();

/** Read selected live state or one requested file; this function never opens/reloads/saves builds. */
export async function readPoe2BuildEvidence(context: EvidenceContext, buildName?: string): Promise<PoE2BuildEvidence> {
  let saved: PoBBuild | undefined;
  let missingFile: unknown;
  if (buildName) {
    try { saved = await context.buildService.readBuild(buildName); }
    catch (error) {
      if ((error as NodeJS.ErrnoException)?.code !== 'ENOENT') throw error;
      // Named unsaved PoB builds have no file. Native identity must still match.
      missingFile = error;
    }
  }
  if (saved) check(saved);
  try { await context.ensureLuaClient?.(); } catch (error) { if (!saved) throw error; }
  const client = context.getLuaClient?.();
  let info: any;
  if (client) {
    try { info = await client.getBuildInfo(); } catch { /* File evidence stays independent. */ }
  }
  const matches = !buildName || (typeof info?.name === 'string' && identity(info.name) === identity(buildName));
  if (client && info && matches) {
    try {
      const build = context.buildService.parseBuildContent(await client.exportBuildXml());
      check(build);
      const stats = { ...await client.getStats(), ...await client.getStats(derivedValidationFields) };
      const after = await client.getBuildInfo();
      if (after?.name !== info.name || after?.className !== info.className || after?.level !== info.level) {
        throw new Error('Active build changed while collecting evidence; retry the read');
      }
      return { build, stats, source: 'live', note: 'Source: current PoB2 XML and native calculated outputs, including unsaved selections.' };
    } catch (error) { if (!saved) throw error; }
  }
  if (!saved) throw missingFile ?? new Error('No current live PoB2 build could be read; open a build or provide build_name');
  return { build: saved, stats: fileStats(saved), source: 'file',
    note: matches ? 'Source: saved PoB2 XML. Current native state was unavailable; saved stats can be stale.'
      : 'Source: requested saved PoB2 XML. A different or unidentified live build is excluded.' };
}
