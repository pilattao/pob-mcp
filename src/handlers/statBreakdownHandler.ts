/**
 * Handler for the get_stat_breakdown MCP tool.
 *
 * Calls the live PoB `get_stat_breakdown` Lua action, which tabulates every
 * modifier contributing to a stat (with its source), then makes the raw
 * source strings human-readable — notably resolving "Tree:<nodeId>" into the
 * passive node's name via the tree-data loader.
 *
 * This answers "WHY is my <stat> the value it is — what's contributing and
 * from where?" instead of just "what is my <stat>". Tabulate evaluates
 * conditions in the chosen actor/skill store for one modifier name. A nil
 * skill config does not disable actor conditions or guarantee completeness.
 */

import type { AnyLuaClient } from "../pobLuaBridge.js";
import { getPobTreeData, getLoadedSource } from "../services/pobTreeDataLoader.js";

export interface StatBreakdownContext {
  getLuaClient: () => AnyLuaClient | null;
  ensureLuaClient: () => Promise<void>;
}

interface Contribution {
  modType: string;
  value: number | boolean | string;
  source: string;
  name: string;
  flags: number;
}

interface BreakdownResult {
  stat: string;
  actor: string;
  config?: "global" | "skill";
  config_note?: string;
  output_value?: number | boolean | string | null;
  inc_sum?: number | null;
  more_multiplier?: number | null;
  contributions: Contribution[];
}

interface SourceContext {
  game: string | null;
  treeVersion: string | null;
  notes: string[];
}

async function readBuildInfo(client: AnyLuaClient): Promise<Record<string, unknown> | null> {
  try {
    if (typeof client.getBuildInfo !== 'function') return null;
    const info = await client.getBuildInfo();
    return info && typeof info === 'object' ? info : null;
  } catch { return null; } // Naming metadata is optional, native contributions are not.
}

function sourceContext(info: Record<string, unknown> | null): SourceContext {
  const treeVersion = typeof info?.treeVersion === 'string' && /^\d+_\d+$/.test(info.treeVersion) ? info.treeVersion : null;
  const treeGame = treeVersion?.startsWith('0_') ? 'poe2' : treeVersion?.startsWith('3_') ? 'poe1' : null;
  const game = typeof info?.game === 'string' ? info.game : treeGame;
  const expected = process.env.POE_GAME;
  if ((game && treeGame && game !== treeGame) || (expected && game && expected !== game)) {
    throw new Error(`Conflicting PoE2/PoE1 source provenance: mode=${expected ?? 'unspecified'}, native game=${game}, tree=${treeVersion ?? 'unknown'}.`);
  }
  return { game, treeVersion, notes: [] };
}

/** Resolve names once, against the live build's exact version. Never guess latest. */
function passiveNames(contributions: Contribution[], context: SourceContext): Map<string, string> {
  const ids = new Set(contributions.flatMap(c => /^Tree:(\d+)$/.exec(c.source)?.[1] ?? []));
  const names = new Map<string, string>();
  if (!ids.size) return names;
  if (!context.treeVersion) {
    context.notes.push('Passive names unavailable: active tree version is unknown; raw node IDs are preserved.');
    return names;
  }
  try {
    // An explicit 0_* version also blocks the loader's PoE1 fallback when
    // POE_GAME is unset but get_build_info identifies a PoE2 build.
    const tree = getPobTreeData(context.treeVersion);
    if (getLoadedSource() !== 'pob-tree-lua') throw new Error('Unversioned fallback cannot establish current passive names');
    for (const id of ids) {
      const name = tree.nodes[id]?.name;
      if (name) names.set(id, name);
    }
    if (names.size < ids.size) context.notes.push('Some passive names are unavailable in the active static tree; raw IDs are preserved, including any dynamic nodes.');
  } catch {
    context.notes.push(`Passive names unavailable for tree ${context.treeVersion}; raw IDs are preserved. No names from another version or game are substituted.`);
  }
  return names;
}

/**
 * Make a PoB mod `source` string readable. Known shapes:
 *   "Tree:12345"        -> "Passive: <node name> (12345)"
 *   "Item:5:<name>"     -> "Item: <name> (item 5)" (item ID, not slot index)
 *   "Item"              -> "Item"
 *   "Config"            -> "Config"
 *   "Base"              -> "Base"
 *   "Skill:..."         -> "Skill: ..."
 * Falls back to the raw string for anything unrecognized.
 */
