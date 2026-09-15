/**
 * Handler for the list_craftable_mods_for_base MCP tool.
 *
 * Given a base item name (and optional ilvl), pull every prefix and suffix
 * from PoB's ModItem.lua that can roll on that base. Group results by mod
 * group, show the highest available tier per group, and indicate which
 * tags drove the match. This is the next step beyond search_crafting_mods
 * — instead of "what mods match a stat keyword", it's "what is the entire
 * craftable space on this base right now".
 *
 * The base name lookup is case-insensitive. If the name doesn't resolve,
 * we surface up to 5 fuzzy suggestions so the user can correct it.
 */

import {
  ensureLoaded as ensureModsLoaded,
  resolveWeightForTags,
  searchMods,
  getModItemPath,
  type PobMod,
} from "../services/pobModDataLoader.js";
import {
  ensureBasesLoaded,
  findBasesMatching,
  getBase,
  getBaseCount,
  type PobBase,
} from "../services/pobBaseDataLoader.js";
import { resolvePobDataLocation } from "../services/pobDataPath.js";

export interface ListCraftableModsArgs {
  base_name: string;
  ilvl?: number;
  /** "prefix" / "suffix" / undefined (both). */
  type?: string;
  /** Cap on entries per mod group (default 1 = top tier only). 0 = unlimited. */
  tiers_per_group?: number;
  /** Hide mods that only roll via influence/essence/fossil (default true). */
  hide_unrollable?: boolean;
  /** Substring filter on stat text — narrows the dump when desired. */
  stat_contains?: string;
  raw_json?: boolean;
}

interface MatchedMod {
  mod: PobMod;
  /** Resolved weight on this base. */
  weight: number;
  /** Which tag actually matched (or "default" if it fell through). */
  matchedTag: string;
  tier: number | null;
}

function resolveWithTagInfo(mod: PobMod, tags: string[]): { weight: number; tag: string } {
  const tagSet = new Set(tags);
  for (const w of mod.weights) {
    if (tagSet.has(w.tag)) return { weight: w.weight, tag: w.tag };
  }
  const def = mod.weights.find((w) => w.tag === "default");
  return { weight: def ? def.weight : 0, tag: "default" };
}

/**
 * Group matched mods by their `group` field and keep the top-N tiers per
 * group (sorted by descending level — highest-tier first). Within a group,
 * if two mods share the same level (rare), declaration order is preserved.
 */
function groupAndTier(
  matches: MatchedMod[],
  tiersPerGroup: number
): Map<string, MatchedMod[]> {
  const grouped = new Map<string, MatchedMod[]>();
  for (const m of matches) {
    const key = `${m.mod.type}:${m.mod.group || `(ungrouped:${m.mod.id})`}`;
    const arr = grouped.get(key) ?? [];
    arr.push(m);
    grouped.set(key, arr);
  }
  for (const [k, arr] of grouped.entries()) {
    arr.sort((a, b) => b.mod.level - a.mod.level);
    if (tiersPerGroup > 0 && arr.length > tiersPerGroup) {
      grouped.set(k, arr.slice(0, tiersPerGroup));
    }
  }
  return grouped;
}

function formatBaseHeader(base: PobBase, ilvl?: number): string[] {
  const lines: string[] = [];
  const subTypeNote = base.subType ? `, ${base.subType}` : "";
  lines.push(`=== ${base.name} (${base.type}${subTypeNote}) ===`);
  lines.push(`Tags: ${base.tags.join(", ")}`);
  if (base.implicit) lines.push(`Implicit: ${base.implicit}`);
  const reqParts: string[] = [];
  if (base.req.level !== undefined) reqParts.push(`level ${base.req.level}`);
  if (base.req.str !== undefined) reqParts.push(`str ${base.req.str}`);
  if (base.req.dex !== undefined) reqParts.push(`dex ${base.req.dex}`);
  if (base.req.int !== undefined) reqParts.push(`int ${base.req.int}`);
  if (reqParts.length > 0) lines.push(`Requirements: ${reqParts.join(", ")}`);
  if (ilvl !== undefined) lines.push(`Filtering mods to ilvl <= ${ilvl}`);
  else lines.push(`No ilvl filter — listing every tier (pass ilvl to gate).`);
  return lines;
}

