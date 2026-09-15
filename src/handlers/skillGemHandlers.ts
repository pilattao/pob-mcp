import type { BuildService } from '../services/buildService.js';
import { SkillGemService, type GemReadOptions } from '../services/skillGemService.js';
import type { AnyLuaClient, NativeGemEvaluation, NativeGemSpec, NativeGemEvaluationRequest } from '../pobLuaBridge.js';
import { readPoe2BuildEvidence } from '../services/poe2BuildEvidence.js';
import { analyzeSkillSetup, formatSkillOptimization } from '../skillLinkOptimizer.js';
import { wrapHandler } from '../utils/errorHandling.js';

export interface SkillGemHandlerContext {
  buildService: BuildService;
  skillGemService: SkillGemService;
  pobDirectory?: string;
  getLuaClient?: () => AnyLuaClient | null;
  ensureLuaClient?: () => Promise<void>;
}
const response = (lines: string[]) => ({ content: [{type: 'text' as const, text: lines.join('\n')}] });
async function evidence(context: SkillGemHandlerContext, buildName?: string) {
  const snapshot = await readPoe2BuildEvidence(context, buildName);
  const client = context.getLuaClient?.();
  const options: GemReadOptions = {client, source: snapshot.source};
  if (snapshot.source === 'live' && client) {
    // The native transaction checks these exact bytes before editing its working state.
    const info = await client.getBuildInfo();
    const identity = (s: string) => s.replace(/\\/g, '/').replace(/\.xml$/i, '').toLowerCase();
    if (buildName && identity(info.name ?? '') !== identity(buildName)) throw new Error('Loaded build changed while collecting gem evidence; retry');
    const expectedXml = await client.exportBuildXml();
    options.expectedBuildName = info.name;
    options.expectedXml = expectedXml;
    options.liveSkills = await client.getSkills();
    return {...snapshot, build: context.buildService.parseBuildContent(expectedXml), options};
  }
  return {...snapshot, options};
}
const comparisonLimit = 'This structural analysis uses base-type compatibility. Use compare_gem_setups or find_optimal_links for native runtime calculations and verified rollback.';

