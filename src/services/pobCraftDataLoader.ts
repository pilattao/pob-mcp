/**
 * PoB Craft Data Loader — master (bench) crafts + essences.
 *
 * Reads two PoB community data files:
 *   - Data/ModMaster.lua  — PoE1-only deterministic bench crafts ("of Craft" suffixes,
 *     "Upgraded" prefixes). Flat array; each entry lists which item TYPES it
 *     can be crafted on (e.g. ["Body Armour"]=true).
 *   - Data/Essence.lua    — essences. Each essence guarantees one specific
 *     ModItem.lua mod per item type. Values in `mods` are ModItem.lua IDs,
 *     so we resolve them through pobModDataLoader (no duplication). PoB2
 *     also references lookup-only ModItemExclusive.lua descriptions.
 *
 * PoB2 has no ModMaster.lua or equivalent bench pool in this loader. Essence
 * loading is independent of that missing feature. Bench queries explicitly
 * throw POB_CRAFT_UNSUPPORTED; rune/socket effects are not bench affixes.
 *
 * Same parse-once-cache pattern as the other loaders.
 *
 * Legal: same posture — PoB redistributes parsed Lua under their license;
 * we don't touch the game's Bundles2/.
 */
import { readFileSync, statSync } from "fs";
import { join } from "path";
import luaparse from "luaparse";
import { getMod, type PobMod } from "./pobModDataLoader.js";
import { resolvePobDataLocation } from "./pobDataPath.js";

export interface MasterCraft {
  /** "Prefix" or "Suffix". */
  type: string;
  /** Bench-craft affix name ("of Craft", "Upgraded", etc). */
  affix: string;
  /** Stat text lines (templates, with (N-N) ranges). */
  statLines: string[];
  /** Minimum item level for the craft. */
  level: number;
  /** Mod-group key (conflicts with same-group mods). */
  group: string;
  /** Item TYPE names this craft applies to (e.g. "Body Armour", "Ring"). */
  types: string[];
  /** Free-form tags (e.g. ["elemental","fire","resistance"]). */
  modTags: string[];
}

export interface Essence {
  /** Display name, e.g. "Deafening Essence of Greed". */
  name: string;
  /** PoE1 tier, or null when the native table does not provide a tier. */
  tier: number | null;
  /** PoE1 numeric category, or null for PoB2's string categories. */
  typeId: number | null;
  /** Native category, e.g. PoB2 "Life" or PoE1's numeric category. */
  type?: string | number;
  /** Native PoB2 level used for ordering; NOT a PoE1 1–7 tier. */
  tierLevel?: number;
  /** item-type name -> ModItem.lua mod ID guaranteed on that type. */
  mods: Record<string, string>;
}

// ---------------------------------------------------------------------------
// Lua AST -> JS (shared shape with sibling loaders)
// ---------------------------------------------------------------------------

type LuaNode = {
  type: string;
  value?: unknown;
  raw?: string;
  operator?: string;
  argument?: LuaNode;
  fields?: LuaField[];
  name?: string;
  arguments?: LuaNode[];
};

type LuaField = {
  type: "TableKey" | "TableKeyString" | "TableValue";
  key?: LuaNode | { type: "Identifier"; name: string };
  value: LuaNode;
};

