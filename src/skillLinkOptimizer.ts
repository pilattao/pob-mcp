/** PoE2 skill groups are independent of equipment socket colours and links. */
import type { PoBBuild } from './types.js';
import type { GemData, SupportCompatibility } from './services/skillGemService.js';

export interface SkillGem {
  index?: number;
  name: string;
  gemId?: string;
  skillId?: string;
  variantId?: string;
  level?: number;
  quality?: number;
  enabled?: boolean;
  corrupted?: boolean;
  isSupport?: boolean;
  statSet?: Record<string, number>;
  statSetCalcs?: Record<string, number>;
  skillPart?: number;
  skillPartCalcs?: number;
  skillMinion?: string;
  count?: number;
  enableGlobal1?: boolean;
  enableGlobal2?: boolean;
  data?: GemData;
  error?: string;
}
export interface SkillGroup {
  /** Native PoB group number. Public skill_index remains zero based. */
  index: number;
  skillSetId?: string;
  label?: string;
  slot?: string;
  source?: string;
  noSupports?: boolean;
  enabled: boolean;
  isMainSkill: boolean;
  mainActiveSkill?: number;
  mainActiveSkillCalcs?: number;
  gems: SkillGem[];
  includeInFullDPS?: boolean;
  compatibility?: SupportCompatibility[];
  notes?: string[];
}
export interface PoE2SkillSet { id: string; title?: string; groups: SkillGroup[] }
export interface SkillLinkIssue {
  type: 'empty_group' | 'unresolved_gem' | 'low_level' | 'no_quality' | 'wrong_support' | 'duplicate_support' | 'selection';
  severity: 'high' | 'medium' | 'low';
  message: string;
  suggestion: string;
}
export interface SkillGroupAnalysis {
  group: SkillGroup;
  isValid: boolean | null;
  linkCount: number;
  activeSkills: SkillGem[];
  supports: SkillGem[];
  issues: SkillLinkIssue[];
  suggestions: string[];
}
export interface SkillOptimizationResult {
  summary: string;
  buildType: string;
  groupAnalyses: SkillGroupAnalysis[];
  generalSuggestions: string[];
}
export const asArray = <T>(value: T | T[] | undefined | null): T[] => value == null ? [] : Array.isArray(value) ? value : [value];
export const xmlBoolean = (value: unknown, fallback = true): boolean => value == null ? fallback : value === true || value === 'true';
export function finiteNumber(value: unknown): number | undefined {
  if (value == null || value === '' || typeof value === 'boolean') return undefined;
  const n = Number(value);
  return Number.isFinite(n) ? n : undefined;
}
const selection = (value: unknown): number | undefined => {
  const n = finiteNumber(value);
  return n !== undefined && Number.isInteger(n) && n >= 1 ? n : undefined;
};
function statSelections(gem: any, field: string, legacy: string): Record<string, number> {
  const result: Record<string, number> = {};
  const old = selection(gem[legacy]);
  if (old) result.index = old;
  for (const row of asArray<any>(gem[field])) {
    const value = selection(row.index);
    if (typeof row.grantedEffect === 'string' && value) result[row.grantedEffect] = value;
  }
  return result;
}
/** Preserve all sets and group positions; never concatenate alternate setups. */
export function extractPoe2SkillSets(build: PoBBuild): { sets: PoE2SkillSet[]; selected: PoE2SkillSet } {
  if (build.__xmlRoot !== 'PathOfBuilding2') throw new Error('PoE2 skill analysis requires PathOfBuilding2 XML');
  const skills: any = build.Skills ?? {};
  let source = asArray<any>(skills.SkillSet);
  if (!source.length) source = [{ id: skills.activeSkillSet ?? '1', Skill: skills.Skill }];
  const sets = source.map((set, i): PoE2SkillSet => ({
    id: String(set.id ?? i + 1), title: set.title,
    groups: asArray<any>(set.Skill).map((group, index) => ({
      index: index + 1, skillSetId: String(set.id ?? i + 1), label: group.label, slot: group.slot,
      source: group.source, noSupports: xmlBoolean(group.noSupports, false),
      enabled: xmlBoolean(group.enabled), includeInFullDPS: xmlBoolean(group.includeInFullDPS, false),
      isMainSkill: index + 1 === selection((build.Build as any)?.mainSocketGroup),
      mainActiveSkill: selection(group.mainActiveSkill) ?? 1,
      mainActiveSkillCalcs: selection(group.mainActiveSkillCalcs) ?? 1,
      gems: asArray<any>(group.Gem).map((gem, gemIndex) => ({
        index: gemIndex + 1, name: gem.nameSpec || gem.name || gem.gemId || gem.skillId || '(unresolved gem)',
        gemId: gem.gemId, skillId: gem.skillId, variantId: gem.variantId,
        level: finiteNumber(gem.level), quality: finiteNumber(gem.quality), count: finiteNumber(gem.count),
        enabled: xmlBoolean(gem.enabled), corrupted: xmlBoolean(gem.corrupted, false),
        enableGlobal1: xmlBoolean(gem.enableGlobal1), enableGlobal2: xmlBoolean(gem.enableGlobal2, false),
        statSet: statSelections(gem, 'StatSetIndex', 'statSetIndex'),
        statSetCalcs: statSelections(gem, 'StatSetCalcsIndex', 'statSetIndexCalcs'),
        skillPart: selection(gem.skillPart), skillPartCalcs: selection(gem.skillPartCalcs),
        skillMinion: gem.skillMinion,
      })),
    })),
  }));
  if (new Set(sets.map(set => set.id)).size !== sets.length) throw new Error('Duplicate PoE2 skill set IDs');
  const selectedId = skills.activeSkillSet != null ? String(skills.activeSkillSet) : sets.length === 1 ? sets[0].id : undefined;
  const selected = sets.find(set => set.id === selectedId);
  if (!selected) throw new Error(`Selected PoE2 skill set ${selectedId ?? '(missing)'} not found; select an explicit skill set`);
  return { sets, selected };
}

