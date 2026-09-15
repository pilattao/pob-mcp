/**
 * Handler for the analyze_item_mods MCP tool.
 *
 * Given a set of mod lines from an item (the explicit prefix/suffix text
 * a player sees in PoE), identify each line as a specific entry in PoB's
 * ModItem.lua and surface tier info + the next-tier upgrade target.
 *
 * Adjacent lines that match the same hybrid mod (e.g. Crocodile's
 * "+to Armour" / "+to Life") are collapsed into a single 2-line mod.
 *
 * Recognised input cleaning:
 *   - Strips master-craft tags (`{crafted}`, `(crafted)`) — those mods
 *     come from ModMaster.lua, not ModItem.lua. The handler reports them
 *     separately as "crafted mod, not from natural prefix/suffix pool"
 *     rather than guessing.
 *   - Strips `{fractured}`, `{enchanted}`, `[fractured]` tags.
 *   - Skips blank lines.
 */

import {
  ensureLoaded,
  matchStatLine,
  getModGroup,
  getModItemPath,
  normalizeStatLine,
  parseRolledValues,
  rolledValuesFitTemplate,
  resolveWeightForTags,
  type MatchResult,
  type PobMod,
} from "../services/pobModDataLoader.js";
import {
  ensureBasesLoaded,
  findBasesMatching,
  getBase,
  type PobBase,
} from "../services/pobBaseDataLoader.js";
import {
  matchMasterCraft,
  type MasterCraft,
} from "../services/pobCraftDataLoader.js";
import type { AnyLuaClient } from "../pobLuaBridge.js";
import { parseItemRawMods, parseItemLevel } from "../utils/itemRawParser.js";
import { resolvePobDataLocation } from "../services/pobDataPath.js";

export interface AnalyzeItemModsContext {
  getLuaClient: () => AnyLuaClient | null;
  ensureLuaClient: () => Promise<void>;
}

export interface AnalyzeItemModsArgs {
  mod_lines?: string[];
  /**
   * Read the item from the live PoB build instead of mod_lines. The slot
   * name as PoB labels it ("Body Armour", "Weapon 1", "Ring 1", "Helmet",
   * etc). Requires a connected PoB TCP bridge.
   */
  item_slot?: string;
  base_name?: string;
  ilvl?: number;
  raw_json?: boolean;
}

interface LineAnalysis {
  /** 1-indexed line number from the input. */
  inputLine: number;
  /** Original line as given. */
  raw: string;
  /** Same line with crafted/fractured/etc markers stripped. */
  cleaned: string;
  /** Detected source: natural | crafted | fractured | enchanted | unknown. */
  source: "natural" | "crafted" | "fractured" | "enchanted" | "unknown";
  /** The matched mod (or null if no match found). */
  match: MatchResult | null;
  /** Matched bench craft, for `{crafted}` lines (null otherwise). */
  masterMatch?: MasterCraft | null;
  /** True if this line is the second line of a hybrid mod above it. */
  isHybridContinuation?: boolean;
  coverageGap?: string;
}

/** Keep PoB's permissive template matcher for legacy callers, but do not turn
 * out-of-range, wrong-base or too-high-ilvl guesses into native identifications. */
function nativeMatch(text: string, itemTags?: string[], ilvl?: number): MatchResult {
  const result = matchStatLine(text, { itemTags, ilvl });
  const candidates = result.candidates.filter(mod => mod.affix && ["Prefix", "Suffix"].includes(mod.type) &&
    mod.level <= (ilvl ?? Infinity) && (!itemTags || resolveWeightForTags(mod, itemTags) > 0) &&
    rolledValuesFitTemplate(parseRolledValues(text), mod.statLines[0]));
  const best = candidates.includes(result.best!) ? result.best : candidates.sort((a,b) => b.level-a.level)[0] ?? null;
  if (!best) return { query: text, candidates: [], best: null, meaningfulCandidateCount: 0 };
  const ladder = itemTags ? getModGroup(best.group).filter(mod => mod.affix && mod.type === best.type &&
    resolveWeightForTags(mod, itemTags) > 0 && mod.statLines.map(normalizeStatLine).join("\n") === best.statLines.map(normalizeStatLine).join("\n"))
    .sort((a,b) => b.level-a.level) : [];
  const index = ladder.findIndex(mod => mod.id === best.id);
  return { query: text, candidates, best, meaningfulCandidateCount: candidates.length,
    ...(index >= 0 ? { tier: index+1, tierMax: ladder.length, ...(index > 0 ? { nextTier: ladder[index-1] } : {}) } : {}) };
}

