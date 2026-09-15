import { existsSync, readFileSync, readdirSync, statSync } from 'fs';
import { dirname, join, resolve } from 'path';
import { spawn } from 'child_process';
import luaparse from 'luaparse';
import type { PoBBuild } from '../types.js';
import type { AnyLuaClient, NativeGemSpec, NativeGemEvaluationRequest, NativeGemEvaluation } from '../pobLuaBridge.js';
import { resolvePobDataLocation } from './pobDataPath.js';
import { analyzeSkillSetup, asArray, extractPoe2SkillSets, finiteNumber, xmlBoolean,
  type SkillGem, type SkillGroup, type SkillGroupAnalysis } from '../skillLinkOptimizer.js';

export interface GemData {
  gemId: string;
  gameId?: string;
  family?: string[];
  legacy?: boolean;
  isLineage?: boolean;
  name: string;
  skillId?: string;
  variantId?: string;
  support: boolean;
  tags: string[];
  description?: string;
  naturalMaxLevel?: number;
  maxLevel?: number;
  qualityLines?: string[];
  qualityStats?: Array<{ stat: string; perQuality: number; statSets: number[] }>;
  statSets?: Array<{ index: number; label?: string; id?: string }>;
  perLevel?: Array<{ level: number; levelRequirement?: number; reqStr?: number; reqDex?: number; reqInt?: number; statSets?: any[] }>;
  /** Native metadata, consumed only by PoB2's compatibility function. */
  effect?: Record<string, any>;
  source?: string;
}
export interface SupportCompatibility {
  gemId: string;
  compatible: boolean | null;
  scope: 'native-base-types' | 'unavailable';
  reason: string;
}
export interface GemDataProvider {
  catalog(): Promise<GemData[]>;
  compatibility(group: SkillGroup, candidates: GemData[]): Promise<SupportCompatibility[]>;
}
export interface GemReadOptions {
  client?: (Pick<AnyLuaClient, 'getGemDetail'> & Partial<Pick<AnyLuaClient, 'evaluateGemSetups'>>) | null;
  source?: 'live' | 'file';
  expectedBuildName?: string;
  expectedXml?: string;
  resourceOnly?: boolean;
  evaluationGroupIndex?: number;
  metric?: NativeGemEvaluationRequest['metric'];
  liveSkills?: any;
}
export interface GemAnalysis extends SkillGroupAnalysis {
  activeSkill?: SkillGem;
  notes: string[];
}
export interface GemSuggestion {
  gem: string;
  gemId: string;
  reasoning: string;
  compatibility: SupportCompatibility;
  /** Candidates are unranked; no DPS or price is inferred from a description. */
  requires: string[];
}
export interface GemComparison extends NativeGemEvaluation {
  resourceComparison?: NativeGemEvaluation;
}
export interface GemUpgrade {
  gem: string;
  groupIndex: number;
  gemIndex?: number;
  action: string;
  reason: string;
  requirements?: string;
}
const cap = (value: unknown): number | undefined => {
  const n = finiteNumber(value);
  return n !== undefined && Number.isInteger(n) && n > 0 ? n : undefined;
};
const normalize = (value: string) => value.trim().toLowerCase();

/** Read literal metadata from native tables. Functions and modifier expressions are never evaluated. */
function luaLiteral(node: any): any {
  if (!node) return undefined;
  if (node.type === 'StringLiteral') return Buffer.from(node.value, 'latin1').toString('utf8');
  if (['NumericLiteral', 'BooleanLiteral'].includes(node.type)) return node.value;
  if (node.type === 'UnaryExpression' && node.operator === '-') {
    const value = luaLiteral(node.argument); return typeof value === 'number' ? -value : undefined;
  }
  if (node.type === 'MemberExpression' && node.base?.name === 'SkillType') return node.identifier.name;
  if (node.type !== 'TableConstructorExpression') return undefined;
  const result: Record<string, any> = {};
  let index = 0;
  for (const field of node.fields) {
    const key = field.type === 'TableValue' ? ++index : field.type === 'TableKeyString' ? field.key.name : luaLiteral(field.key);
    const value = luaLiteral(field.value);
    if (key !== undefined && value !== undefined) result[key] = value;
  }
  return result;
}
const tableRows = (value: any): any[] => value ? Object.keys(value).filter(k => /^\d+$/.test(k)).sort((a, b) => +a - +b).map(k => value[k]) : [];
const ast = (file: string): any => luaparse.parse(readFileSync(file).toString('latin1'), { comments: false, encodingMode: 'pseudo-latin1' });