export function analyzeSkillSetup(groups: SkillGroup[], buildArchetype = 'PoE2'): SkillOptimizationResult {
  const groupAnalyses = groups.map((group): SkillGroupAnalysis => {
    const activeSkills = group.gems.filter(g => g.isSupport === false);
    const supports = group.gems.filter(g => g.isSupport === true);
    const issues: SkillLinkIssue[] = [];
    const suggestions: string[] = [];
    const add = (type: SkillLinkIssue['type'], message: string, suggestion: string, severity: SkillLinkIssue['severity'] = 'low') =>
      issues.push({ type, message, suggestion, severity });
    if (group.enabled && !group.gems.length && !group.source) add('empty_group', 'Enabled group is empty', 'Add the intended active skill or disable this group');
    if (group.enabled) {
      for (const gem of group.gems.filter(g => g.enabled !== false)) {
        if (gem.error) add('unresolved_gem', `${gem.name}: ${gem.error}`, 'Resolve this gem in PoB2 before comparing setups', 'medium');
        else if (!gem.data) add('unresolved_gem', `${gem.name}: native gem metadata unavailable`, 'Resolve the exact gem ID with get_gem_detail', 'medium');
        const data = gem.data;
        if (!data || gem.error || group.source || gem.corrupted) continue;
        if (gem.isSupport === false && data.naturalMaxLevel && gem.level !== undefined && gem.level < data.naturalMaxLevel) {
          add('low_level', `${gem.name}: level ${gem.level}, natural cap ${data.naturalMaxLevel}`,
            `Consider a higher-level ${gem.name}; verify character and attribute requirements before replacing it`);
        }
        if (gem.quality !== undefined && gem.quality < 20 && data.qualityLines?.length) {
          add('no_quality', `${gem.name}: ${gem.quality}% quality`, `Review quality to 20: ${data.qualityLines.join('; ')}`);
        }
      }
      const seen = new Set<string>();
      const families = new Set<string>();
      for (const gem of supports.filter(g => g.enabled !== false)) {
        const key = gem.data?.skillId ?? gem.gemId;
        if (key && seen.has(key)) add('duplicate_support', `Repeated support effect: ${gem.name}`, 'Review the duplicate within this group in native PoB2', 'medium');
        if (key) seen.add(key);
        for (const family of gem.data?.family ?? []) {
          if (families.has(family)) add('duplicate_support', `${gem.name}: repeated native support family ${family}`, 'Replace one of these supports; PoB2 applies only one support from the family', 'medium');
          families.add(family);
        }
        if (group.noSupports) add('wrong_support', `${gem.name}: this source does not accept supports`, 'Remove the support from this group', 'high');
        const check = group.compatibility?.find(c => c.gemId === (gem.data?.gemId ?? gem.gemId));
        if (check?.compatible === false) {
          // A base-type rejection is not proof of a rejection after another support transforms the skill.
          suggestions.push(`${gem.name}: ${check.reason}. Verify the complete group in PoB2 before removing it.`);
        }
      }
    }
    if (!group.enabled) suggestions.push('Group is disabled; excluded from upgrade recommendations.');
    if (group.source) suggestions.push(`Granted by ${group.source}; edit its source or a matching support group.`);
    suggestions.push(...group.notes ?? []);
    const unresolved = group.gems.some(g => g.isSupport === undefined || g.error);
    return { group, activeSkills, supports, linkCount: group.gems.length,
      isValid: issues.some(i => i.severity === 'high') ? false : unresolved || supports.length > 0 ? null : true, issues, suggestions };
  });
  return { summary: `Analyzed ${groups.length} PoE2 skill groups; ${groupAnalyses.reduce((n, g) => n + g.issues.length, 0)} findings`,
    buildType: buildArchetype, groupAnalyses,
    generalSuggestions: groups.length && !groups.some(g => g.isMainSkill) ? ['No main group is selected in the evidence.'] : [] };
}
export function formatSkillOptimization(result: SkillOptimizationResult): string {
  const lines = ['=== PoE2 Skill Group Analysis ===', result.summary, ...result.generalSuggestions];
  for (const analysis of result.groupAnalyses) {
    const g = analysis.group;
    lines.push('', `Group ${g.index}${g.isMainSkill ? ' (MAIN)' : ''}${g.label ? `: ${g.label}` : ''} [${g.enabled ? 'enabled' : 'disabled'}]`,
      `Skill set: ${g.skillSetId ?? 'current'}; ${analysis.activeSkills.length} active skills, ${analysis.supports.length} supports`,
      `Main active selection: ${g.mainActiveSkill ?? 'unknown'}; calculation selection: ${g.mainActiveSkillCalcs ?? 'unknown'}`);
    for (const gem of g.gems) {
      lines.push(`- ${gem.name}${gem.enabled === false ? ' [disabled]' : ''}: level ${gem.level ?? 'unknown'}, quality ${gem.quality ?? 'unknown'}%; ${gem.isSupport === true ? 'support' : gem.isSupport === false ? 'active' : 'unresolved'}`,
        `  Natural cap: ${gem.data?.naturalMaxLevel ?? 'unknown'}; calculation data cap: ${gem.data?.maxLevel ?? 'unknown'}`);
      if (Object.keys(gem.statSet ?? {}).length || Object.keys(gem.statSetCalcs ?? {}).length) {
        lines.push(`  Stat sets: ${JSON.stringify(gem.statSet ?? {})}; calculation stat sets: ${JSON.stringify(gem.statSetCalcs ?? {})}`);
      }
    }
    for (const check of g.compatibility ?? []) lines.push(`  Compatibility [${check.scope}]: ${check.gemId}: ${check.reason}`);
    for (const issue of analysis.issues) lines.push(`- ${issue.message}. ${issue.suggestion}`);
    lines.push(...analysis.suggestions.map(s => `- ${s}`));
  }
  return lines.join('\n');
}