function cleanLine(line: string): { text: string; source: LineAnalysis["source"] } {
  const trimmed = line.trim();
  if (trimmed.length === 0) return { text: "", source: "natural" };
  let source: LineAnalysis["source"] = "natural";
  let text = trimmed;
  if (/\{crafted\}/i.test(text) || /\(crafted\)/i.test(text)) source = "crafted";
  else if (/\{fractured\}/i.test(text) || /\[fractured\]/i.test(text)) source = "fractured";
  else if (/\{enchanted\}/i.test(text)) source = "enchanted";
  text = text
    .replace(/\{crafted\}/gi, "")
    .replace(/\(crafted\)/gi, "")
    .replace(/\{fractured\}/gi, "")
    .replace(/\[fractured\]/gi, "")
    .replace(/\{enchanted\}/gi, "")
    .replace(/\s+/g, " ")
    .trim();
  return { text, source };
}

function summarizeMod(mod: PobMod): string {
  return `${mod.id} [${mod.type}] "${mod.affix || "?"}" L${mod.level} group="${mod.group || "?"}"`;
}

function tierString(r: MatchResult): string {
  if (r.tier && r.tierMax) return `tier ${r.tier}/${r.tierMax}`;
  return "tier (unknown)";
}

function nextString(r: MatchResult): string {
  if (!r.nextTier) return "(already top tier on this base)";
  return `${r.nextTier.id} "${r.nextTier.affix}" L${r.nextTier.level} → ${r.nextTier.statLines.join(" / ")}`;
}

