/**
 * Character-data cache tools.
 *
 * These tools mechanize the two hand-maintained bridges between live PoB state
 * and the poe_mcp_suite character_data/ cache:
 *
 *  - compute_constraint_margins — fills the Current/Margin columns of a
 *    build-profile.md Section 6 (Constraint Status) table from live stats.
 *  - sync_character_cache — refreshes meta.json current_stats (and optionally
 *    inventory.json equipped/flask entries) from the loaded build.
 *
 * Both are read-mostly: they never touch narrative files (build.md, journal.md)
 * and preserve any JSON keys / markdown content they don't understand.
 */

import fs from "fs/promises";
import path from "path";
import { wrapHandler } from "../utils/errorHandling.js";
import { parseItemRawMods } from "../utils/itemRawParser.js";
import type { LuaHandlerContext } from "./luaHandlers.js";

// ---------------------------------------------------------------------------
// Stat-name mapping (profile table row label -> PoB output stat field)
// ---------------------------------------------------------------------------

interface StatRule {
  pattern: RegExp;
  field: string;
  /** Companion overcap field, appended to Notes-worthy output. */
  overcapField?: string;
  fallbackField?: string;
}

// Order matters: more specific patterns must precede generic ones
// ("spell block" before "block", "mana (unreserved)" before "mana").
const STAT_RULES: StatRule[] = [
  { pattern: /spirit.*unreserved|unreserved.*spirit/i, field: "SpiritUnreserved" },
  { pattern: /\bspirit\b/i, field: "Spirit" },
  { pattern: /fire\s*res/i, field: "FireResist", overcapField: "FireResistOverCap" },
  { pattern: /cold\s*res/i, field: "ColdResist", overcapField: "ColdResistOverCap" },
  { pattern: /light(ning)?\s*res/i, field: "LightningResist", overcapField: "LightningResistOverCap" },
  { pattern: /chaos\s*res/i, field: "ChaosResist", overcapField: "ChaosResistOverCap" },
  { pattern: /spell\s*suppress/i, field: "EffectiveSpellSuppressionChance", fallbackField: "SpellSuppressionChance" },
  { pattern: /spell\s*block/i, field: "SpellBlockChance" },
  { pattern: /block/i, field: "BlockChance" },
  { pattern: /mana.*unreserved|unreserved.*mana/i, field: "ManaUnreserved" },
  { pattern: /life.*unreserved|unreserved.*life/i, field: "LifeUnreserved" },
  { pattern: /life\s*regen/i, field: "LifeRegen" },
  { pattern: /mana\s*regen/i, field: "ManaRegen" },
  { pattern: /energy\s*shield|\bes\b/i, field: "EnergyShield" },
  { pattern: /\blife\b/i, field: "Life" },
  { pattern: /\bmana\b/i, field: "Mana" },
  { pattern: /hit\s*chance/i, field: "HitChance" },
  { pattern: /crit(ical)?\s*(strike\s*)?chance/i, field: "CritChance" },
  { pattern: /crit(ical)?\s*(strike\s*)?multi/i, field: "CritMultiplier" },
  { pattern: /accuracy/i, field: "MainHandAccuracy" },
  { pattern: /\behp\b|effective\s*hp/i, field: "TotalEHP" },
  { pattern: /armour|armor/i, field: "Armour" },
  { pattern: /evasion/i, field: "Evasion" },
  { pattern: /phys(ical)?\s*(dmg|damage)\s*red/i, field: "PhysicalDamageReduction" },
  { pattern: /str(ength)?\b/i, field: "Str" },
  { pattern: /dex(terity)?\b/i, field: "Dex" },
  { pattern: /int(elligence)?\b/i, field: "Int" },
  { pattern: /attack\s*dodge/i, field: "AttackDodgeChance" },
  { pattern: /spell\s*dodge/i, field: "SpellDodgeChance" },
  { pattern: /ward/i, field: "Ward" },
];