function humanizeSource(source: string, names: Map<string, string>): string {
  if (!source) return "?";
  if (source.startsWith("Tree:")) {
    const id = source.slice(5);
    const name = names.get(id);
    if (name) return `Passive: ${name} (${id})`;
    return `Passive node ${id}`;
  }
  if (source === "Base") return "Base (innate)";
  if (source === "Config") return "Config (PoB settings)";
  // Classes/Item.lua sets modSource to Item:<item.id>:<item.name>.
  const item = /^Item:(-?\d+):(.*)$/s.exec(source);
  if (item) return `Item: ${item[2] || '(name unavailable)'} (item ${item[1]})`;
  if (/^Item:-?\d+$/.test(source)) return `Item ${source.slice(5)} (name unavailable)`;
  if (source.startsWith('Item:')) return `Item: ${source.slice(5)}`;
  if (source.startsWith("Skill:")) return `Skill: ${source.slice(6)}`;
  return source;
}

/** Sign-aware formatting of a contribution value for display. */
function formatValue(modType: string, value: number | boolean | string): string {
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "string") return value;
  // numeric
  if (modType === "INC") return `${value > 0 ? "+" : ""}${value}%`;
  if (modType === "MORE") return value < 0 ? `${-value}% less` : `${value > 0 ? "+" : ""}${value}% more`;
  if (modType === "BASE") return `${value > 0 ? "+" : ""}${value}`;
  return String(value);
}

export interface StatBreakdownArgs {
  stat: string;
  actor?: "player" | "minion";
  use_skill_config?: boolean;
  raw_json?: boolean;
}

