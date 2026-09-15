/**
 * Threshold-Jewel evaluator.
 *
 * Legacy PoE1 "With at least N <attribute> in Radius" thresholds count
 * eligible nodes whether allocated or not. This is distinct from allocated-
 * attribute scaling effects. PoB2 retains legacy parser patterns, but its
 * installed item catalog does not establish these as available PoE2 jewels.
 *
 * This service:
 *   - Parses threshold-style mod patterns from a jewel's mod text.
 *   - Given the build's allocation, evaluates each threshold against the
 *     attribute sum in the jewel's radius (via radiusUtils.sumAttributeInRadius).
 *   - Reports whether each threshold is met, and by how much margin.
 *
 * Per legal_considerations.md: relies only on the jewel's own mod text plus
 * the build's tree state. No game-data extraction required.
 *
 * Phase-1 scope:
 *   - Attribute thresholds: Strength, Dexterity, Intelligence.
 *   - Uses an explicit radius or item Radius line; direct legacy calls keep
 *     the old Small fallback for compatibility, not as a claim about the item.
 *   - Does NOT yet parse "Notable Passive Skills in Radius" patterns or
 *     "Total Attributes in Radius" — those are rarer and Phase-2 material.
 */

import { JEWEL_RADII, getJewelRadius, sumAttributeInRadius, radiusTree, type RadiusContext } from "./radiusUtils.js";

export type Attribute = "Strength" | "Dexterity" | "Intelligence";

export interface ThresholdMod {
  /** The threshold attribute (e.g. "Strength"). */
  attribute: Attribute;
  /** The minimum number required in radius (e.g. 40). */
  requiredAmount: number;
  /** The full mod text — for display. */
  rawMod: string;
}

/**
 * Match patterns the game uses for attribute thresholds. Examples:
 *   "With at least 40 Strength in Radius, 1% increased Strength per 20 Strength"
 *   "With 40 Intelligence in Radius, 20% increased Effect of Auras…"
 *   "With at least 40 Dexterity in Radius, …"
 */
const THRESHOLD_PATTERN = /With(?:\s+at\s+least)?\s+(\d+)\s+(Strength|Dexterity|Intelligence)\s+in\s+Radius,?\s*(.*)/i;

export function parseThresholdMods(modLines: string[]): ThresholdMod[] {
  const results: ThresholdMod[] = [];
  for (const rawLine of modLines) {
    // Strip mod-source prefixes (`{crafted}` etc.) and trailing source tags.
    const cleaned = rawLine
      .replace(/^\{[^}]+\}/, "")
      .replace(/\s*\[[^\]]+\]\s*$/, "")
      .trim();
    if (!cleaned) continue;
    const m = cleaned.match(THRESHOLD_PATTERN);
    if (m) {
      const requiredAmount = parseInt(m[1], 10);
      const attribute = (m[2].charAt(0).toUpperCase() +
        m[2].slice(1).toLowerCase()) as Attribute;
      results.push({
        attribute,
        requiredAmount,
        rawMod: cleaned,
      });
    }
  }
  return results;
}

export interface ThresholdEvaluation {
  threshold: ThresholdMod;
  attributeInRadius: number;
  triggered: boolean;
  /** How far above or below the threshold; positive = over (triggered with margin), negative = short. */
  margin: number;
  /** Radius used for the evaluation (in tree-coord units). */
  radius: number;
  /** Text-only legacy calculation, before other jewels/transforms/overrides. */
  basis?: string;
}

/**
 * Evaluate a single threshold against the current build state.
 *
 * @param threshold        Parsed threshold mod.
 * @param socketNodeId     Node ID of the jewel socket containing the jewel.
 * @param allocatedNodes   Retained for API compatibility; these thresholds include unallocated nodes.
 * @param radius           Override radius in tree units. Defaults to "Small"
 *                         (800) for legacy API compatibility. Item-specific
 *                         callers should provide the actual radius.
 */
export function evaluateThreshold(
  threshold: ThresholdMod,
  socketNodeId: string,
  allocatedNodes: Set<string>,
  radius: number = JEWEL_RADII.small,
  context: RadiusContext = {}
): ThresholdEvaluation {
  const resolved = radiusTree(context);
  if (resolved.treeVersion.startsWith('0_')) {
    throw new Error('PoE2 attribute-threshold evaluation is unavailable: legacy parser patterns are not proof of an available PoE2 threshold jewel or its effective attributes.');
  }
  const inRadius = sumAttributeInRadius(
    socketNodeId,
    radius,
    threshold.attribute,
    undefined,
    resolved
  );
  return {
    threshold,
    attributeInRadius: inRadius,
    triggered: inRadius >= threshold.requiredAmount,
    margin: inRadius - threshold.requiredAmount,
    radius,
    basis: 'All eligible nodes in radius, including unallocated nodes; printed base attributes only. Native transforms and overrides are not evaluated.',
  };
}

export interface JewelThresholdSocketInfo {
  socketNodeId: string;
  jewelName: string;
  mods: string[];
  /** Optional radius override (in tree units). If omitted, JEWEL_RADII.small is used. */
  radius?: number;
  treeVersion?: string;
}

export interface EvaluateBuildResult {
  jewelsScanned: number;
  jewelsWithThresholds: number;
  evaluations: Array<{
    socketNodeId: string;
    jewelName: string;
    radius: number;
    triggered: ThresholdEvaluation[];
    notTriggered: ThresholdEvaluation[];
  }>;
}

export function evaluateBuildThresholds(
  jewels: JewelThresholdSocketInfo[],
  allocatedNodes: Set<string>,
  context: RadiusContext = {}
): EvaluateBuildResult {
  const out: EvaluateBuildResult = {
    jewelsScanned: jewels.length,
    jewelsWithThresholds: 0,
    evaluations: [],
  };
  for (const j of jewels) {
    const thresholds = parseThresholdMods(j.mods);
    if (thresholds.length === 0) continue;
    out.jewelsWithThresholds++;
    const resolved = radiusTree({ ...context, treeVersion: j.treeVersion ?? context.treeVersion });
    const label = j.mods.find(line => /^Radius:/i.test(line))?.replace(/^Radius:\s*/i, '').trim();
    const radius = j.radius ?? getJewelRadius(label ?? 'Small', resolved).outer;
    const evals = thresholds.map((t) =>
      evaluateThreshold(t, j.socketNodeId, allocatedNodes, radius, resolved)
    );
    out.evaluations.push({
      socketNodeId: j.socketNodeId,
      jewelName: j.jewelName,
      radius,
      triggered: evals.filter((e) => e.triggered),
      notTriggered: evals.filter((e) => !e.triggered),
    });
  }
  return out;
}