/** Executes only the installed native type-compatibility function in an isolated Lua runtime.
 * This is a base-type preflight, not a calculator or a reconstruction of the live activeSkill.
 */
const compatibilityScript = String.raw`
import json, sys
from pathlib import Path
from lupa import LuaRuntime
request = json.load(sys.stdin)
lua = LuaRuntime(unpack_returned_tuples=True)
lua.execute('SkillType = setmetatable({}, {__index=function(_, key) return key end})')
lua.execute(Path(sys.argv[1]).read_text())
def table(value):
    if isinstance(value, dict): return lua.table_from({int(k) if k.isdigit() else k:table(v) for k,v in value.items()})
    if isinstance(value, list): return lua.table_from([table(v) for v in value])
    return value
check = lua.eval('''function(effect, activeEffect, fromItem)
    local actor={enemy={}}; actor.enemy.player=actor
    local active={actor=actor,skillTypes=activeEffect.skillTypes or {},
      minionSkillTypes=activeEffect.minionSkillTypes,
      activeEffect={grantedEffect=activeEffect,gemData=not fromItem and {} or nil}}
    return calcLib.canGrantedEffectSupportActiveSkill(effect,active)
end''')
result=[]
for candidate in request['candidates']:
    outcomes=[]
    for active in request['active']:
        try: outcomes.append(bool(check(table(candidate['effect']),table(active['effect']),request['fromItem'])))
        except Exception: outcomes.append(None)
    result.append({'gemId':candidate['gemId'],'compatible':True if True in outcomes else None if None in outcomes or not outcomes else False})
print(json.dumps(result))
`;
function runCompatibility(file: string, request: object): Promise<Array<{ gemId: string; compatible: boolean | null }>> {
  const suiteRoots = [process.env.POE_MCP_SUITE_ROOT, process.cwd(), dirname(process.cwd()),
    process.argv[1] ? resolve(dirname(process.argv[1]), '../..') : undefined].filter((p): p is string => !!p);
  const python = suiteRoots.map(root => join(root, process.platform === 'win32' ? '.venv/Scripts/python.exe' : '.venv/bin/python')).find(existsSync);
  if (!python) return Promise.reject(new Error('Suite Python environment with lupa is unavailable'));
  return new Promise((resolveResult, reject) => {
    const child = spawn(python, ['-c', compatibilityScript, file], { stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '', error = '';
    const timer = setTimeout(() => { child.kill(); reject(new Error('Native compatibility preflight timed out')); }, 15000);
    child.stdout.on('data', chunk => { out += chunk; if (out.length > 2_000_000) child.kill(); });
    child.stderr.on('data', chunk => { error = (error + chunk).slice(-2000); });
    child.stdin.on('error', () => {});
    child.on('error', e => { clearTimeout(timer); reject(e); });
    child.on('close', code => {
      clearTimeout(timer);
      if (code !== 0) { reject(new Error(`Native compatibility preflight failed: ${error}`)); return; }
      try { resolveResult(JSON.parse(out)); } catch { reject(new Error('Invalid native compatibility response')); }
    });
    child.stdin.end(JSON.stringify(request));
  });
}

class InstalledPoe2GemData implements GemDataProvider {
  private cache?: { signature: string; gems: GemData[] };
  async catalog(): Promise<GemData[]> {
    const { dataDir, game } = resolvePobDataLocation();
    if (game !== 'poe2') throw new Error('Gem catalog requires verified PoB2 data');
    const gemFile = join(dataDir, 'Gems.lua');
    const skillDir = join(dataDir, 'Skills');
    const files = readdirSync(skillDir).filter(name => /^(act_|sup_|other\.lua)/.test(name) && name.endsWith('.lua')).sort().map(name => join(skillDir, name));
    const signature = [gemFile, ...files].map(file => `${file}:${statSync(file).mtimeMs}:${statSync(file).size}`).join('|');
    if (signature === this.cache?.signature) return this.cache.gems;
    const gemTable = luaLiteral(ast(gemFile).body.find((n: any) => n.type === 'ReturnStatement')?.arguments[0]);
    if (!gemTable) throw new Error('Installed PoB2 Gems.lua contains no gem table');
    const effects: Record<string, any> = {};
    for (const file of files) {
      const body = ast(file).body;
      // Releases populate the supplied table directly; newer source data returns
      // a factory. Read literal assignments from either form without executing it.
      const factory = body.find((node: any) => node.type === 'ReturnStatement')?.arguments?.[0];
      const statements = factory?.type === 'FunctionDeclaration' ? factory.body : body;
      for (const node of statements) {
        if (node.type !== 'AssignmentStatement') continue;
        node.variables.forEach((variable: any, i: number) => {
          if (variable.type === 'IndexExpression' && variable.base?.name === 'skills') {
            const id = luaLiteral(variable.index);
            if (typeof id === 'string') effects[id] = luaLiteral(node.init[i]);
          }
        });
      }
    }
    const gems: GemData[] = [];
    for (const [gemId, value] of Object.entries<any>(gemTable)) {
      const effect = effects[value.grantedEffectId];
      if (!effect?.statSets || !effect.levels) continue;
      const qualityStats = tableRows(effect.qualityStats).map(row => ({ stat: row[1], perQuality: row[2], statSets: tableRows(row[3]) }));
      const levels = Object.keys(effect.levels).map(Number).filter(n => Number.isInteger(n) && n > 0);
      gems.push({ gemId, gameId: value.gameId, family: tableRows(effect.gemFamily), legacy: effect.legacy === true, isLineage: effect.isLineage === true, name: value.name, skillId: value.grantedEffectId, variantId: value.variantId,
        support: effect.support === true, tags: Object.keys(value.tags ?? {}).filter(key => value.tags[key]),
        description: effect.description, naturalMaxLevel: cap(value.naturalMaxLevel), maxLevel: Math.max(...levels),
        qualityStats, qualityLines: qualityStats.filter(s => s.perQuality !== 0).map(s => `${s.stat}: ${s.perQuality * 20} at 20% quality (native stat ID; stat sets ${s.statSets.join(', ') || 'default'})`),
        statSets: tableRows(effect.statSets).map((set, i) => ({ index: i + 1, label: set.label, id: set.id })),
        perLevel: levels.map(level => ({ level, levelRequirement: effect.levels[level].levelRequirement })),
        effect: { skillTypes: effect.skillTypes, minionSkillTypes: effect.minionSkillTypes, cannotBeSupported: effect.cannotBeSupported,
          support: effect.support, supportGemsOnly: effect.supportGemsOnly, ignoreMinionTypes: effect.ignoreMinionTypes,
          isTrigger: effect.isTrigger, requireSkillTypes: effect.requireSkillTypes ?? {}, excludeSkillTypes: effect.excludeSkillTypes ?? {},
          addSkillTypes: effect.addSkillTypes ?? {} },
        source: `Installed PoB2 Data/Gems.lua and Data/Skills (${dataDir})`,
      });
    }
    this.cache = { signature, gems };
    return gems;
  }
  async compatibility(group: SkillGroup, candidates: GemData[]): Promise<SupportCompatibility[]> {
    const active = group.gems.filter(g => g.enabled !== false && g.isSupport === false).map(g => g.data).filter((d): d is GemData => !!d?.effect);
    if (!active.length || group.gems.some(g => !!g.skillMinion) || active.some(g => g.tags.some(tag => ['minion', 'meta'].includes(tag.toLowerCase())))) {
      return candidates.map(g => ({ gemId: g.gemId, compatible: null, scope: 'unavailable',
        reason: 'Requires the native runtime active skill, including triggered or minion skills' }));
    }
    const { dataDir, game } = resolvePobDataLocation();
    if (game !== 'poe2') throw new Error('Native compatibility requires PoB2');
    const checked = await runCompatibility(join(dirname(dataDir), 'Modules/CalcTools.lua'), {
      active, candidates: candidates.filter(g => g.effect), fromItem: !!group.source,
    });
    return candidates.map(g => {
      const compatible = checked.find(row => row.gemId === g.gemId)?.compatible ?? null;
      return { gemId: g.gemId, compatible, scope: compatible === null ? 'unavailable' : 'native-base-types',
        reason: compatible === null ? 'Native type check unavailable for this effect' : compatible
          ? 'Passes installed PoB2 base skill-type compatibility'
          : 'Does not support the base skill types in installed PoB2 data' };
    });
  }
}

export class SkillGemService {
  constructor(private readonly provider: GemDataProvider = new InstalledPoe2GemData()) {}

  private resolveGem(gem: SkillGem, catalog: GemData[]): GemData | undefined {
    // Stable IDs take precedence over a display name. Never silently resolve an ambiguous name.
    let matches = gem.gemId ? catalog.filter(d => d.gemId === gem.gemId) : [];
    if (!matches.length && gem.gemId) matches = catalog.filter(d => d.gameId === gem.gemId && (!gem.variantId || d.variantId === gem.variantId));
    if (!matches.length && gem.skillId) matches = catalog.filter(d => d.skillId === gem.skillId && (!gem.variantId || d.variantId === gem.variantId));
    if (!matches.length && !gem.gemId && !gem.skillId) matches = catalog.filter(d => normalize(d.name) === normalize(gem.name));
    return matches.length === 1 ? matches[0] : undefined;
  }
  async prepareBuild(build: PoBBuild, options: GemReadOptions = {}) {
    const model = extractPoe2SkillSets(build);
    const notes: string[] = [];
    let catalog: GemData[] = [];
    try { catalog = await this.provider.catalog(); } catch (error) {
      notes.push(`Installed gem catalog unavailable: ${error instanceof Error ? error.message : String(error)}`);
    }
    let groups = model.selected.groups;
    if (options.liveSkills) {
      const live = options.liveSkills;
      if (live.activeSkillSetId != null && String(live.activeSkillSetId) !== model.selected.id) throw new Error('Live skill set changed while reading evidence; retry');
      if (!Array.isArray(live.groups)) throw new Error('Native skill groups are missing');
      groups = live.groups.map((row: any): SkillGroup => {
        const saved = groups.find(g => g.index === row.index && !row.source);
        if (!row.source && (!saved || asArray<any>(row.gems).length !== saved.gems.length ||
          asArray<any>(row.gems).some((gem, index) => {
            const old = saved.gems[index];
            return old.skillId && gem.skillId ? old.skillId !== gem.skillId : old.gemId && gem.gemId ? old.gemId !== gem.gemId : old.name !== gem.name;
          }))) throw new Error('Live gem groups changed since the XML snapshot; retry the read');
        return { ...saved, index: row.index, skillSetId: model.selected.id, label: row.label,
          slot: row.slot, source: row.source, noSupports: xmlBoolean(row.noSupports, false),
          enabled: xmlBoolean(row.enabled), isMainSkill: row.index === live.mainSocketGroup,
          includeInFullDPS: xmlBoolean(row.includeInFullDPS, false), mainActiveSkill: row.mainActiveSkill,
          mainActiveSkillCalcs: saved?.mainActiveSkillCalcs,
          gems: asArray<any>(row.gems).map((gem, index) => ({
            ...saved?.gems[index], index: gem.index ?? index + 1, name: gem.name, gemId: gem.gemId,
            skillId: gem.skillId, level: finiteNumber(gem.level), quality: finiteNumber(gem.quality),
            enabled: xmlBoolean(gem.enabled), isSupport: typeof gem.is_support === 'boolean' ? gem.is_support : undefined,
            skillMinion: gem.skillMinion, statSet: gem.statSet ?? saved?.gems[index]?.statSet, error: gem.error,
          })),
        };
      });
    }
    const detailCache = new Map<string, GemData | undefined>();
    for (const group of groups) {
      for (const gem of group.gems) {
        let data = this.resolveGem(gem, catalog);
        const key = data?.gemId ?? gem.gemId ?? gem.skillId ?? gem.name;
        if (options.client) {
          if (!detailCache.has(key)) {
            try {
              const levels = data?.naturalMaxLevel ? [data.naturalMaxLevel] : undefined;
              const detail = await options.client.getGemDetail({ gemName: key, ...(levels ? {levels} : {}) });
              if (detail?.name && typeof detail.support === 'boolean') {
                // Keep native catalog stat-set identities and calculation levels; rendered API text wins.
                data = { ...data, ...detail, gemId: detail.gemId ?? key,
                  tags: [...new Set([...(data?.tags ?? []), ...(Array.isArray(detail.tags) ? detail.tags : typeof detail.tags === 'string' ? detail.tags.split(',') : [])].map((s: string) => s.trim().toLowerCase()))],
                  naturalMaxLevel: cap(detail.naturalMaxLevel) ?? data?.naturalMaxLevel, maxLevel: cap(detail.maxLevel) ?? data?.maxLevel,
                  statSets: data?.statSets ?? detail.perLevel?.[0]?.statSets,
                  perLevel: data?.perLevel ? data.perLevel.map(row => ({...row, ...detail.perLevel?.find((native: any) => native.level === row.level)})) : detail.perLevel,
                  source: 'PoB2 get_gem_detail' };
              }
            } catch (error) {
              if (!data) notes.push(`${gem.name}: get_gem_detail failed (${error instanceof Error ? error.message : String(error)})`);
            }
            detailCache.set(key, data);
          }
          data = detailCache.get(key);
        }
        gem.data = data;
        if ((gem.level !== undefined && (!Number.isInteger(gem.level) || gem.level < 1)) ||
          (gem.quality !== undefined && (!Number.isInteger(gem.quality) || gem.quality < 0))) gem.error = 'Invalid gem level or quality in the evidence';
        if (data) { gem.name = data.name; gem.isSupport = data.support; }
      }
    }
    return { ...model, groups, catalog, notes };
  }
  async analyzeBuild(build: PoBBuild, options: GemReadOptions = {}) {
    const model = await this.prepareBuild(build, options);
    for (const group of model.groups) {
      if (!group.enabled) continue;
      const supports = group.gems.filter(g => g.enabled !== false && g.isSupport && g.data).map(g => g.data!);
      if (supports.length) group.compatibility = await this.check(group, supports, model.groups);
    }
    return {...model, analysis: analyzeSkillSetup(model.groups)};
  }
  private at(groups: SkillGroup[], index?: number): SkillGroup {
    if (index === undefined) index = groups.findIndex(g => g.isMainSkill);
    if (!Number.isInteger(index) || index < 0 || index >= groups.length) throw new Error(`Skill index ${index} is invalid; selected set has ${groups.length} groups (zero based)`);
    return groups[index];
  }
  private async check(group: SkillGroup, candidates: GemData[], groups: SkillGroup[] = []) {
    if (group.noSupports) return candidates.map(d => ({gemId: d.gemId, compatible: false, scope: 'native-base-types' as const, reason: 'Source explicitly disallows supports'}));
    let target = group;
    if (!group.gems.some(g => g.enabled !== false && g.isSupport === false) && group.slot) {
      const sources = groups.filter(g => g.enabled && g.source && !g.noSupports && g.slot === group.slot &&
        g.gems.some(gem => gem.enabled !== false && gem.isSupport === false));
      if (sources.length) {
        target = {...group, source: sources.map(g => g.source).join(', '), gems: [...group.gems, ...sources.flatMap(g => g.gems.filter(gem => gem.isSupport === false))]};
        group.notes = [...group.notes ?? [], `Support targets: item-granted groups ${sources.map(g => g.index).join(', ')} in ${group.slot}.`];
      }
    }
    try { return await this.provider.compatibility(target, candidates); } catch (error) {
      return candidates.map(d => ({gemId: d.gemId, compatible: null, scope: 'unavailable' as const,
        reason: `Native compatibility unavailable: ${error instanceof Error ? error.message : String(error)}`}));
    }
  }
  async analyzeSkillLinks(build: PoBBuild, skillIndex: number | undefined = undefined, options: GemReadOptions = {}): Promise<GemAnalysis> {
    const model = await this.prepareBuild(build, options);
    const group = this.at(model.groups, skillIndex);
    const supports = group.gems.filter(g => g.enabled !== false && g.isSupport && g.data).map(g => g.data!);
    group.compatibility = await this.check(group, supports, model.groups);
    const analysis = analyzeSkillSetup([group]).groupAnalyses[0];
    return { ...analysis, activeSkill: analysis.activeSkills[group.mainActiveSkill ? group.mainActiveSkill - 1 : 0], notes: model.notes };
  }
  async suggestSupportGems(build: PoBBuild, skillIndex: number | undefined = undefined,
    options: GemReadOptions & {count?: number; includeExceptional?: boolean; budget?: string} = {}): Promise<GemSuggestion[]> {
    return (await this.supportCandidates(build, skillIndex, options)).suggestions;
  }
  async supportCandidates(build: PoBBuild, skillIndex: number | undefined = undefined,
    options: GemReadOptions & { count?: number; includeExceptional?: boolean; budget?: string } = {}) {
    const count = options.count ?? 5;
    if (!Number.isInteger(count) || count < 1 || count > 20) throw new Error('count must be an integer from 1 to 20');
    const model = await this.prepareBuild(build, options);
    const group = this.at(model.groups, skillIndex);
    if (!group.enabled || group.noSupports) return {suggestions: [] as GemSuggestion[], notes: [...model.notes, group.noSupports ? 'This group explicitly disallows supports.' : 'The selected group is disabled.'], checks: [] as SupportCompatibility[]};
    const equipped = new Set(group.gems.filter(g => g.enabled !== false).map(g => g.data?.skillId ?? g.gemId));
    const showLegacy = xmlBoolean((build.Skills as any)?.showLegacyGems, false);
    const supportTypes = (build.Skills as any)?.showSupportGemTypes ?? 'ALL';
    const candidates = model.catalog.filter(d => d.support && (showLegacy || !d.legacy) &&
      (supportTypes !== 'NORMAL' || !d.isLineage) && (supportTypes !== 'LINEAGE' || d.isLineage) &&
      !equipped.has(d.skillId ?? d.gemId)).sort((a, b) => a.name.localeCompare(b.name));
    const checks = await this.check(group, candidates, model.groups);
    const suggestions: GemSuggestion[] = candidates.filter(d => checks.find(c => c.gemId === d.gemId)?.compatible === true).slice(0, count).map(d => ({
      gem: d.name, gemId: d.gemId, compatibility: checks.find(c => c.gemId === d.gemId)!,
      reasoning: d.description ?? `Native tags: ${d.tags.join(', ')}`,
      requires: [...(group.gems.some(g => g.enabled !== false && g.data?.family?.some(f => d.family?.includes(f))) ? ['Replace a support from the same native gem family; their effects do not stack'] : []), 'Check the complete group in PoB2, including support interactions and resource requirements',
        'Verify available support capacity on this skill', 'Obtain a current price before applying a budget'],
    }));
    return {suggestions, notes: model.notes, checks};
  }
  private nativeContext(options: GemReadOptions) {
    if (options.source !== 'live' || !options.expectedBuildName || !options.expectedXml) {
      throw new Error('Numerical gem evaluation requires the current loaded matching build and a fresh XML snapshot; another build will not be replaced');
    }
    if (typeof options.client?.evaluateGemSetups !== 'function') throw new Error('Native gem evaluator is unavailable; deploy API/GemEvaluator.lua and the evaluate_gem_setups bridge action');
    return {client: options.client, expectedBuildName: options.expectedBuildName, expectedXml: options.expectedXml};
  }
  private async evaluateNative(model: Awaited<ReturnType<SkillGemService['prepareBuild']>>, index: number | undefined,
    options: GemReadOptions, request: Pick<NativeGemEvaluationRequest, 'setups' | 'search' | 'metric'> & {resourceOnly?: boolean}): Promise<NativeGemEvaluation> {
    const native = this.nativeContext(options);
    const group = this.at(model.groups, index);
    if (options.evaluationGroupIndex !== undefined && (!Number.isInteger(options.evaluationGroupIndex) || options.evaluationGroupIndex < 1)) throw new Error('Invalid evaluation skill index');
    const result = await native.client.evaluateGemSetups!({expectedBuildName: native.expectedBuildName, expectedXml: native.expectedXml,
      skillSetId: model.selected.id, groupIndex: group.index, evaluationGroupIndex: options.evaluationGroupIndex, metric: options.metric, ...request});
    if (!result?.rollback || !['xmlUnchanged', 'statsUnchanged', 'selectionsUnchanged', 'undoUnchanged'].every(k => (result.rollback as any)[k] === true)) {
      throw new Error('Native gem evaluation did not verify complete rollback; numerical results rejected');
    }
    if (request.resourceOnly && result.metric !== 'resource-only') throw new Error('Native evaluator does not support resource-only comparisons; deploy the API 1.4 gem evaluator');
    if (!Array.isArray(result.ranking) || !Array.isArray(result.setups) || (!request.resourceOnly && !Number.isFinite(result.baseline?.[result.metric]))) {
      throw new Error('Native gem evaluation returned an invalid baseline or ranking');
    }
    for (const row of result.ranking) {
      if (!row.valid || !Number.isFinite(row.output?.[result.metric])) throw new Error('Native gem ranking contains an invalid result');
    }
    return result;
  }
  async compareGemSetups(build: PoBBuild, skillIndex: number | undefined,
    setups: Array<{name: string; gems: Array<string | NativeGemSpec>}>, options: GemReadOptions = {}): Promise<GemComparison> {
    this.nativeContext(options);
    if (!Array.isArray(setups) || setups.length < 2 || setups.length > 10) throw new Error('Provide 2 to 10 setups for bounded comparison');
    const model = await this.prepareBuild(build, options);
    const current = this.at(model.groups, skillIndex);
    const normalized: NonNullable<NativeGemEvaluationRequest['setups']> = [];
    for (const setup of setups) {
      if (!setup.name?.trim() || !Array.isArray(setup.gems) || !setup.gems.length || setup.gems.length > 64) throw new Error('Each setup needs a name and 1 to 64 gem identifiers');
      const used = new Set<number>();
      const gems: NativeGemSpec[] = [];
      for (const input of setup.gems) {
        if (typeof input !== 'string') {
          if (!input || typeof input !== 'object') throw new Error('Invalid gem specification');
          gems.push(input); continue;
        }
        const name = input.trim();
        if (!name) throw new Error('Gem names must be nonempty');
        // Reference existing instances so counts, stat sets, weapon flags and item sources survive.
        const matches = current.gems.filter(g => !used.has(g.index!) &&
          (g.gemId === name || g.data?.gemId === name || g.data?.gameId === name || normalize(g.name) === normalize(name)));
        if (matches.length === 1) {
          used.add(matches[0].index!);gems.push({refIndex: matches[0].index});continue;
        }
        const catalogMatches = model.catalog.filter(d => d.gemId === name || d.gameId === name || normalize(d.name) === normalize(name));
        if (catalogMatches.length === 1) {gems.push({gemId: catalogMatches[0].gemId});continue;}
        const detail = await options.client!.getGemDetail({gemName: name});
        if (!detail?.gemId) throw new Error(`Gem identity unavailable or ambiguous in PoB2: ${name}`);
        gems.push({gemId: detail.gemId});
      }
      normalized.push({name: setup.name, gems});
    }
    const evaluateAll = async (evaluationOptions: GemReadOptions, resourceOnly = false): Promise<NativeGemEvaluation> => {
      let combined: NativeGemEvaluation | undefined;
      const stable = (value: any): any => Array.isArray(value) ? value.map(stable) : value && typeof value === 'object'
        ? Object.fromEntries(Object.keys(value).sort().map(key => [key, stable(value[key])])) : value;
      for (let offset = 0; offset < normalized.length;) {
        const requested = normalized.slice(offset);
        const batch = await this.evaluateNative(model, skillIndex, evaluationOptions, {setups: requested, ...(resourceOnly ? {resourceOnly: true} : {})});
        if (!batch.setups.length || batch.setups.length > requested.length ||
          batch.setups.some((row, index) => row.name !== requested[index].name)) throw new Error('Native gem comparison returned incomplete or mismatched setup identities');
        if (combined) {
          if (batch.metric !== combined.metric || JSON.stringify(stable(batch.baseline)) !== JSON.stringify(stable(combined.baseline)) ||
            JSON.stringify(stable(batch.conditions)) !== JSON.stringify(stable(combined.conditions))) throw new Error('Native baseline or conditions changed between comparison batches');
          combined.setups.push(...batch.setups);
          combined.search.evaluations += batch.search.evaluations;
        } else combined = {...batch, setups: [...batch.setups], search: {...batch.search}};
        offset += batch.setups.length;
        if (offset < normalized.length && !batch.search.truncated) throw new Error('Native gem comparison omitted requested setups');
      }
      combined!.ranking = resourceOnly ? [] : combined!.setups.filter(row => row.valid && Number.isFinite(row.output?.[combined!.metric]))
        .sort((a,b) => b.output![combined!.metric] - a.output![combined!.metric]);
      combined!.search.truncated = false;
      return combined!;
    };
    const result: GemComparison = await evaluateAll(options, options.resourceOnly === true);
    if (options.evaluationGroupIndex !== undefined && options.evaluationGroupIndex !== current.index &&
      current.gems.some(g => g.enabled !== false && g.isSupport === false)) {
      result.resourceComparison = await evaluateAll({...options, evaluationGroupIndex: current.index, metric: undefined}, true);
    }
    return result;
  }

  async rankSupportGems(build: PoBBuild, skillIndex: number | undefined, options: GemReadOptions & {count?: number} = {}) {
    this.nativeContext(options);
    const limit = options.count ?? 5;
    if (!Number.isInteger(limit) || limit < 1 || limit > 20) throw new Error('count must be an integer from 1 to 20');
    const model = await this.prepareBuild(build, options);
    return this.evaluateNative(model, skillIndex, options, {search: {mode: 'suggest', limit, maxEvaluations: 48}});
  }
  async findOptimalLinks(build: PoBBuild, skillIndex: number | undefined, targetGemCount: number,
    options: GemReadOptions & {optimizeFor?: 'dps' | 'clear_speed' | 'bossing' | 'defense'} = {}) {
    this.nativeContext(options);
    if (!Number.isInteger(targetGemCount) || targetGemCount < 1 || targetGemCount > 64) throw new Error('link_count must be 1 to 64 (analysis bound, not an equipment link limit)');
    const model = await this.prepareBuild(build, options);
    const metric = options.metric ?? (options.optimizeFor === 'defense' ? 'TotalEHP' : options.optimizeFor === 'clear_speed' ? 'Speed' : undefined);
    return this.evaluateNative(model, skillIndex, options, {metric, search: {mode: 'optimize', targetGemCount, limit: 5, maxEvaluations: 80}});
  }
  async validateGemQuality(build: PoBBuild, options: GemReadOptions & { includeCorrupted?: boolean } = {}) {
    const model = await this.prepareBuild(build, options);
    const needsQuality: Array<{gem: string; groupIndex: number; gemIndex?: number; current: number; recommended: number; impact: string; corrupted: boolean}> = [];
    for (const group of model.groups.filter(g => g.enabled && !g.source)) {
      for (const gem of group.gems.filter(g => !g.error && g.enabled !== false && (!g.corrupted || options.includeCorrupted))) {
        if (gem.quality !== undefined && gem.quality < 20 && gem.data?.qualityLines?.length) {
          needsQuality.push({gem: gem.name, groupIndex: group.index, gemIndex: gem.index, current: gem.quality,
            recommended: 20, impact: gem.data.qualityLines.join('; '), corrupted: !!gem.corrupted});
        }
      }
    }
    return { needsQuality, notes: model.notes, groups: model.groups };
  }
  async gemUpgradePath(build: PoBBuild, options: GemReadOptions = {}): Promise<GemUpgrade[]> {
    return (await this.gemUpgradePlan(build, options)).upgrades;
  }
  async gemUpgradePlan(build: PoBBuild, options: GemReadOptions = {}) {
    const model = await this.prepareBuild(build, options);
    const upgrades: GemUpgrade[] = [];
    for (const group of [...model.groups].sort((a,b) => Number(b.isMainSkill) - Number(a.isMainSkill))) {
      if (!group.enabled || group.source) continue;
      for (const gem of group.gems) {
        const d = gem.data;
        if (gem.error || gem.enabled === false || gem.corrupted || !d) continue;
        if (!d.support && gem.level !== undefined && d.naturalMaxLevel && gem.level < d.naturalMaxLevel) {
          const next = d.perLevel?.find(row => row.level === d.naturalMaxLevel);
          upgrades.push({gem: gem.name, groupIndex: group.index, gemIndex: gem.index,
            action: `Evaluate ${gem.name} at natural level ${d.naturalMaxLevel} (currently ${gem.level})`,
            reason: 'Natural gem cap from PoB2 data; calculation levels beyond this cap are not acquisition targets',
            requirements: next?.levelRequirement != null ? `Target requires character level ${next.levelRequirement}; also verify attributes and acquisition cost` : 'Verify character level, attributes and acquisition cost in PoB2'});
        }
        if (gem.quality !== undefined && gem.quality < 20 && d.qualityLines?.length) {
          upgrades.push({gem: gem.name, groupIndex: group.index, gemIndex: gem.index,
            action: `Evaluate quality ${gem.quality}% → 20%`, reason: d.qualityLines.join('; ')});
        }
      }
    }
    const unresolved = model.groups.flatMap(g => g.gems).filter(g => !g.data || g.error);
    return {upgrades, notes: [...model.notes, ...(unresolved.length ? [`Unresolved or invalid gem evidence: ${unresolved.map(g => g.name).join(', ')}`] : [])]};
  }
}