function mapStatToField(statLabel: string): StatRule | null {
  // Compound/status rows such as "Reserved Life+Mana" name more than one stat and
  // are not a single measurable quantity — don't let the generic \blife\b / \bmana\b
  // patterns force a (misleading) numeric current onto them. Qualified single-concept
  // rows like "Life (unreserved)" / "Mana (unreserved)" mention only one of the two,
  // so they still map correctly.
  if (/\blife\b/i.test(statLabel) && /\bmana\b/i.test(statLabel)) return null;

  for (const rule of STAT_RULES) {
    if (rule.pattern.test(statLabel)) return rule;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Threshold parsing
// ---------------------------------------------------------------------------

interface ParsedThreshold {
  cmp: ">=" | ">" | "<=" | "<";
  value: number;
  pct: boolean;
}

/** Parse "≥75%", ">0", "100%", "≥150". Returns null for non-numeric thresholds
 *  ("present", "build-specific", "gem/gear req", "—", ""). */
function parseThreshold(raw: string): ParsedThreshold | null {
  // Strip thousands separators so "≥3,500" parses like "≥3500".
  const t = raw.trim().replace(/,/g, "");
  const m = t.match(/^(≥|>=|≤|<=|>|<)?\s*(-?\d+(?:\.\d+)?)\s*(%)?$/);
  if (!m) return null;
  const cmpMap: Record<string, ParsedThreshold["cmp"]> = {
    "≥": ">=", ">=": ">=", "≤": "<=", "<=": "<=", ">": ">", "<": "<",
  };
  return {
    cmp: m[1] ? cmpMap[m[1]] : ">=", // bare number = floor
    value: Number(m[2]),
    pct: !!m[3],
  };
}

function formatNumber(v: number): string {
  return Number.isInteger(v) ? String(v) : String(Math.round(v * 100) / 100);
}

function formatMargin(margin: number, pct: boolean): string {
  const sign = margin > 0 ? "+" : "";
  return `${sign}${formatNumber(margin)}${pct ? "%" : ""}`;
}

// ---------------------------------------------------------------------------
// compute_constraint_margins
// ---------------------------------------------------------------------------

const TABLE_HEADER_RE = /^\|\s*Stat\s*\|\s*Tier\s*\|\s*Threshold\s*\|\s*Current\s*\|\s*Margin\s*\|\s*Notes\s*\|\s*$/i;

interface MarginRow {
  stat: string;
  tier: string;
  threshold: string;
  current: string;
  margin: string;
  notes: string;
  status: "ok" | "warn" | "violated" | "manual";
}

export async function handleComputeConstraintMargins(
  context: LuaHandlerContext,
  profilePath: string,
  writeBack: boolean = false
) {
  return wrapHandler("compute constraint margins", async () => {
    if (!profilePath?.trim()) throw new Error("profile_path is required");
    const resolved = path.resolve(profilePath);
    if (!resolved.endsWith(".md")) throw new Error("profile_path must point to a .md file (build-profile.md)");

    const original = await fs.readFile(resolved, "utf-8");
    const lines = original.split(/\r?\n/);

    // Locate the Section 6 constraint table by its exact header.
    const headerIdx = lines.findIndex((l) => TABLE_HEADER_RE.test(l));
    if (headerIdx === -1) {
      throw new Error(
        "No Constraint Status table found. Expected a markdown table with header " +
          "'| Stat | Tier | Threshold | Current | Margin | Notes |' (build-profile-format.md Section 6)."
      );
    }

    // First pass: identify the table's data rows and which PoB stat each needs.
    interface RowMeta {
      lineIdx: number;
      cells: string[];
      stat: string;
      tier: string;
      threshold: string;
      notes: string;
      rule: StatRule | null;
      parsedThreshold: ParsedThreshold | null;
    }
    const rowMetas: RowMeta[] = [];
    for (let i = headerIdx + 2; i < lines.length; i++) {
      const line = lines[i];
      if (!line.trim().startsWith("|")) break;

      const cells = line.split("|").map((c) => c.trim());
      // split("|") on "| a | b |" yields ["", "a", "b", ""] — cells[1..6]
      if (cells.length < 8) continue; // malformed row — leave untouched
      rowMetas.push({
        lineIdx: i,
        cells,
        stat: cells[1],
        tier: cells[2],
        threshold: cells[3],
        notes: cells[6],
        rule: mapStatToField(cells[1]),
        parsedThreshold: parseThreshold(cells[3]),
      });
    }
    if (rowMetas.length === 0) throw new Error("Constraint table found but contains no data rows.");

    // Collect exactly the fields the mapped rows need. getStats() with no field
    // list returns only PoB's base output set — derived stats (unreserved
    // life/mana, resist overcaps, hit chance, attributes) are omitted unless
    // requested explicitly, so relying on the no-arg call silently blanks them.
    const neededFields = new Set<string>();
    for (const rm of rowMetas) {
      if (!rm.rule) continue;
      neededFields.add(rm.rule.field);
      if (rm.rule.overcapField) neededFields.add(rm.rule.overcapField);
      if (rm.rule.fallbackField) neededFields.add(rm.rule.fallbackField);
    }

    await context.ensureLuaClient();
    const luaClient = context.getLuaClient();
    if (!luaClient) throw new Error("Lua client not initialized. Use lua_start first.");
    const stats = await luaClient.getStats(neededFields.size ? [...neededFields] : undefined);

    const readStat = (rule: StatRule): number | undefined => {
      let v = stats[rule.field];
      if ((v == null || v === "") && rule.fallbackField) v = stats[rule.fallbackField];
      if (typeof v !== "number" && typeof v !== "string") return undefined;
      const n = Number(v);
      return String(v).trim() === "" || !Number.isFinite(n) ? undefined : n;
    };

    const rows: MarginRow[] = [];
    for (const rm of rowMetas) {
      const { stat, tier, threshold, notes, rule, parsedThreshold } = rm;
      const i = rm.lineIdx;
      const cells = rm.cells;
      const nativeValue = rule ? readStat(rule) : undefined;
      // CalcSections displays CritMultiplier as xN. A percent threshold instead
      // expresses the same total multiplier as N*100%; this is not crit bonus.
      const currentVal = nativeValue === undefined ? undefined
        : nativeValue * (rule?.field === 'CritMultiplier' && parsedThreshold?.pct ? 100 : 1);

      let current = "—";
      let margin = "—";
      let status: MarginRow["status"] = "manual";

      if (currentVal !== undefined) {
        const pct = parsedThreshold?.pct ?? /%/.test(threshold);
        current = `${formatNumber(currentVal)}${pct ? "%" : ""}`;
        if (parsedThreshold) {
          const t = parsedThreshold;
          const rawMargin =
            t.cmp === ">=" || t.cmp === ">" ? currentVal - t.value : t.value - currentVal;
          margin = formatMargin(rawMargin, t.pct);
          const violated =
            t.cmp === ">" || t.cmp === "<" ? rawMargin <= 0 : rawMargin < 0;
          const nearFloor = !violated && rawMargin <= Math.max(5, Math.abs(t.value) * 0.05);
          status = violated ? "violated" : nearFloor ? "warn" : "ok";

          // Surface overcap alongside resistances — it's the spendable part.
          if (rule?.overcapField) {
            const over = Number(stats[rule.overcapField]);
            if (!Number.isNaN(over) && over > 0 && !violated) {
              margin = `${margin} (+${formatNumber(over)}% overcap)`;
            }
          }
        }
      }

      rows.push({ stat, tier, threshold, current, margin, notes, status });

      // Rewrite Current/Margin cells in place, preserving everything else.
      const newCells = [...cells];
      newCells[4] = ` ${current} `;
      newCells[5] = ` ${margin} `;
      // Re-pad the pass-through cells so join stays readable.
      for (const idx of [1, 2, 3, 6]) newCells[idx] = ` ${cells[idx]} `;
      lines[i] = `|${newCells.slice(1, 7).join("|")}|`;
    }

    if (rows.length === 0) throw new Error("Constraint table found but contains no data rows.");

    if (writeBack) {
      // Refresh (or insert) a computed-on caption directly above the table.
      const today = new Date().toISOString().slice(0, 10);
      const caption = `*Current/Margin computed ${today} via compute_constraint_margins.*`;
      const captionIdx = headerIdx - 1 >= 0 && /computed .* via compute_constraint_margins/i.test(lines[headerIdx - 1])
        ? headerIdx - 1
        : -1;
      if (captionIdx >= 0) lines[captionIdx] = caption;
      else lines.splice(headerIdx, 0, caption);
      await fs.writeFile(resolved, lines.join("\n"), "utf-8");
    }

    // Human-readable report
    const icon = (s: MarginRow["status"]) =>
      s === "violated" ? "🔴" : s === "warn" ? "⚠️" : s === "manual" ? "✍️" : "✅";
    const textLines: string[] = ["=== Constraint Margins ===", ""];
    for (const r of rows) {
      textLines.push(`${icon(r.status)} ${r.stat} [${r.tier}] — threshold ${r.threshold}, current ${r.current}, margin ${r.margin}`);
    }
    const violated = rows.filter((r) => r.status === "violated");
    const manual = rows.filter((r) => r.status === "manual");
    textLines.push("");
    if (violated.length > 0) {
      textLines.push(`🔴 ${violated.length} constraint(s) VIOLATED: ${violated.map((r) => r.stat).join(", ")} — compensation required before any change that spends these margins.`);
    } else {
      textLines.push(manual.length ? "Constraints are not fully verified; no violation was found among evaluated rows." : "✅ No violated constraints.");
    }
    if (manual.length > 0) {
      textLines.push(`✍️ ${manual.length} row(s) need manual evaluation (non-numeric threshold or unmapped stat): ${manual.map((r) => r.stat).join(", ")}.`);
    }
    textLines.push(writeBack ? `Table updated in ${resolved}.` : "Dry run — pass write_back=true to update the profile file.");

    return { content: [{ type: "text" as const, text: textLines.join("\n") }] };
  });
}

// ---------------------------------------------------------------------------
// sync_character_cache
// ---------------------------------------------------------------------------

/** meta.json current_stats key -> PoB stat field(s). First defined field wins. */
const META_STAT_MAP: Record<string, string[]> = {
  life: ["Life"],
  es: ["EnergyShield"],
  mana: ["Mana"],
  armour: ["Armour"],
  evasion: ["Evasion"],
  block: ["BlockChance"],
  spell_block: ["SpellBlockChance"],
  combined_dps: ["CombinedDPS", "TotalDPS", "MinionTotalDPS"],
  crit_chance: ["CritChance"],
  crit_multiplier: ["CritMultiplier"],
  hit_chance: ["HitChance"],
  total_ehp: ["TotalEHP"],
  phys_dmg_reduction: ["PhysicalDamageReduction"],
  life_regen: ["LifeRegen"],
  life_leech_gain_rate: ["LifeLeechGainRate"],
  mana_unreserved: ["ManaUnreserved"],
};

const RES_MAP: Record<string, string> = {
  fire: "FireResist",
  cold: "ColdResist",
  lightning: "LightningResist",
  chaos: "ChaosResist",
};

const OVERCAP_MAP: Record<string, string> = {
  fire: "FireResistOverCap",
  cold: "ColdResistOverCap",
  lightning: "LightningResistOverCap",
};

/** PoB slot name -> inventory.json equipped key ("Body Armour" -> body). */
function slotToKey(slot: string): string | null {
  const s = slot.toLowerCase().trim();
  if (s === "body armour" || s === "body") return "body";
  const m = s.match(/^(weapon|ring)\s*(\d)$/);
  if (m) return `${m[1]}${m[2]}`;
  if (["helmet", "gloves", "boots", "amulet", "belt"].includes(s)) return s;
  return null; // flasks, jewel sockets, swap slots — handled elsewhere or curated
}

function roundStat(v: number): number {
  return Math.abs(v) >= 100 ? Math.round(v) : Math.round(v * 100) / 100;
}

export async function handleSyncCharacterCache(
  context: LuaHandlerContext,
  characterDir: string,
  targets: string[] = ["meta", "inventory"],
  dryRun: boolean = false
) {
  return wrapHandler("sync character cache", async () => {
    if (!characterDir?.trim()) throw new Error("character_dir is required");
    const dir = path.resolve(characterDir);
    const stat = await fs.stat(dir).catch(() => null);
    if (!stat?.isDirectory()) throw new Error(`character_dir does not exist or is not a directory: ${dir}`);

    await context.ensureLuaClient();
    const luaClient = context.getLuaClient();
    if (!luaClient) throw new Error("Lua client not initialized. Use lua_start first.");

    const today = new Date().toISOString().slice(0, 10);
    const report: string[] = ["=== Character Cache Sync ===", ""];
    const stats = await luaClient.getStats();
    const info = await luaClient.getBuildInfo().catch(() => null);

    // --- meta.json ---
    if (targets.includes("meta")) {
      const metaPath = path.join(dir, "meta.json");
      const metaRaw = await fs.readFile(metaPath, "utf-8").catch(() => null);
      if (metaRaw === null) {
        report.push(`⚠️ meta.json not found at ${metaPath} — skipped (create it once by hand or via the character pre-flight).`);
      } else {
        const meta = JSON.parse(metaRaw);
        const changes: string[] = [];

        if (info?.level && meta.level !== info.level) {
          changes.push(`level: ${meta.level} → ${info.level}`);
          meta.level = info.level;
        }

        meta.current_stats = meta.current_stats ?? {};
        const cs = meta.current_stats;

        const setStat = (key: string, value: number) => {
          const rounded = roundStat(value);
          if (cs[key] !== rounded) {
            changes.push(`${key}: ${cs[key] ?? "∅"} → ${rounded}`);
            cs[key] = rounded;
          }
        };

        for (const [key, fields] of Object.entries(META_STAT_MAP)) {
          for (const f of fields) {
            const v = Number(stats[f]);
            if (stats[f] != null && !Number.isNaN(v) && v !== 0) {
              setStat(key, v);
              break;
            }
          }
        }

        cs.resistances = cs.resistances ?? {};
        for (const [k, f] of Object.entries(RES_MAP)) {
          const v = Number(stats[f]);
          if (stats[f] != null && !Number.isNaN(v) && cs.resistances[k] !== v) {
            changes.push(`resistances.${k}: ${cs.resistances[k] ?? "∅"} → ${v}`);
            cs.resistances[k] = v;
          }
        }
        cs.resistance_overcap = cs.resistance_overcap ?? {};
        for (const [k, f] of Object.entries(OVERCAP_MAP)) {
          const v = Number(stats[f]);
          if (stats[f] != null && !Number.isNaN(v) && cs.resistance_overcap[k] !== v) {
            changes.push(`resistance_overcap.${k}: ${cs.resistance_overcap[k] ?? "∅"} → ${v}`);
            cs.resistance_overcap[k] = v;
          }
        }

        cs.as_of = today;

        if (changes.length === 0) {
          report.push("meta.json: already current (as_of refreshed).");
        } else {
          report.push(`meta.json — ${changes.length} field(s) updated:`);
          for (const c of changes) report.push(`  • ${c}`);
        }
        if (!dryRun) await fs.writeFile(metaPath, JSON.stringify(meta, null, 2) + "\n", "utf-8");
      }
      report.push("");
    }

    // --- inventory.json ---
    if (targets.includes("inventory")) {
      const invPath = path.join(dir, "inventory.json");
      const invRaw = await fs.readFile(invPath, "utf-8").catch(() => null);
      if (invRaw === null) {
        report.push(`⚠️ inventory.json not found at ${invPath} — skipped.`);
      } else {
        const inv = JSON.parse(invRaw);
        inv.equipped = inv.equipped ?? {};
        const items = await luaClient.getItems();
        const equipped = (items || []).filter((it: any) => it.id !== 0 && it.name);
        const changes: string[] = [];
        const preserved: string[] = [];

        for (const item of equipped) {
          const key = slotToKey(String(item.slot ?? ""));
          if (!key) continue;
          const existing = inv.equipped[key];
          if (existing && existing.name === item.name) {
            preserved.push(key); // same item — curated fields (key_mods, notes) stay
            continue;
          }
          const mods = parseItemRawMods(item.raw);
          inv.equipped[key] = {
            name: item.name,
            base: item.baseName ?? item.name,
            rarity: item.rarity ?? "RARE",
            key_mods: mods.filter((m) => !["enchant", "implicit"].includes(m.type)).map((m) => m.line),
            notes: `synced from PoB ${today} — curated fields reset, review manually`,
          };
          changes.push(`${key}: ${existing?.name ?? "∅"} → ${item.name}`);
        }

        // Flasks: refresh name per slot, preserve curated purpose when unchanged.
        const flaskItems = equipped.filter((it: any) => /^flask\s*\d$/i.test(String(it.slot ?? "")));
        if (flaskItems.length > 0) {
          const oldFlasks: any[] = Array.isArray(inv.flasks) ? inv.flasks : [];
          inv.flasks = flaskItems.map((it: any) => {
            const slotNum = Number(String(it.slot).replace(/\D/g, ""));
            const prior = oldFlasks.find((f) => Number(f.slot) === slotNum);
            if (prior && prior.name === it.name) return prior;
            if (prior) changes.push(`flask ${slotNum}: ${prior.name} → ${it.name}`);
            else changes.push(`flask ${slotNum}: ∅ → ${it.name}`);
            return { slot: slotNum, name: it.name, purpose: prior?.name === it.name ? prior.purpose : "(review)" };
          });
        }

        inv.as_of = today;

        if (changes.length === 0) {
          report.push(`inventory.json: all ${preserved.length} equipped slots unchanged (curated fields preserved; as_of refreshed).`);
        } else {
          report.push(`inventory.json — ${changes.length} slot(s) changed (curated key_mods/notes reset on those slots, marked for review):`);
          for (const c of changes) report.push(`  • ${c}`);
          if (preserved.length > 0) report.push(`  (${preserved.length} unchanged slot(s) preserved: ${preserved.join(", ")})`);
        }
        report.push("Jewels and eldritch implicits are curated by hand — not touched by this tool.");
        if (!dryRun) await fs.writeFile(invPath, JSON.stringify(inv, null, 2) + "\n", "utf-8");
      }
      report.push("");
    }

    report.push(dryRun ? "Dry run — no files written." : "Files updated.");
    report.push("Narrative files (build.md, journal.md, build-profile.md prose) remain manual by design.");

    return { content: [{ type: "text" as const, text: report.join("\n") }] };
  });
}
