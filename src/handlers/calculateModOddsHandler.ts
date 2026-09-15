/**
 * Handler for the calculate_mod_odds MCP tool.
 *
 * In PoE1, computes target probabilities when rolling a base,
 * using real spawn weights (ModItem.lua). Exact for the modeled cases;
 * deliberately does NOT model fossils/harvest/meta-crafts/affix-count
 * variance/currency cost (see the tool description).
 * PoE2 routes only plain one-step exalt/augment/regal to validated CoE
 * estimates. Other methods or incomplete source/state produce a coverage gap.
 */

import {
  ensureLoaded,
  resolveWeightForTags,
  type PobMod,
} from "../services/pobModDataLoader.js";
import {
  ensureBasesLoaded,
  findBasesMatching,
  getBase,
  type PobBase,
} from "../services/pobBaseDataLoader.js";
import {
  ensureCraftDataLoaded,
  getEssence,
  findEssencesMatching,
  resolveEssenceMods,
} from "../services/pobCraftDataLoader.js";
import {
  buildEligiblePool,
  probAllTargetsDrawn,
  type EligiblePool,
  type GroupInfo,
  calculatePoe2OneStepOdds,
} from "../services/oddsCalculator.js";
import { resolvePobDataLocation } from "../services/pobDataPath.js";

export interface OddsTargetInput {
  stat?: string;
  group?: string;
  min_tier?: number;
}

export interface CalculateModOddsArgs {
  base_name: string;
  ilvl: number;
  targets: OddsTargetInput[];
  method?: "chaos" | "alt" | "essence" | "exalt" | "augment" | "regal";
  /** PoE2 one-step operations require actual rarity and the complete affix list. */
  item_rarity?: "magic" | "rare";
  existing_mod_ids?: string[];
  essence_name?: string;
  prefix_count?: number;
  suffix_count?: number;
  raw_json?: boolean;
}

interface ResolvedTarget {
  label: string;
  group: string;
  affixType: "prefix" | "suffix";
  totalWeight: number;
  qualifyingWeight: number;
  conditionalFactor: number;
  /** Set when an essence forces this group. */
  forcedSatisfied?: boolean;
}

function clampCount(v: number | undefined, def: number): number {
  if (v === undefined || Number.isNaN(v)) return def;
  return Math.max(0, Math.min(3, Math.floor(v)));
}

function qualifyingWeightForTier(gi: GroupInfo, base: PobBase, minTier?: number): number {
  // gi.mods sorted top tier first (rank 1 = index 0). minTier = worst
  // acceptable rank; qualifying = ranks 1..minTier. No minTier = all.
  const qualifying = minTier && minTier > 0 ? gi.mods.slice(0, minTier) : gi.mods;
  let w = 0;
  for (const m of qualifying) w += resolveWeightForTags(m, base.tags);
  return w;
}

/** Find the GroupInfo for a group id across both pools, plus its affix side. */
function findGroup(pool: EligiblePool, group: string): { gi: GroupInfo; side: "prefix" | "suffix" } | null {
  const p = pool.prefixes.find((g) => g.group === group);
  if (p) return { gi: p, side: "prefix" };
  const s = pool.suffixes.find((g) => g.group === group);
  if (s) return { gi: s, side: "suffix" };
  return null;
}

/** Resolve a stat keyword to candidate groups (across both pools). */
function groupsMatchingStat(pool: EligiblePool, stat: string): Array<{ gi: GroupInfo; side: "prefix" | "suffix" }> {
  const kw = stat.toLowerCase();
  const out: Array<{ gi: GroupInfo; side: "prefix" | "suffix" }> = [];
  for (const gi of pool.prefixes) {
    if (gi.mods.some((m) => m.statLines.some((s) => s.toLowerCase().includes(kw)))) out.push({ gi, side: "prefix" });
  }
  for (const gi of pool.suffixes) {
    if (gi.mods.some((m) => m.statLines.some((s) => s.toLowerCase().includes(kw)))) out.push({ gi, side: "suffix" });
  }
  return out;
}

