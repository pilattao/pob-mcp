import type { PassiveTreeNode, PoBBuild, TreeAnalysisResult } from '../types.js';

export function activeValidationSpec(build: PoBBuild): any {
  const specs = build.Tree?.Spec;
  return Array.isArray(specs) ? specs[Number(build.Tree?.activeSpec ?? 1) - 1] ?? specs[specs.length - 1] : specs;
}

export function isPoe2Validation(build: PoBBuild): boolean {
  if (build.__xmlRoot) return build.__xmlRoot === 'PathOfBuilding2';
  const version = activeValidationSpec(build)?.treeVersion;
  if (version) return String(version).startsWith('0_');
  return process.env.POE_GAME === 'poe2';
}

/** Missing, boolean, empty and non-finite values are not measured zeroes. */
export function validationStat(stats: any, key: string): number | null {
  const raw = stats instanceof Map ? stats.get(key) : stats?.[key];
  if (typeof raw !== 'number' && typeof raw !== 'string') return null;
  if (typeof raw === 'string' && !raw.trim()) return null;
  const value = Number(raw);
  return Number.isFinite(value) ? value : null;
}

type BudgetNode = PassiveTreeNode & {
  type?: string;
  classesStart?: unknown;
  isFreeAllocate?: boolean;
  isMultipleChoiceOption?: boolean;
};

/** Mirrors PassiveSpec.lua:CountAllocNodes, including its nil check for free nodes. */
export function costsPassivePoint(node: BudgetNode): boolean {
  return node.classesStart == null && node.type !== 'ClassStart' &&
    !node.isAscendancyStart && node.type !== 'AscendClassStart' &&
    node.isFreeAllocate == null && !(node.ascendancyName && node.isMultipleChoiceOption);
}

export interface PassiveBudget {
  nonAscendancyPoints: number;
  sharedPoints: number;
  weaponSetPoints: [number, number];
  perWeaponPoints: [number, number];
  ascendancyPoints: number;
  availablePoints: number | null;
  weaponSetLimit: number | null;
  notes: string[];
  warnings: string[];
}

export type BudgetTreeAnalysis = TreeAnalysisResult & { passiveBudget?: PassiveBudget };

export function poe2PassiveBudget(build: PoBBuild, nodes: PassiveTreeNode[], stats?: any): PassiveBudget {
  const spec = activeValidationSpec(build);
  const ids = (value: unknown) => new Set(String(value ?? '').split(',').map(s => s.trim()).filter(Boolean));
  const sets = [ids(spec?.WeaponSet1?.nodes), ids(spec?.WeaponSet2?.nodes)];
  if ([...sets[0]].some(id => sets[1].has(id))) {
    throw new Error('PoE2 passive budget unknown: a node is assigned to both weapon sets.');
  }
  const unique = [...new Map(nodes.map(n => [n.skill, n])).values()];
  const paid = unique.filter(costsPassivePoint);
  const regular = paid.filter(n => !n.ascendancyName);
  const weaponSetPoints = sets.map(set => regular.filter(n => set.has(String(n.skill))).length) as [number, number];
  const sharedPoints = regular.length - weaponSetPoints[0] - weaponSetPoints[1];
  // Verified against installed PoB2 0_5 Data/QuestRewards.lua (12 rewards of 2)
  // and Modules/Build.lua:EstimatePlayerProgress. Do not extrapolate to new trees.
  const questPoints = spec?.treeVersion === '0_5' ? 24 : null;
  const level = validationStat(build.Build, 'level');
  const integerStat = (key: string) => {
    const n = validationStat(stats, key);
    return n !== null && Number.isInteger(n) && n >= 0 ? n : null;
  };
  const extra = integerStat('ExtraPoints');
  const converted = integerStat('PassivePointsToWeaponSetPoints');
  const availablePoints = questPoints !== null && level !== null && Number.isInteger(level) && level >= 1 && level <= 100
    ? level - 1 + questPoints + (extra ?? 0) : null;
  const weaponSetLimit = questPoints === null ? null : questPoints + (converted ?? 0);
  const perWeaponPoints: [number, number] = [sharedPoints + weaponSetPoints[0], sharedPoints + weaponSetPoints[1]];
  const notes = ['Budget assumes all passive quest rewards; quest completion is unverified.'];
  if (extra === null) notes.push('ExtraPoints is unknown; displayed total budget is the level-and-quest baseline.');
  if (converted === null) notes.push('PassivePointsToWeaponSetPoints is unknown; weapon-specific limit uses the quest baseline.');
  if (availablePoints === null) notes.push('Point budget is unknown for this tree version or character level.');
  const warnings: string[] = [];
  perWeaponPoints.forEach((points, i) => {
    if (availablePoints !== null && points > availablePoints) {
      warnings.push(`Weapon set ${i + 1} spends ${points} / ${availablePoints} points${extra === null ? ' against the baseline; native extra points must be checked' : '; exceeds the budget even with all quest rewards'}.`);
    }
    if (weaponSetLimit !== null && weaponSetPoints[i] > weaponSetLimit) {
      warnings.push(`Weapon set ${i + 1} has ${weaponSetPoints[i]} / ${weaponSetLimit} weapon-specific points${converted === null ? ' against the baseline; native converted points must be checked' : '; exceeds the weapon-specific limit'}.`);
    }
  });
  const ascendancyPoints = paid.filter(n => n.ascendancyName).length;
  // Primary/secondary ascendancies have separate native pools. Avoid a combined cap.
  const ascendancies = new Map<string, number>();
  paid.filter(n => n.ascendancyName).forEach(n => ascendancies.set(n.ascendancyName!, (ascendancies.get(n.ascendancyName!) ?? 0) + 1));
  if (questPoints !== null) for (const [name, count] of ascendancies) {
    if (count > 8) warnings.push(`${name} spends ${count} / 8 ascendancy points.`);
  }
  return { nonAscendancyPoints: regular.length, sharedPoints, weaponSetPoints, perWeaponPoints, ascendancyPoints, availablePoints, weaponSetLimit, notes, warnings };
}