function luaToJs(node: LuaNode | null | undefined): unknown {
  if (!node) return null;
  switch (node.type) {
    case "NumericLiteral":
      return node.value !== null && node.value !== undefined
        ? (node.value as number)
        : Number(node.raw);
    case "StringLiteral": {
      if (node.value !== null && node.value !== undefined) return node.value;
      const raw = node.raw ?? "";
      if (
        (raw.startsWith('"') && raw.endsWith('"')) ||
        (raw.startsWith("'") && raw.endsWith("'"))
      ) {
        return raw
          .slice(1, -1)
          .replace(/\\n/g, "\n")
          .replace(/\\t/g, "\t")
          .replace(/\\r/g, "\r")
          .replace(/\\"/g, '"')
          .replace(/\\'/g, "'")
          .replace(/\\\\/g, "\\");
      }
      const m = raw.match(/^\[(=*)\[([\s\S]*)\]\1\]$/);
      if (m) return m[2];
      return raw;
    }
    case "BooleanLiteral":
      return node.value;
    case "NilLiteral":
      return null;
    case "UnaryExpression":
      if (node.operator === "-") {
        const arg = luaToJs(node.argument);
        return typeof arg === "number" ? -arg : null;
      }
      return null;
    case "TableConstructorExpression": {
      const fields = node.fields ?? [];
      const isSequence =
        fields.length > 0 && fields.every((f) => f.type === "TableValue");
      if (isSequence) {
        return fields.map((f) => luaToJs(f.value));
      }
      const obj: Record<string, unknown> = {};
      let implicitIndex = 1;
      for (const field of fields) {
        if (field.type === "TableKey") {
          const key = luaToJs(field.key as LuaNode);
          obj[String(key)] = luaToJs(field.value);
        } else if (field.type === "TableKeyString") {
          const k = (field.key as { name: string }).name;
          obj[k] = luaToJs(field.value);
        } else if (field.type === "TableValue") {
          obj[String(implicitIndex++)] = luaToJs(field.value);
        }
      }
      return obj;
    }
    default:
      return null;
  }
}

function parseReturnTable(path: string): Record<string, unknown> | unknown[] {
  const source = readFileSync(path, "utf-8");
  const ast = luaparse.parse(source, { comments: false, ranges: false });
  let rootTable: LuaNode | null = null;
  for (const stmt of (ast as { body: { type: string; arguments?: LuaNode[] }[] }).body) {
    if (stmt.type === "ReturnStatement" && stmt.arguments && stmt.arguments[0]) {
      rootTable = stmt.arguments[0] as LuaNode;
      break;
    }
  }
  if (!rootTable || rootTable.type !== "TableConstructorExpression") {
    throw new Error(`No returned craft data table found in ${path}`);
  }
  return luaToJs(rootTable) as Record<string, unknown> | unknown[];
}

// ---------------------------------------------------------------------------
// Path resolution
// ---------------------------------------------------------------------------

function modMasterPath(): string {
  return join(resolvePobDataLocation().dataDir, "ModMaster.lua");
}
function essencePath(): string {
  return join(resolvePobDataLocation().dataDir, "Essence.lua");
}

// ---------------------------------------------------------------------------
// Normalization
// ---------------------------------------------------------------------------

function extractStatLines(raw: Record<string, unknown>): string[] {
  const lines: string[] = [];
  let i = 1;
  while (raw[String(i)] !== undefined) {
    const v = raw[String(i)];
    if (typeof v === "string") lines.push(v);
    i++;
  }
  return lines;
}

function normalizeMasterCraft(raw: Record<string, unknown>): MasterCraft {
  const typesRaw = (raw.types ?? {}) as Record<string, unknown>;
  const types = Object.keys(typesRaw).filter((k) => typesRaw[k] === true);
  return {
    type: typeof raw.type === "string" ? raw.type : "",
    affix: typeof raw.affix === "string" ? raw.affix : "",
    statLines: extractStatLines(raw),
    level: typeof raw.level === "number" ? raw.level : 1,
    group: typeof raw.group === "string" ? raw.group : "",
    types,
    modTags: Array.isArray(raw.modTags) ? (raw.modTags as string[]) : [],
  };
}

// ---------------------------------------------------------------------------
// Cache
// ---------------------------------------------------------------------------

interface CacheEntry {
  signature: string;
  masterCrafts: MasterCraft[];
  /** item-type name -> master crafts available on it. */
  masterByType: Map<string, MasterCraft[]>;
  essences: Essence[];
  essenceByNameLower: Map<string, Essence>;
}

let cached: CacheEntry | null = null;

function load(): CacheEntry {
  const { dataDir, game } = resolvePobDataLocation();
  const mPath = join(dataDir, "ModMaster.lua");
  const ePath = join(dataDir, "Essence.lua");
  const mStat = game === "poe1" ? statSync(mPath) : undefined;
  const eStat = statSync(ePath);
  const signature = JSON.stringify([game, dataDir, mStat?.mtimeMs, mStat?.size, eStat.mtimeMs, eStat.size]);
  if (cached && cached.signature === signature) {
    return cached;
  }

  // Master crafts — flat array
  const masterRaw = game === "poe1" ? parseReturnTable(mPath) : [];
  const masterArr: Record<string, unknown>[] = Array.isArray(masterRaw)
    ? (masterRaw as Record<string, unknown>[])
    : Object.values(masterRaw as Record<string, Record<string, unknown>>);
  const masterCrafts = masterArr.map(normalizeMasterCraft);
  const masterByType = new Map<string, MasterCraft[]>();
  for (const mc of masterCrafts) {
    for (const t of mc.types) {
      const arr = masterByType.get(t) ?? [];
      arr.push(mc);
      masterByType.set(t, arr);
    }
  }

  // Essences — keyed map
  const essenceRaw = parseReturnTable(ePath) as Record<string, Record<string, unknown>>;
  const essences: Essence[] = [];
  const essenceByNameLower = new Map<string, Essence>();
  for (const entry of Object.values(essenceRaw)) {
    if (!entry || typeof entry !== "object") throw new Error(`Invalid essence definition in ${ePath}`);
    const name = typeof entry.name === "string" ? entry.name : "";
    if (!name) continue;
    const modsRaw = (entry.mods ?? {}) as Record<string, unknown>;
    const mods: Record<string, string> = {};
    for (const [itemType, modId] of Object.entries(modsRaw)) {
      if (typeof modId === "string") mods[itemType] = modId;
    }
    const e: Essence = {
      name,
      tier: typeof entry.tier === "number" ? entry.tier : null,
      typeId: typeof entry.type === "number" ? entry.type : null,
      ...(typeof entry.type === "string" || typeof entry.type === "number" ? { type: entry.type } : {}),
      ...(typeof entry.tierLevel === "number" ? { tierLevel: entry.tierLevel } : {}),
      mods,
    };
    essences.push(e);
    essenceByNameLower.set(name.toLowerCase(), e);
  }

  if (essences.length === 0) throw new Error(`No essence definitions found in ${ePath}`);
  cached = {
    signature,
    masterCrafts,
    masterByType,
    essences,
    essenceByNameLower,
  };
  return cached;
}

// ---------------------------------------------------------------------------
// Public API — master crafts
// ---------------------------------------------------------------------------

export function ensureCraftDataLoaded(): void {
  load();
}

export class PobCraftUnsupportedError extends Error {
  readonly code = "POB_CRAFT_UNSUPPORTED";

  constructor() {
    super("PoE2 bench crafting is unsupported: PoB2 has no ModMaster.lua bench-craft data. Rune/socket effects are a separate mechanism; no equivalent bench mod pool is mapped.");
    this.name = "PobCraftUnsupportedError";
  }
}

function loadMasterCrafts(): CacheEntry {
  if (resolvePobDataLocation().game === "poe2") throw new PobCraftUnsupportedError();
  return load();
}

export function getMasterCraftCount(): number {
  return loadMasterCrafts().masterCrafts.length;
}

export function getEssenceCount(): number {
  return load().essences.length;
}

export interface MasterCraftFilters {
  /** Substring (case-insensitive) match against any stat line. */
  statContains?: string;
  /** Restrict to crafts applicable to this item TYPE (e.g. "Body Armour", "Ring"). */
  itemType?: string;
  /** "prefix"/"suffix" (case-insensitive). */
  type?: string;
  /** Mod must include ALL of these tags. */
  hasTags?: string[];
  /** Cap results. Default 50, 0 = no cap. */
  limit?: number;
}

/**
 * Search bench (master) crafts. For each group, multiple tiers may exist
 * (different `level`); all are returned unless filtered.
 */
export function searchMasterCrafts(filters: MasterCraftFilters): MasterCraft[] {
  const c = loadMasterCrafts();
  const stat = filters.statContains?.toLowerCase();
  const type = filters.type?.toLowerCase();
  const itemType = filters.itemType;
  const hasTags = filters.hasTags ?? [];
  const limit = filters.limit === undefined ? 50 : filters.limit;

  const pool = itemType ? c.masterByType.get(itemType) ?? [] : c.masterCrafts;
  const out: MasterCraft[] = [];
  for (const mc of pool) {
    if (type && mc.type.toLowerCase() !== type) continue;
    if (stat && !mc.statLines.some((s) => s.toLowerCase().includes(stat))) continue;
    if (hasTags.length > 0 && !hasTags.every((t) => mc.modTags.includes(t))) continue;
    out.push(mc);
    if (limit > 0 && out.length >= limit) break;
  }
  return out;
}

/**
 * Find the best-matching master craft for an item line (used by
 * analyze_item_mods on `{crafted}` lines). Matches by normalized template
 * + rolled value, like pobModDataLoader.matchStatLine but against the
 * bench-craft pool.
 */
export function matchMasterCraft(
  line: string,
  itemType?: string
): MasterCraft | null {
  const c = loadMasterCrafts();
  // Lazy import of the normalizer would create a cycle; reimplement inline.
  const normalize = (s: string) =>
    s
      .replace(/\(-?\d+(?:\.\d+)?-\d+(?:\.\d+)?\)/g, "#")
      .replace(/-?\d+(?:\.\d+)?/g, "#")
      .replace(/\s+/g, " ")
      .trim()
      .toLowerCase();
  const key = normalize(line);
  const pool = itemType ? c.masterByType.get(itemType) ?? [] : c.masterCrafts;
  const matches = pool.filter((mc) => mc.statLines.length > 0 && normalize(mc.statLines[0]) === key);
  if (matches.length === 0) return null;
  // Prefer highest level (top craft tier) among template matches.
  matches.sort((a, b) => b.level - a.level);
  return matches[0];
}

// ---------------------------------------------------------------------------
// Public API — essences
// ---------------------------------------------------------------------------

export function getEssence(name: string): Essence | null {
  return load().essenceByNameLower.get(name.toLowerCase()) ?? null;
}

export function findEssencesMatching(query: string, limit = 20): Essence[] {
  const c = load();
  const q = query.toLowerCase();
  const out: Essence[] = [];
  for (const e of c.essences) {
    if (e.name.toLowerCase().includes(q)) {
      out.push(e);
      if (out.length >= limit) break;
    }
  }
  return out;
}

export interface EssenceModResolved {
  itemType: string;
  modId: string;
  /** Item or PoB2 Exclusive description; null when PoB does not describe the ID. */
  mod: PobMod | null;
}

/**
 * For an essence, resolve the guaranteed mod on each item type into the
 * actual ModItem.lua entry (stat text, group, etc.). If `itemType` is
 * given, only that type is resolved.
 */
export function resolveEssenceMods(essenceName: string, itemType?: string): EssenceModResolved[] {
  const e = getEssence(essenceName);
  if (!e) return [];
  const entries = itemType
    ? (e.mods[itemType] !== undefined ? [[itemType, e.mods[itemType]] as const] : [])
    : Object.entries(e.mods);
  return entries.map(([t, id]) => ({ itemType: t, modId: id, mod: getMod(id) }));
}

/**
 * Find essences that (on at least one item type) guarantee a mod whose
 * stat text contains the keyword. Returns the essence plus which item
 * types match. Useful for "which essences give me +Life?".
 */
export function searchEssencesByStat(
  keyword: string,
  limit = 30
): Array<{ essence: Essence; matchingTypes: string[] }> {
  const c = load();
  const kw = keyword.toLowerCase();
  const out: Array<{ essence: Essence; matchingTypes: string[] }> = [];
  for (const e of c.essences) {
    const matchingTypes: string[] = [];
    for (const [itemType, modId] of Object.entries(e.mods)) {
      const mod = getMod(modId);
      if (mod && mod.statLines.some((s) => s.toLowerCase().includes(kw))) {
        matchingTypes.push(itemType);
      }
    }
    if (matchingTypes.length > 0) {
      out.push({ essence: e, matchingTypes });
      if (out.length >= limit) break;
    }
  }
  return out;
}

export function getModMasterPath(): string {
  return modMasterPath();
}
export function getEssencePath(): string {
  return essencePath();
}