export async function handleGetStatBreakdown(
  context: StatBreakdownContext,
  args: StatBreakdownArgs
) {
  if (typeof args.stat !== "string" || !args.stat.trim()) {
    return {
      content: [
        {
          type: "text",
          text:
            "Error: stat is required — a PoB modifier name like 'Life', " +
            "'FireResist', 'Str', 'Armour', 'EnergyShield', " +
            "'LifeRegen', 'Evasion', 'ChaosResist'. (This is the mod " +
            "NAME, not always the same as a displayed stat label.)",
        },
      ],
      isError: true,
    };
  }

  try {
    await context.ensureLuaClient();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      content: [
        {
          type: "text",
          text: `Error connecting to PoB: ${msg}\nThis tool needs a live PoB build — launch via LaunchPoBWithAPI.bat, then retry.`,
        },
      ],
      isError: true,
    };
  }

  const client = context.getLuaClient();
  if (!client) {
    return {
      content: [{ type: "text", text: "Error: PoB Lua client not initialized." }],
      isError: true,
    };
  }

  let result: BreakdownResult;
  let sources: SourceContext;
  try {
    const before = await readBuildInfo(client);
    sources = sourceContext(before);
    result = (await client.getStatBreakdown({
      stat: args.stat,
      actor: args.actor,
      use_skill_config: args.use_skill_config,
    })) as BreakdownResult;
    if (!result || typeof result.stat !== 'string' || typeof result.actor !== 'string' ||
      !Array.isArray(result.contributions) || result.contributions.some(c => !c ||
        typeof c.modType !== 'string' || typeof c.source !== 'string' ||
        !['number', 'boolean', 'string'].includes(typeof c.value) ||
        (typeof c.value === 'number' && !Number.isFinite(c.value)))) {
      throw new Error('Malformed native stat breakdown; contribution data is unavailable.');
    }
    if (result.actor !== (args.actor ?? 'player')) throw new Error('Native breakdown actor does not match the requested actor.');
    if (result.contributions.some(c => c.source.startsWith('Tree:')) && before) {
      const after = await readBuildInfo(client);
      const afterContext = sourceContext(after);
      if (!after || before.name !== after.name || sources.game !== afterContext.game || sources.treeVersion !== afterContext.treeVersion) {
        sources.treeVersion = null;
        sources.notes.push('Active build metadata changed or became unavailable during the query; passive names are not resolved.');
      }
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      content: [{ type: "text", text: `Error reading stat breakdown: ${msg}` }],
      isError: true,
    };
  }

  const contributions = result.contributions;
  const names = passiveNames(contributions, sources);

  if (args.raw_json) {
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            {
              ...result,
              source_context: sources,
              contributions: contributions.map((c) => ({
                ...c,
                sourceHuman: humanizeSource(c.source, names),
              })),
            },
            null,
            2
          ),
        },
      ],
    };
  }

  const lines: string[] = [];
  lines.push(`=== Breakdown: ${result.stat} (${result.actor}) ===`);
  lines.push(`Source game: ${sources.game ?? 'unknown'}; active tree version: ${sources.treeVersion ?? 'unknown'}`);
  lines.push(...sources.notes);
  if (result.config === "skill") {
    lines.push(`Config: main skill${result.config_note ? ` (${result.config_note})` : ""} — eligible modifiers in this skill's configuration`);
  } else if (result.config === 'global') {
    lines.push('Config: global (actor modDB, no skill config; active actor conditions can still apply)');
  } else {
    lines.push('Config: unavailable from the native response');
  }
  if (result.output_value !== undefined && result.output_value !== null) {
    lines.push(`Current output value: ${result.output_value}`);
  } else {
    lines.push('Current output value: unavailable for this key (modifier names and output keys may differ)');
  }
  lines.push(`Native INC sum: ${typeof result.inc_sum === 'number' && Number.isFinite(result.inc_sum) ? formatValue('INC', result.inc_sum) : 'unavailable'}`);
  lines.push(`Native MORE multiplier: ${typeof result.more_multiplier === 'number' && Number.isFinite(result.more_multiplier) ? result.more_multiplier : 'unavailable'}`);
  lines.push('Scope: a single modifier name in the native store. Aggregates and listed contributions are not a reconstruction of the final output; use get_calc_breakdown for the calculation chain.');
  lines.push("");

  if (contributions.length === 0) {
    lines.push("No contributing modifiers returned for this query.");
    lines.push("");
    lines.push(
      "If you expected contributions, the stat name probably differs from " +
        "PoB's internal mod name. Common traps: resistances are the SHORT " +
        "form 'FireResist'/'ColdResist'/'LightningResist'/'ChaosResist' (NOT " +
        "'...Resistance'); attributes are 'Str'/'Dex'/'Int' (NOT " +
        "'Strength'/'Dexterity'/'Intelligence'). Modifier names " +
        "include Life, Mana, EnergyShield, Armour, Evasion, LifeRegen, " +
        "ManaRegen, MovementSpeed, CritChance, CritMultiplier. Skill-" +
        "conditional contributions may require use_skill_config; empty " +
        "results do not establish that an effect is absent from the build."
    );
    return { content: [{ type: "text", text: lines.join("\n") }] };
  }

  // Group by mod type for readability: BASE, INC, MORE, OVERRIDE, FLAG
  const order = ["BASE", "INC", "MORE", "OVERRIDE", "FLAG"];
  const byType = new Map<string, Contribution[]>();
  for (const c of contributions) {
    const arr = byType.get(c.modType) ?? [];
    arr.push(c);
    byType.set(c.modType, arr);
  }

  const typeLabel: Record<string, string> = {
    BASE: "Flat / base additions (added together)",
    INC: "Increased / reduced (additive %, summed then applied)",
    MORE: "More / less (multiplicative %)",
    OVERRIDE: "Overrides (replace the value)",
    FLAG: "Flags (on/off effects)",
  };

  for (const t of [...order, ...[...byType.keys()].filter(t => !order.includes(t))]) {
    const arr = byType.get(t);
    if (!arr || arr.length === 0) continue;
    // Sum numeric values for a quick subtotal where meaningful
    const numericSum = arr.reduce((acc, c) => acc + (typeof c.value === "number" ? c.value : 0), 0);
    const subtotal =
      t === "BASE" ? `  (listed sum: ${numericSum})` :
      t === "INC" ? `  (listed sum: ${numericSum > 0 ? "+" : ""}${numericSum}%)` :
      "";
    lines.push(`--- ${t} — ${typeLabel[t] ?? t}${subtotal} ---`);
    // Sort by descending absolute value so the biggest contributors lead
    arr.sort((a, b) => Math.abs(Number(b.value) || 0) - Math.abs(Number(a.value) || 0));
    for (const c of arr) {
      lines.push(`  ${formatValue(c.modType, c.value)}  ←  ${humanizeSource(c.source, names)}`);
    }
    lines.push("");
  }

  if (result.config === "skill") {
    lines.push(
      "Note: tabulated against the MAIN skill's modList + config. Native flags, " +
        "conditions and scaling affect the returned values. This is per-modifier SOURCE attribution " +
        "(which passives/items/gems contribute) — it is NOT the skill's total " +
        "increased/more multiplier. For the actual applied multiplier chain " +
        "(base→inc→more→crit→ailment→total) use get_calc_breakdown."
    );
  } else {
    lines.push(
      "Note: the query covers eligible modifiers for this name and configuration. " +
        "Actor conditions, caps, conversions and other modifier names can affect " +
        "the final output. For skill-specific sources, pass use_skill_config; " +
        "use get_calc_breakdown for the full chain."
    );
  }

  return { content: [{ type: "text", text: lines.join("\n") }] };
}