export async function handleAnalyzeItemMods(
  args: AnalyzeItemModsArgs,
  context?: AnalyzeItemModsContext
) {
  if (!args.item_slot && (!Array.isArray(args.mod_lines) || args.mod_lines.length === 0)) {
    return { content: [{ type: "text", text: "Error: provide mod_lines or item_slot." }], isError: true };
  }
  if (args.ilvl !== undefined && (!Number.isSafeInteger(args.ilvl) || args.ilvl < 1 || args.ilvl > 100)) {
    return { content: [{ type: "text", text: "Error: ilvl must be an integer from 1 to 100." }], isError: true };
  }
  let game: "poe1" | "poe2";
  try {
    game = resolvePobDataLocation().game;
    ensureLoaded();
    ensureBasesLoaded();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      content: [
        { type: "text", text: `Error loading PoB data: ${msg}\nEnsure the PathOfBuilding submodule is checked out.` },
      ],
      isError: true,
    };
  }

  // Resolve inputs: either explicit mod_lines, or a live item slot read
  // from PoB over TCP. item_slot wins when both are present.
  let modLines = args.mod_lines ?? [];
  let resolvedBaseName = args.base_name;
  let resolvedIlvl = args.ilvl;
  let liveItemNote: string | null = null;

  if (args.item_slot) {
    if (!context) {
      return {
        content: [{ type: "text", text: "Error: item_slot requires a live PoB connection (internal context missing)." }],
        isError: true,
      };
    }
    try {
      await context.ensureLuaClient();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return {
        content: [{ type: "text", text: `Error connecting to PoB: ${msg}\nLaunch PoB via LaunchPoBWithAPI.bat, then retry.` }],
        isError: true,
      };
    }
    const luaClient = context.getLuaClient();
    if (!luaClient) {
      return {
        content: [{ type: "text", text: "Error: PoB Lua client not initialized — can't read the equipped item." }],
        isError: true,
      };
    }
    let items: Array<{ slot?: string; name?: string; baseName?: string; type?: string; raw?: string }>;
    try {
      items = (await luaClient.getItems()) as typeof items;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return {
        content: [{ type: "text", text: `Error reading equipped items: ${msg}` }],
        isError: true,
      };
    }
    const wanted = args.item_slot.toLowerCase();
    const item = items.find((it) => it.slot && it.slot.toLowerCase() === wanted && it.name);
    if (!item) {
      const occupied = items.filter((it) => it.name).map((it) => it.slot).join(", ");
      return {
        content: [{ type: "text", text: `No item found in slot "${args.item_slot}". Occupied slots: ${occupied || "(none)"}.` }],
      };
    }
    // Convert raw mods to tagged lines (only explicit/crafted/fractured —
    // implicit/enchant aren't natural prefix/suffix mods).
    const parsed = parseItemRawMods(item.raw);
    const usable = parsed.filter((m) => ["explicit", "crafted", "fractured"].includes(m.type));
    modLines = usable.map((m) => {
      if (m.type === "crafted") return `${m.line} {crafted}`;
      if (m.type === "fractured") return `${m.line} {fractured}`;
      return m.line;
    });
    // Auto-derive base + ilvl from the live item unless explicitly overridden.
    if (!resolvedBaseName && item.baseName) resolvedBaseName = item.baseName;
    if (resolvedIlvl === undefined) resolvedIlvl = parseItemLevel(item.raw);
    liveItemNote = `Read "${item.name}" from slot "${item.slot}" (${item.baseName ?? item.type ?? "?"})`;
  }

  if (!Array.isArray(modLines) || modLines.length === 0 || modLines.some(line => typeof line !== "string")) {
    return {
      content: [
        {
          type: "text",
          text:
            "Error: provide either mod_lines (array of prefix/suffix text) or " +
            "item_slot (to read a live equipped item via PoB). " +
            "Example mod_lines: ['+150 to maximum Life', '+45% to Fire Resistance'].",
        },
      ],
      isError: true,
    };
  }

  // Resolve the base (optional) — gives us the tag chain for accurate matching.
  let base: PobBase | null = null;
  let baseSuggestions: string[] = [];
  if (resolvedBaseName) {
    base = getBase(resolvedBaseName);
    if (!base) {
      const matches = findBasesMatching(resolvedBaseName, 5);
      baseSuggestions = matches.map((b) => b.name);
    }
  }
  const itemTags = base?.tags;
  const ilvl = resolvedIlvl;
  if (game === "poe2" && base && ["jewel", "flask", "fishing", "incursionlimb", "tincture"].includes(base.sourceFile)) {
    return { content: [{ type: "text", text: `PoE2 coverage gap: ${base.type} uses a separate modifier pool; ordinary ModItem matching is not applicable.` }], isError: true };
  }

  // Per-line analysis pass
  const analyses: LineAnalysis[] = modLines.map((raw, i) => {
    const { text, source } = cleanLine(raw);
    if (text.length === 0) {
      return { inputLine: i + 1, raw, cleaned: "", source, match: null };
    }
    // Natural and fractured both come from the prefix/suffix pool.
    if (source === "natural" || source === "fractured") {
      const m = game === "poe2" ? nativeMatch(text, itemTags, ilvl) : matchStatLine(text, { itemTags, ilvl });
      return { inputLine: i + 1, raw, cleaned: text, source, match: m };
    }
    // Crafted lines come from the bench (ModMaster.lua). Match against it
    // using the base's item TYPE (e.g. "Body Armour"), not the tag chain.
    if (source === "crafted") {
      if (game === "poe2") return { inputLine: i+1, raw, cleaned: text, source, match: null,
        coverageGap: "PoE2 crafted annotations do not establish a PoE1 bench craft; no equivalent bench source is validated." };
      try {
        const mc = matchMasterCraft(text, base?.type);
        return { inputLine: i + 1, raw, cleaned: text, source, match: null, masterMatch: mc };
      } catch (error) {
        return { inputLine: i+1, raw, cleaned: text, source, match: null,
          coverageGap: `Bench source unavailable: ${error instanceof Error ? error.message : String(error)}` };
      }
    }
    // Enchanted (lab) mods aren't indexed here.
    return { inputLine: i + 1, raw, cleaned: text, source, match: null };
  });

  // Collapse hybrid mods: if line N and line N+1 both matched the same
  // mod ID, mark N+1 as a hybrid continuation. Multi-line mods (e.g.
  // life+armour, life+es) appear as two adjacent stat lines on the item
  // and would otherwise be reported twice.
  for (let i = 0; i < analyses.length; i++) {
    const first = analyses[i];
    const templates = first.match?.best?.statLines ?? [];
    if (templates.length < 2 || i + templates.length > analyses.length) continue;
    const continuation = templates.slice(1).every((template,j) => {
      const next = analyses[i+j+1];
      return next.source === first.source && normalizeStatLine(next.cleaned) === normalizeStatLine(template) &&
        rolledValuesFitTemplate(parseRolledValues(next.cleaned), template);
    });
    if (!continuation) continue;
    for (let j = 1; j < templates.length; j++) {
      analyses[i+j].match = first.match;
      analyses[i+j].isHybridContinuation = true;
    }
    i += templates.length-1;
  }

  if (args.raw_json) {
    const json = {
      game,
      source: getModItemPath(),
      weight_semantics: game === "poe2" ? "eligibility-only" : "spawn-weight",
      tier_basis: "Highest minimum item level first within the compatible native mod group; T1 is not re-ranked at the supplied ilvl.",
      ...(game === "poe2" ? { affix_budget: { complete: false, reason: "Text lines may be partial or hybrid; they do not establish open affix slots." } } : {}),
      base: base
        ? { name: base.name, type: base.type, tags: base.tags, implicit: base.implicit }
        : null,
      base_suggestions: baseSuggestions,
      ilvl,
      lines: analyses.map((a) => ({
        input_line: a.inputLine,
        raw: a.raw,
        cleaned: a.cleaned,
        source: a.source,
        is_hybrid_continuation: a.isHybridContinuation ?? false,
        coverage_gap: a.coverageGap ?? null,
        match: a.match
          ? {
              best: a.match.best
                ? {
                    id: a.match.best.id,
                    type: a.match.best.type,
                    affix: a.match.best.affix,
                    level: a.match.best.level,
                    group: a.match.best.group,
                    statLines: a.match.best.statLines,
                  }
                : null,
              tier: a.match.tier,
              tier_max: a.match.tierMax,
              next_tier: a.match.nextTier
                ? {
                    id: a.match.nextTier.id,
                    affix: a.match.nextTier.affix,
                    level: a.match.nextTier.level,
                    statLines: a.match.nextTier.statLines,
                  }
                : null,
              candidate_count: a.match.candidates.length,
              meaningful_candidate_count: a.match.meaningfulCandidateCount,
            }
          : null,
        master_craft: a.masterMatch
          ? {
              type: a.masterMatch.type,
              affix: a.masterMatch.affix,
              level: a.masterMatch.level,
              group: a.masterMatch.group,
              statLines: a.masterMatch.statLines,
            }
          : null,
      })),
    };
    return { content: [{ type: "text", text: JSON.stringify(json, null, 2) }] };
  }

  // Human-readable output
  const lines: string[] = [];
  lines.push("=== Item Mod Analysis ===");
  lines.push(`Game: ${game} | source: ${getModItemPath()}`);
  if (game === "poe2") lines.push("PoB2 weights express eligibility only, not probabilities. Tier order is source minimum-level order.");
  if (liveItemNote) lines.push(liveItemNote);
  if (base) {
    lines.push(`Base: ${base.name} (${base.type}${base.subType ? `, ${base.subType}` : ""})`);
    lines.push(`Tags used for matching: ${base.tags.join(", ")}`);
  } else if (resolvedBaseName) {
    lines.push(`Base "${resolvedBaseName}" not found — matching without tag gating.`);
    if (baseSuggestions.length > 0) {
      lines.push(`Did you mean: ${baseSuggestions.join(", ")}?`);
    }
  } else {
    lines.push(`No base supplied — matching without tag gating (accuracy reduced).`);
    lines.push(`Pass base_name or item_slot for a class-specific tier ladder.`);
  }
  if (ilvl !== undefined) lines.push(`ilvl: ${ilvl}`);
  lines.push("");

  // Group prefixes and suffixes separately for output
  const prefixes: LineAnalysis[] = [];
  const suffixes: LineAnalysis[] = [];
  const other: LineAnalysis[] = [];
  for (const a of analyses) {
    if (a.cleaned === "") continue;
    if (a.isHybridContinuation) continue;
    const t = (a.match?.best?.type ?? a.masterMatch?.type)?.toLowerCase();
    if (t === "prefix") prefixes.push(a);
    else if (t === "suffix") suffixes.push(a);
    else other.push(a);
  }

  function formatOne(a: LineAnalysis): string[] {
    const out: string[] = [];
    out.push(`  Line ${a.inputLine}: ${a.raw}`);
    if (a.source !== "natural") out.push(`    Source: ${a.source}`);
    // Bench-crafted line: report the master craft if we matched one.
    if (a.source === "crafted") {
      if (a.coverageGap) { out.push(`    Coverage gap: ${a.coverageGap}`); return out; }
      if (a.masterMatch) {
        const mc = a.masterMatch;
        out.push(`    -> bench craft "${mc.affix}" [${mc.type}] L${mc.level} group=${mc.group} → ${mc.statLines.join(" / ")}`);
      } else {
        out.push(`    Match: (bench-craft text not found in ModMaster.lua${base ? "" : " — supply base_name to match by item type"})`);
      }
      return out;
    }
    if (!a.match || !a.match.best) {
      out.push(`    Match: (none — line text did not match any natural prefix/suffix template)`);
      return out;
    }
    const m = a.match.best;
    out.push(`    -> ${m.id} "${m.affix || "?"}" [${m.type}]  L${m.level}  group=${m.group}`);
    if (a.match.tier && a.match.tierMax) {
      out.push(`    Tier: ${a.match.tier} of ${a.match.tierMax} naturally-rollable in this group${itemTags ? " on this base" : ""}`);
    }
    if (a.match.nextTier) {
      const nt = a.match.nextTier;
      out.push(`    Next tier: ${nt.id} "${nt.affix}" L${nt.level} → ${nt.statLines.join(" / ")}`);
    } else if (a.match.tier === 1) {
      out.push(`    Next tier: (already top tier${itemTags ? " on this base" : ""})`);
    } else {
      out.push("    Next tier: (not established for this source/base)");
    }
    if (a.match.meaningfulCandidateCount > 1) {
      out.push(`    Ambiguous: ${a.match.meaningfulCandidateCount} naturally-rollable mods fit this value; best chosen by tier + weight. Supply base_name/ilvl to narrow.`);
    }
    return out;
  }

  if (prefixes.length > 0) {
    lines.push(`--- PREFIXES (${prefixes.length}) ---`);
    for (const a of prefixes) lines.push(...formatOne(a));
    lines.push("");
  }
  if (suffixes.length > 0) {
    lines.push(`--- SUFFIXES (${suffixes.length}) ---`);
    for (const a of suffixes) lines.push(...formatOne(a));
    lines.push("");
  }
  if (other.length > 0) {
    lines.push(`--- UNCLASSIFIED (${other.length}) — ⚠ these still occupy affix slots ---`);
    for (const a of other) lines.push(...formatOne(a));
    lines.push("");
  }

  // Affix-budget summary. "Unclassified" means we couldn't match the line to a
  // natural/bench template (special mods, influence-only mods, incursion/synth text,
  // lab enchants read from pasted text) — it does NOT mean the line is free: except
  // for implicits and lab enchants, every explicit line occupies a prefix or suffix.
  // Field-hit 2026-08-19: a special glove mod ("Minions convert 100% of Fire Damage
  // to Chaos Damage") landed in UNCLASSIFIED, the caller counted only the classified
  // lines, concluded "two open prefixes", and recommended an Exalt slam on an item
  // the game correctly reports as FULL. State the budget explicitly so open-affix
  // counts are read from here, not inferred.
  if (game === "poe1") {
    const enchantedOther = other.filter((a) => a.source === "enchanted").length;
    const occupyingOther = other.length - enchantedOther;
    const explicitCount = prefixes.length + suffixes.length + occupyingOther;
    lines.push("Affix budget (rare: max 3 prefixes + 3 suffixes):");
    lines.push(`  Classified: ${prefixes.length} prefix(es), ${suffixes.length} suffix(es).`);
    if (occupyingOther > 0) {
      lines.push(
        `  ⚠ Plus ${occupyingOther} unclassified explicit line(s) of UNKNOWN affix type — each occupies a` +
        ` prefix OR suffix slot. Open-slot count is therefore AMBIGUOUS: between` +
        ` ${Math.max(0, 3 - prefixes.length - occupyingOther)} and ${Math.max(0, 3 - prefixes.length)} prefixes` +
        ` and between ${Math.max(0, 3 - suffixes.length - occupyingOther)} and ${Math.max(0, 3 - suffixes.length)} suffixes` +
        ` may be open. Verify in game (hold Alt) before spending currency on an "open" slot.`
      );
    } else {
      lines.push(`  Open on a rare: ${Math.max(0, 3 - prefixes.length)} prefix(es), ${Math.max(0, 3 - suffixes.length)} suffix(es).`);
    }
    if (explicitCount >= 6) {
      lines.push(`  Item has ${explicitCount} explicit mods — FULL. No currency can add a mod.`);
    }
  } else lines.push("Affix slots are not inferred from text lines: omitted mods, hybrid lines and special sources can change the count. One-step odds require the complete existing modifier IDs.");

  const craftedCount = analyses.filter((a) => a.source === "crafted").length;
  const fracturedCount = analyses.filter((a) => a.source === "fractured").length;
  const enchantedCount = analyses.filter((a) => a.source === "enchanted").length;
  const hybridCount = analyses.filter((a) => a.isHybridContinuation).length;

  if (craftedCount + fracturedCount + enchantedCount + hybridCount > 0) {
    lines.push("Notes:");
    if (craftedCount > 0) lines.push(game === "poe2" ? `  - ${craftedCount} crafted annotation(s) with unresolved PoE2 source.` : `  - ${craftedCount} bench-crafted mod(s) — matched against ModMaster.lua (the bench-craft pool, deterministic; no tiers/weights).`);
    if (fracturedCount > 0) lines.push(`  - ${fracturedCount} fractured mod(s) detected — frozen at the rolled value but otherwise from the natural pool.`);
    if (enchantedCount > 0) lines.push(`  - ${enchantedCount} enchanted mod(s) — enchantment sources are not indexed by this handler.`);
    if (hybridCount > 0) lines.push(`  - ${hybridCount} hybrid-mod continuation line(s) collapsed into the mod above them.`);
  }

  return { content: [{ type: "text", text: lines.join("\n") }] };
}