function textResult(text: string, isError = false) {
  return isError
    ? { content: [{ type: "text", text }], isError: true }
    : { content: [{ type: "text", text }] };
}

export async function handleCalculateModOdds(args: CalculateModOddsArgs) {
  if (!args.base_name) return textResult("Error: base_name is required.", true);
  if (!Number.isSafeInteger(args.ilvl) || args.ilvl < 1 || args.ilvl > 100) return textResult("Error: ilvl must be an integer from 1 to 100.", true);
  if (!Array.isArray(args.targets) || args.targets.length === 0) {
    return textResult("Error: targets must be a non-empty array, each with a `stat` keyword or `group`, optional `min_tier`.", true);
  }

  let game: "poe1" | "poe2";
  try { game = resolvePobDataLocation().game; }
  catch (error) { return textResult(`Error selecting PoB game data: ${error instanceof Error ? error.message : String(error)}`, true); }
  if (game === "poe2") {
    try {
      ensureBasesLoaded();
      const base = getBase(args.base_name);
      if (!base) throw new Error(`Native PoE2 base '${args.base_name}' not found. No approximate class mapping is used for odds.`);
      const result = calculatePoe2OneStepOdds(base, args.ilvl, args);
      if (args.raw_json) return textResult(JSON.stringify(result, null, 2));
      return textResult([
        `=== PoE2: one ${result.method} on ${base.name} ===`,
        `Conditional probability estimate: ${(result.combined_probability * 100).toFixed(4)}%`,
        `CoE weights: ${result.pool.qualifying_weight} / ${result.pool.total_weight}; ${result.pool.eligible_modifiers} eligible modifiers.`,
        `Source: ${result.source.url} | dataset ${result.source.patch} | fetched ${result.source.fetched_at}`,
        ...result.assumptions,
      ].join("\n"));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return textResult(args.raw_json ? JSON.stringify({ game: "poe2", coverage: "gap", code: "POE2_ODDS_COVERAGE_GAP",
        combined_probability: null, estimated_attempts: null, reason: message }, null, 2)
        : `PoE2 crafting odds coverage gap: ${message}\nNo probability was calculated.`, true);
    }
  }
  if (args.method && !["chaos", "alt", "essence"].includes(args.method)) return textResult("Unsupported PoE1 rolling method.", true);

  try {
    ensureLoaded();
    ensureBasesLoaded();
    ensureCraftDataLoaded();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return textResult(`Error loading PoB data: ${msg}`, true);
  }

  const base = getBase(args.base_name);
  if (!base) {
    const sugg = findBasesMatching(args.base_name, 5).map((b) => b.name);
    return textResult(`Base "${args.base_name}" not found.${sugg.length ? `\nDid you mean: ${sugg.join(", ")}` : ""}`);
  }

  const pool = buildEligiblePool(base, args.ilvl);
  const method = args.method ?? "chaos";
  const warnings: string[] = [];

  // Resolve targets ------------------------------------------------------
  const resolved: ResolvedTarget[] = [];
  for (const t of args.targets) {
    let found: { gi: GroupInfo; side: "prefix" | "suffix" } | null = null;
    let label = t.group ?? t.stat ?? "?";
    if (t.group) {
      found = findGroup(pool, t.group);
      if (!found) return textResult(`Target group "${t.group}" has no eligible mod on ${base.name} at ilvl ${args.ilvl}.`);
    } else if (t.stat) {
      const matches = groupsMatchingStat(pool, t.stat);
      if (matches.length === 0) {
        return textResult(`No eligible mod matching "${t.stat}" on ${base.name} at ilvl ${args.ilvl}. (It may not roll on this base, or needs higher ilvl.)`);
      }
      if (matches.length > 1) {
        const list = matches.map((m) => `  - ${m.gi.group} [${m.side}] e.g. "${m.gi.mods[0].affix}": ${m.gi.mods[0].statLines.join(" / ")}`).join("\n");
        return textResult(
          `"${t.stat}" matches multiple mod groups on ${base.name} — disambiguate by passing one as \`group\`:\n${list}`
        );
      }
      found = matches[0];
      label = `${t.stat}`;
    } else {
      return textResult("Error: each target needs a `stat` keyword or a `group`.", true);
    }

    const totalWeight = found.gi.totalWeight;
    const qualifyingWeight = qualifyingWeightForTier(found.gi, base, t.min_tier);
    const conditionalFactor = totalWeight > 0 ? qualifyingWeight / totalWeight : 0;
    const tierLabel = t.min_tier ? ` (T1–T${t.min_tier})` : "";
    resolved.push({
      label: `${label}${tierLabel}`,
      group: found.gi.group,
      affixType: found.side,
      totalWeight,
      qualifyingWeight,
      conditionalFactor,
    });
  }

  // Affix counts ---------------------------------------------------------
  let prefixCount = clampCount(args.prefix_count, 3);
  let suffixCount = clampCount(args.suffix_count, 3);
  if (method === "alt") {
    prefixCount = clampCount(args.prefix_count, 1) > 0 ? 1 : 0;
    suffixCount = clampCount(args.suffix_count, 1) > 0 ? 1 : 0;
  }

  // Working pools as {id,weight}; essence may remove a forced group.
  let prefixGroups = pool.prefixes.map((g) => ({ id: g.group, weight: g.totalWeight }));
  let suffixGroups = pool.suffixes.map((g) => ({ id: g.group, weight: g.totalWeight }));

  let essenceNote: string | null = null;
  if (method === "essence") {
    if (!args.essence_name) return textResult("Error: method 'essence' requires essence_name.", true);
    const ess = getEssence(args.essence_name);
    if (!ess) {
      const sugg = findEssencesMatching(args.essence_name, 6).map((e) => e.name);
      return textResult(`Essence "${args.essence_name}" not found.${sugg.length ? `\nDid you mean: ${sugg.join(", ")}` : ""}`);
    }
    const forced = resolveEssenceMods(ess.name, base.type)[0];
    if (!forced || !forced.mod) {
      return textResult(`${ess.name} has no forced mod for item type "${base.type}".`);
    }
    const fmod: PobMod = forced.mod;
    const fside = fmod.type.toLowerCase() === "prefix" ? "prefix" : "suffix";
    essenceNote = `${ess.name} forces ${fside} "${fmod.affix}": ${fmod.statLines.join(" / ")}`;
    // Occupy a slot on the forced side and remove its group from the pool.
    if (fside === "prefix") { prefixCount = Math.max(0, prefixCount - 1); prefixGroups = prefixGroups.filter((g) => g.id !== fmod.group); }
    else { suffixCount = Math.max(0, suffixCount - 1); suffixGroups = suffixGroups.filter((g) => g.id !== fmod.group); }
    // Auto-satisfy any target whose group is the forced group.
    for (const rt of resolved) {
      if (rt.group === fmod.group) {
        rt.forcedSatisfied = true;
        // forced mod is a specific tier — satisfies min_tier only if it qualifies
        rt.conditionalFactor = 1;
      }
    }
  }

  // Validity checks ------------------------------------------------------
  const prefixTargets = resolved.filter((r) => r.affixType === "prefix" && !r.forcedSatisfied);
  const suffixTargets = resolved.filter((r) => r.affixType === "suffix" && !r.forcedSatisfied);

  // Same-group collision (two targets needing the same group can't coexist)
  const groupCounts = new Map<string, number>();
  for (const r of resolved) groupCounts.set(r.group, (groupCounts.get(r.group) ?? 0) + 1);
  for (const [g, n] of groupCounts) {
    if (n > 1) {
      warnings.push(`Two targets map to the same mod group "${g}" — only one mod per group can roll, so this combination is impossible (P=0).`);
    }
  }
  if (prefixTargets.length > prefixCount) warnings.push(`${prefixTargets.length} prefix targets but only ${prefixCount} prefix slot(s) — impossible (P=0).`);
  if (suffixTargets.length > suffixCount) warnings.push(`${suffixTargets.length} suffix targets but only ${suffixCount} suffix slot(s) — impossible (P=0).`);

  // Probabilities --------------------------------------------------------
  const pPrefix = probAllTargetsDrawn(prefixGroups, prefixTargets.map((t) => t.group), prefixCount);
  const pSuffix = probAllTargetsDrawn(suffixGroups, suffixTargets.map((t) => t.group), suffixCount);
  const tierFactor = resolved.reduce((acc, r) => acc * r.conditionalFactor, 1);
  const combined = warnings.length > 0 ? 0 : pPrefix * pSuffix * tierFactor;
  const attempts = combined > 0 ? 1 / combined : Infinity;

  if (args.raw_json) {
    return textResult(JSON.stringify({
      base: base.name, type: base.type, ilvl: args.ilvl, method,
      prefix_count: prefixCount, suffix_count: suffixCount,
      pool: { prefix_groups: pool.prefixes.length, prefix_weight: pool.prefixWeight, suffix_groups: pool.suffixes.length, suffix_weight: pool.suffixWeight },
      essence: essenceNote,
      targets: resolved,
      p_prefix_targets: pPrefix, p_suffix_targets: pSuffix, tier_factor: tierFactor,
      combined_probability: combined, estimated_attempts: Number.isFinite(attempts) ? attempts : null,
      warnings,
    }, null, 2));
  }

  const pct = (p: number): string => {
    if (p <= 0) return "0%";
    if (p >= 1) return "100%";
    const decimals = p < 0.001 ? 4 : p < 0.01 ? 3 : 2;
    return `${(p * 100).toFixed(decimals)}%`;
  };
  const lines: string[] = [];
  lines.push(`=== Roll odds: ${base.name} (${base.type}) ilvl ${args.ilvl} ===`);
  lines.push(`Method: ${method}  |  slots assumed: ${prefixCount} prefix / ${suffixCount} suffix`);
  if (essenceNote) lines.push(`Essence: ${essenceNote}`);
  lines.push(`Pool: ${pool.prefixes.length} prefix groups (Σw ${pool.prefixWeight}), ${pool.suffixes.length} suffix groups (Σw ${pool.suffixWeight})`);
  lines.push("");
  lines.push("Targets:");
  for (const r of resolved) {
    const share = r.totalWeight > 0 ? ((r.qualifyingWeight / (r.affixType === "prefix" ? pool.prefixWeight : pool.suffixWeight)) * 100) : 0;
    const forced = r.forcedSatisfied ? "  [guaranteed by essence]" : "";
    lines.push(`  - ${r.label} [${r.affixType}] group=${r.group}${forced}`);
    lines.push(`      weight ${r.qualifyingWeight}/${r.totalWeight} in group; ${share.toFixed(2)}% of all ${r.affixType} weight`);
    if (r.conditionalFactor < 1 && !r.forcedSatisfied) {
      lines.push(`      tier filter keeps ${(r.conditionalFactor * 100).toFixed(1)}% of the group's weight`);
    }
  }
  lines.push("");
  if (warnings.length > 0) {
    for (const w of warnings) lines.push(`⚠ ${w}`);
    lines.push("");
  }
  lines.push(`P(all prefix targets in ${prefixCount} draws): ${pct(pPrefix)}`);
  lines.push(`P(all suffix targets in ${suffixCount} draws): ${pct(pSuffix)}`);
  if (tierFactor < 1) lines.push(`Tier-filter factor: ${(tierFactor * 100).toFixed(2)}%`);
  lines.push(`Combined probability: ${pct(combined)}`);
  if (Number.isFinite(attempts) && combined > 0) {
    lines.push(`≈ ${Math.round(attempts).toLocaleString()} full rerolls on average to hit (1 / P)`);
  }
  lines.push("");
  lines.push(
    "These are exact roll-pool odds from the game's spawn weights. They assume " +
      "a uniform full reroll into the given slot counts and do NOT model orb-" +
      "specific affix-count variance, fossils/harvest/meta-crafts, or currency " +
      "cost. For those, use Craft of Exile."
  );

  return textResult(lines.join("\n"));
}