function formatGroup(
  groupKey: string,
  entries: MatchedMod[]
): string[] {
  if (entries.length === 0) return [];
  const lines: string[] = [];
  const type = entries[0].mod.type;
  lines.push(`  [${type}] group "${entries[0].mod.group || groupKey}":`);
  for (const e of entries) {
    const tagNote =
      e.matchedTag === "default" ? " (default)" : ` (via ${e.matchedTag})`;
    const statText = e.mod.statLines.join(" / ");
    lines.push(
      `    ${e.tier === null ? "Tier unknown" : `T${e.tier}`} L${e.mod.level.toString().padStart(2)} source-value=${e.weight}${tagNote}  ${e.mod.affix || "?"}: ${statText}`
    );
  }
  return lines;
}

export async function handleListCraftableModsForBase(args: ListCraftableModsArgs) {
  if (!args.base_name) {
    return {
      content: [
        {
          type: "text",
          text: "Error: base_name is required.",
        },
      ],
      isError: true,
    };
  }

  if (args.ilvl !== undefined && (!Number.isSafeInteger(args.ilvl) || args.ilvl < 1 || args.ilvl > 100) ||
    args.tiers_per_group !== undefined && (!Number.isSafeInteger(args.tiers_per_group) || args.tiers_per_group < 0) ||
    args.type !== undefined && !["prefix", "suffix"].includes(args.type.toLowerCase())) {
    return { content: [{ type: "text", text: "Error: invalid ilvl, type or tiers_per_group." }], isError: true };
  }
  let game: "poe1" | "poe2";
  try {
    game = resolvePobDataLocation().game;
    ensureBasesLoaded();
    ensureModsLoaded();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      content: [
        {
          type: "text",
          text: `Error loading PoB data: ${msg}\nEnsure the PathOfBuilding submodule is checked out.`,
        },
      ],
      isError: true,
    };
  }

  const base = getBase(args.base_name);
  if (!base) {
    const suggestions = findBasesMatching(args.base_name, 5);
    const suggestText =
      suggestions.length > 0
        ? `\nDid you mean:\n${suggestions.map((b) => `  - ${b.name} (${b.type})`).join("\n")}`
        : `\nNo close matches found. ${getBaseCount()} bases loaded.`;
    return {
      content: [
        {
          type: "text",
          text: `Base "${args.base_name}" not found.${suggestText}`,
        },
      ],
    };
  }

  const ilvl = args.ilvl;
  if (game === "poe2" && ["jewel", "flask", "fishing", "incursionlimb", "tincture"].includes(base.sourceFile)) {
    return { content: [{ type: "text", text: `PoE2 coverage gap: ${base.type} uses a separate modifier pool; ordinary ModItem listings are not applicable.` }], isError: true };
  }
  const typeFilter = args.type?.toLowerCase();
  const tiersPerGroup = args.tiers_per_group ?? 1;
  const hideUnrollable = args.hide_unrollable ?? true;

  // Pull every mod that matches any of the base's tags. We use the loader's
  // search with itemTags + (optional) type + statContains, then post-filter
  // for ilvl gating and unrollable-mod hiding.
  const allMatching = searchMods({
    type: typeFilter,
    limit: 0,
  }).filter(mod => ["Prefix", "Suffix"].includes(mod.type));

  // Rank across the full class/group BEFORE ilvl or text filters. The best
  // available tier on a low-level base must not be relabeled as absolute T1.
  const ladders = new Map<string, PobMod[]>();
  for (const mod of allMatching) {
    if (!mod.affix || resolveWeightForTags(mod, base.tags) <= 0) continue;
    const key = `${mod.type}:${mod.group}`;
    const entries = ladders.get(key) ?? [];
    entries.push(mod); ladders.set(key, entries);
  }
  for (const entries of ladders.values()) entries.sort((a,b) => b.level-a.level);

  const matches: MatchedMod[] = [];
  for (const mod of allMatching) {
    if (ilvl !== undefined && mod.level > ilvl) continue;
    if (args.stat_contains && !mod.statLines.some(line => line.toLowerCase().includes(args.stat_contains!.toLowerCase()))) continue;
    const { weight, tag } = resolveWithTagInfo(mod, base.tags);
    if (hideUnrollable && weight <= 0) continue;
    const index = (ladders.get(`${mod.type}:${mod.group}`) ?? []).findIndex(m => m.id === mod.id);
    matches.push({ mod, weight, matchedTag: tag, tier: index >= 0 ? index+1 : null });
  }

  const grouped = groupAndTier(matches, tiersPerGroup);

  if (args.raw_json) {
    const json = {
      game,
      source: getModItemPath(),
      weight_semantics: game === "poe2" ? "eligibility-only" : "spawn-weight",
      tier_basis: "Descending source minimum item level across the full compatible group, before ilvl filtering.",
      base: {
        name: base.name,
        type: base.type,
        subType: base.subType,
        tags: base.tags,
        implicit: base.implicit,
        req: base.req,
      },
      ilvl,
      filters: {
        type: typeFilter,
        stat_contains: args.stat_contains,
        tiers_per_group: tiersPerGroup,
        hide_unrollable: hideUnrollable,
      },
      mod_count: matches.length,
      listed_mod_count: Array.from(grouped.values()).reduce((sum,entries) => sum+entries.length,0),
      group_count: grouped.size,
      groups: Array.from(grouped.entries()).map(([k, v]) => ({
        group: v[0].mod.group || k,
        entries: v.map((e) => ({
          id: e.mod.id,
          type: e.mod.type,
          affix: e.mod.affix,
          level: e.mod.level,
          statLines: e.mod.statLines,
          modTags: e.mod.modTags,
          weight: e.weight,
          spawn_weight: game === "poe2" ? null : e.weight,
          tier: e.tier,
          applicability: e.weight > 0 ? "natural-eligibility" : "special-method-unverified",
          matchedTag: e.matchedTag,
        })),
      })),
    };
    return { content: [{ type: "text", text: JSON.stringify(json, null, 2) }] };
  }

  const lines: string[] = [];
  lines.push(...formatBaseHeader(base, ilvl));
  lines.push(`Game: ${game} | source: ${getModItemPath()}`);
  if (game === "poe2") lines.push("PoB2 source values are eligibility flags, not spawn probabilities. Tiers are ranked before ilvl filtering.");
  lines.push("");
  if (matches.length === 0) {
    lines.push(`No craftable mods matched (after ilvl gate + filters).`);
    return { content: [{ type: "text", text: lines.join("\n") }] };
  }

  // Split prefixes and suffixes — game presents them this way too.
  const prefixGroups: Array<[string, MatchedMod[]]> = [];
  const suffixGroups: Array<[string, MatchedMod[]]> = [];
  const otherGroups: Array<[string, MatchedMod[]]> = [];
  for (const [k, v] of grouped.entries()) {
    const type = v[0]?.mod.type.toLowerCase();
    if (type === "prefix") prefixGroups.push([k, v]);
    else if (type === "suffix") suffixGroups.push([k, v]);
    else otherGroups.push([k, v]);
  }
  // Sort groups by their top entry's level descending — most relevant first
  const sortGroups = (a: [string, MatchedMod[]], b: [string, MatchedMod[]]) =>
    (b[1][0]?.mod.level ?? 0) - (a[1][0]?.mod.level ?? 0);
  prefixGroups.sort(sortGroups);
  suffixGroups.sort(sortGroups);
  otherGroups.sort(sortGroups);

  const groupSummary = (n: number) =>
    `${n} group${n === 1 ? "" : "s"}, ${tiersPerGroup === 1 ? "top tier only" : tiersPerGroup === 0 ? "all tiers" : `up to ${tiersPerGroup} tiers each`}`;

  if (prefixGroups.length > 0) {
    lines.push(`--- PREFIXES (${groupSummary(prefixGroups.length)}) ---`);
    for (const [k, v] of prefixGroups) lines.push(...formatGroup(k, v));
    lines.push("");
  }
  if (suffixGroups.length > 0) {
    lines.push(`--- SUFFIXES (${groupSummary(suffixGroups.length)}) ---`);
    for (const [k, v] of suffixGroups) lines.push(...formatGroup(k, v));
    lines.push("");
  }
  if (otherGroups.length > 0) {
    lines.push(`--- OTHER (${groupSummary(otherGroups.length)}) ---`);
    for (const [k, v] of otherGroups) lines.push(...formatGroup(k, v));
    lines.push("");
  }
  lines.push(
    `Total mods listed: ${Array.from(grouped.values()).reduce((sum,entries) => sum+entries.length,0)} of ${matches.length} matches across ${grouped.size} groups. ` +
      (hideUnrollable
        ? "Unrollable mods (weight 0) hidden — pass hide_unrollable=false to include essence/fossil-only entries."
        : "Zero-eligibility definitions are shown for reference; their applicability through special methods is unverified.")
  );
  lines.push(
    (game === "poe2" ? "Source values indicate eligibility on this base, not probabilities. " : "Weights shown are spawn weights after tag-chain resolution. ") +
      "L is the mod's minimum ilvl. Same-group mods conflict; only one can roll per item."
  );

  return { content: [{ type: "text", text: lines.join("\n") }] };
}