export async function handleAnalyzeSkillLinks(context: SkillGemHandlerContext, args?: {build_name?: string; skill_index?: number}) {
  return wrapHandler('analyze skill links', async () => {
    const e = await evidence(context, args?.build_name);
    const a = await context.skillGemService.analyzeSkillLinks(e.build, args?.skill_index, e.options);
    return response([e.note, ...a.notes, formatSkillOptimization(analyzeSkillSetup([a.group])), comparisonLimit]);
  });
}
function formatNative(result: NativeGemEvaluation, showAll = false): string[] {
  const rows = showAll ? result.setups : result.ranking;
  const format = (n: number) => n.toLocaleString('en-US', {maximumFractionDigits: 4});
  const signed = (n: number) => `${n >= 0 ? '+' : ''}${format(n)}`;
  const lines = [`Native ranking metric: ${result.metric}`, `Native baseline: ${JSON.stringify(result.baseline)}`,
    `Applied conditions: ${JSON.stringify(result.conditions)}`,
    `Search: ${result.search.algorithm}; ${result.search.evaluations} evaluations; ${result.search.eligibleCandidates} eligible support candidates.`,
    'Ranking covers evaluated setups under these conditions. It does not establish a global optimum or market prices.'];
  if (result.search.truncated) lines.push('Search bound reached; some candidates or combinations remain unevaluated.');
  for (const [index, row] of rows.entries()) {
    lines.push('', `${index + 1}. ${row.name}${row.valid ? '' : ' [not eligible for ranking]'}`);
    if (row.error) {lines.push(`Native evaluation error: ${row.error}`);continue;}
    lines.push(`Gems: ${(row.gems ?? []).map(g => `${g.name} (${g.level}/${g.quality}, count ${g.count ?? 1})`).join(', ')}`);
    for (const [field, value] of Object.entries(row.output ?? {})) {
      const delta = row.deltas?.[field];
      lines.push(`${field}: ${format(value)}${delta ? `; delta ${signed(delta.absolute)}${delta.percent !== undefined ? ` (${signed(delta.percent)}%)` : ''}` : ''}`);
    }
    for (const support of row.supports ?? []) lines.push(`Support ${support.name}: ${support.status}${support.description ? ` — ${support.description}` : ''}`);
    lines.push(...(row.warnings ?? []).map(w => `Condition: ${w}`));
  }
  if (!result.ranking.length) lines.push('No valid complete setup qualified for ranking within this search.');
  if (!showAll) {
    const failed = result.setups.filter(row => !row.valid);
    if (failed.length) lines.push(`${failed.length} trials excluded because of native compatibility, requirements, or calculation errors.`,
      ...failed.slice(0, 3).map(row => `${row.name}: ${row.error ?? [...(row.warnings ?? []), ...(row.supports ?? []).filter(s => !['applied','disabled'].includes(s.status)).map(s => `${s.name}: ${s.status}`)].join('; ')}`));
  }
  lines.push('Verified rollback: original XML, native stats, selections, and undo history restored.');
  return lines;
}
export async function handleSuggestSupportGems(context: SkillGemHandlerContext, args?: {
  build_name?: string; skill_index?: number; count?: number; include_exceptional?: boolean;
  budget?: 'league_start' | 'mid_league' | 'endgame';
}) {
  return wrapHandler('suggest support gems', async () => {
    const e = await evidence(context, args?.build_name);
    const result = await context.skillGemService.rankSupportGems(e.build, args?.skill_index, {...e.options, count: args?.count});
    const lines = [e.note, '=== Native PoE2 Support Ranking ===', ...formatNative(result)];
    if (args?.budget) lines.push(`Budget tier: ${args.budget}. Native costs above are skill resource costs; current trade prices are needed for affordability.`);
    return response(lines);
  });
}
export async function handleCompareGemSetups(context: SkillGemHandlerContext, args: {
  build_name?: string; skill_index?: number; evaluation_skill_index?: number; metric?: NativeGemEvaluationRequest['metric']; setups: Array<{name: string; gems: Array<string | NativeGemSpec>}>;
}) {
  return wrapHandler('compare gem setups', async () => {
    const e = await evidence(context, args.build_name);
    const result = await context.skillGemService.compareGemSetups(e.build, args.skill_index, args.setups, {...e.options, metric: args.metric,
      evaluationGroupIndex: args.evaluation_skill_index === undefined ? undefined : args.evaluation_skill_index + 1});
    return response([e.note, '=== Native PoE2 Gem Setup Comparison ===', ...formatNative(result, true),
      `Ranking: ${result.ranking.map(row => row.name).join(' > ') || 'no qualifying setup'}`]);
  });
}
export async function handleValidateGemQuality(context: SkillGemHandlerContext, args?: {build_name?: string; include_corrupted?: boolean}) {
  return wrapHandler('validate gem quality', async () => {
    const e = await evidence(context, args?.build_name);
    const result = await context.skillGemService.validateGemQuality(e.build, {...e.options, includeCorrupted: args?.include_corrupted});
    const lines = [e.note, '=== PoE2 Gem Quality ===', ...result.notes];
    for (const gem of result.needsQuality) lines.push(`Group ${gem.groupIndex}, gem ${gem.gemIndex}: ${gem.gem}, ${gem.current}% → ${gem.recommended}%`,
      `Native quality effect at 20%: ${gem.impact}`,
      gem.corrupted ? 'Corrupted: inspect an obtainable replacement; this is not a recommendation to quality the existing gem.' : 'Check the acquisition cost before applying quality.');
    if (!result.needsQuality.length) lines.push('No quality changes identified for enabled, eligible gems with verified native quality effects.');
    const unresolved = result.groups.flatMap(g => g.gems).filter(g => !g.data);
    if (unresolved.length) lines.push(`Unresolved gem metadata: ${unresolved.map(g => g.name).join(', ')}`);
    return response(lines);
  });
}
export async function handleFindOptimalLinks(context: SkillGemHandlerContext, args: {
  build_name?: string; skill_index?: number; link_count: number;
  budget?: 'league_start' | 'mid_league' | 'endgame'; optimize_for?: 'dps' | 'clear_speed' | 'bossing' | 'defense';
}) {
  return wrapHandler('find optimal links', async () => {
    const e = await evidence(context, args.build_name);
    const result = await context.skillGemService.findOptimalLinks(e.build, args.skill_index, args.link_count, {...e.options, optimizeFor: args.optimize_for});
    const lines = [e.note, `=== Native PoE2 Setup Search: ${args.link_count} Total Gems ===`, ...formatNative(result),
      'Available support capacity must still be verified on the skill; gem count is not an equipment link count.'];
    if (args.optimize_for === 'clear_speed') lines.push('Speed is the native action-rate metric; it does not measure time to clear a map.');
    if (args.optimize_for === 'bossing') lines.push('Bossing uses the current enemy configuration shown above; no boss assumptions were changed.');
    if (args.budget) lines.push(`Budget ${args.budget}: native resource costs are shown; current market quotes are required to filter purchases.`);
    return response(lines);
  });
}
export async function handleGemUpgradePath(context: SkillGemHandlerContext, args: {build_name?: string; budget?: string}) {
  return wrapHandler('gem upgrade path', async () => {
    const e = await evidence(context, args.build_name);
    const result = await context.skillGemService.gemUpgradePlan(e.build, e.options);
    const upgrades = result.upgrades;
    const lines = [e.note, ...result.notes, '=== PoE2 Gem Upgrade Path ===', 'Main-group opportunities are listed first; priorities are not DPS rankings.'];
    for (const u of upgrades) lines.push('', `Group ${u.groupIndex}, gem ${u.gemIndex}: ${u.gem}`, u.action, u.reason, ...(u.requirements ? [u.requirements] : []));
    if (!upgrades.length) lines.push('No upgrades identified for enabled, uncorrupted gems with verified native metadata.');
    if (args.budget) lines.push(`Budget request: ${args.budget}. Current prices are needed for cost-based ordering.`);
    return response(lines);
  });
}
/** Shared entry for the advanced handler; it never loads or mutates the live build. */
export async function analyzePoe2SkillGroupsForBuild(context: Omit<SkillGemHandlerContext, 'skillGemService'>, buildName?: string) {
  const c: SkillGemHandlerContext = {...context, skillGemService: new SkillGemService()};
  const e = await evidence(c, buildName);
  const model = await c.skillGemService.analyzeBuild(e.build, e.options);
  return response([e.note, `Selected skill set: ${model.selected.id}${model.selected.title ? ` (${model.selected.title})` : ''}; ${model.sets.length} independent sets in the XML`,
    ...model.notes, formatSkillOptimization(model.analysis), comparisonLimit]);
}
