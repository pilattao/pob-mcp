/** PoE2 leveling plans from selected, read-only build evidence and installed definitions. */
import type { AnyLuaClient } from '../pobLuaBridge.js';
import { BuildService } from '../services/buildService.js';
import { readPoe2BuildEvidence } from '../services/poe2BuildEvidence.js';
import { createPoe2LevelingPlan, formatPoe2LevelingPlan, type LevelingArgs, type LevelingEvidence } from '../services/poe2LevelingService.js';
import { wrapHandler } from '../utils/errorHandling.js';

export interface LevelingContext {
  buildService?: BuildService;
  pobDirectory?: string;
  getLuaClient: () => AnyLuaClient | null;
  ensureLuaClient: () => Promise<void>;
}
export async function handlePlanLeveling(context: LevelingContext, args: LevelingArgs = {}) {
  return wrapHandler('plan leveling', async () => {
    if (args.build_name && !context.buildService && !context.pobDirectory) throw new Error('Named leveling builds require buildService or pobDirectory in the handler context');
    const buildService=context.buildService ?? new BuildService(context.pobDirectory ?? '');
    let evidence: LevelingEvidence;
    try { evidence=await readPoe2BuildEvidence({...context,buildService},args.build_name); }
    catch (error) {
      // Never hide a failed explicit file request or a failed live snapshot behind a generic template.
      if (args.build_name || context.getLuaClient() || !args.class_name || args.current_level === undefined) throw error;
      evidence={source:'arguments',stats:{},note:'Source: caller-supplied planning scenario. No character build was read.',
        build:{__xmlRoot:'PathOfBuilding2',Build:{className:args.class_name,level:String(args.current_level)},Skills:{}}};
    }
    if (evidence.source === 'live') {
      const client=context.getLuaClient();
      if (!client) throw new Error('Live client changed while reading leveling evidence');
      // Default get_stats is a summary and can omit the actual attributes. Guard
      // the additional read against the exact selected snapshot; never use file stats.
      const attributes=await client.getStats(['Str','Dex','Int']);
      const after=buildService.parseBuildContent(await client.exportBuildXml());
      if (JSON.stringify(after) !== JSON.stringify(evidence.build)) throw new Error('Active build changed while reading leveling attributes; retry the read');
      evidence={...evidence,stats:{...evidence.stats,...attributes}};
    }
    const plan=createPoe2LevelingPlan(evidence,args);
    return {content:[{type:'text' as const,text:formatPoe2LevelingPlan(plan)}],structuredContent:plan};
  });
}
