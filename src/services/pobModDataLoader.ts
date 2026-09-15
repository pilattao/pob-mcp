/**
 * PoB Mod Data Loader
 *
 * Reads PoB community's `Data/ModItem.lua` (install or source) — PoB's parsed
 * mirror of GGG's rare/magic item mod table — and exposes it as typed JS
 * objects. The data covers every prefix/suffix that can roll on equipment
 * (rings, amulets, body armour, weapons, etc.) including essences,
 * fossil-only mods, and influence/synthesis mods.
 *
 * Same parse-once-cache pattern as pobTreeDataLoader. Auto-reloads when the
 * underlying file mtime changes (post submodule update).
 *
 * Legal: same posture as the tree loader. PoB redistributes this as a parsed
 * lua table under their own (MIT-compatible) license; the structure mirrors
 * what GGG publishes in their own data files. We don't extract from the
 * game's `Bundles2/` — we just read PoB's distributed `Data/ModItem.lua`.
 */
import { readFileSync, statSync, existsSync } from "fs";
import { join } from "path";
import luaparse from "luaparse";
import { resolvePobDataLocation } from "./pobDataPath.js";

export interface PobMod {
  /** Stable ID from PoB's table, e.g. "Strength1", "IncreasedLife12". */
  id: string;
  /** "Prefix" or "Suffix" (rarely other values). */
  type: string;
  /** Display name, e.g. "of the Brute", "Vigorous". */
  affix: string;
  /** Stat text lines exactly as PoB stores them, e.g. "+(8-12) to Strength". */
  statLines: string[];
  /** Internal stat ordering hint from PoB. Useful for grouping multi-stat mods. */
  statOrder?: number[];
  /** Minimum item level required for this mod to roll. */
  level: number;
  /**
   * Mod-group key. Two mods in the same group cannot roll on the same item
   * — they conflict. E.g. all "Strength1..Strength10" share group "Strength".
   */
  group: string;
  /**
   * Item-class weights. Each entry is { tag, weight }: the tag matches a
   * base-item tag (e.g. "ring", "body_armour", "bow"), the weight is the
   * spawn weight on that tag. The "default" entry is the fallthrough
   * for any tag not explicitly listed.
   *
   * Resolution (per PoE's mod-rolling logic): walk the list in order; the
   * first matching entry wins. If the target tag isn't listed at all,
   * the "default" entry applies. So `default = 0` means "cannot roll on
   * anything not otherwise listed", `default = 1000` means "rolls on
   * everything not otherwise excluded". Use `resolveWeightForTag` below
   * to do this correctly.
   * Native PoB2 currently supplies 1/0 eligibility values here, not measured
   * relative spawn frequencies. Preserve them; they do not establish odds.
   */
  weights: Array<{ tag: string; weight: number }>;
  /** Free-form tag list, e.g. ["attribute"], ["resource", "life"], ["damage", "fire"]. */
  modTags: string[];
}

export type ModSource = "pob-modItem-lua";

// ---------------------------------------------------------------------------
// Lua AST -> JS object (duplicated from pobTreeDataLoader to keep modules
// independent; same algorithm)
// ---------------------------------------------------------------------------

type LuaNode = {
  type: string;
  value?: unknown;
  raw?: string;
  operator?: string;
  argument?: LuaNode;
  fields?: LuaField[];
  name?: string;
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

// ---------------------------------------------------------------------------
// Path resolution (mirrors pobTreeDataLoader)
// ---------------------------------------------------------------------------

/**
 * PoB split the monolithic `Data/ModItem.lua` into per-category files in commit 0b6e7a9b2
 * ("Export trade hashes for mod stats"); explicit item mods now live in `ModExplicit.lua`.
 * The table format is unchanged apart from an added `tradeHashes` field, so we just need to
 * find whichever file this PoB version ships. Prefer the new name, fall back to the old one
 * so older PoB checkouts keep working.
 */
function modItemPath(location = resolvePobDataLocation()): string {
  const { dataDir, game } = location;
  // PoB2 Modules/Data.lua loads ModItem, not PoE1's split ModExplicit table.
  const candidates = game === "poe2" ? ["ModItem.lua"] : ["ModExplicit.lua", "ModItem.lua"];
  for (const name of candidates) {
    const candidate = join(dataDir, name);
    if (existsSync(candidate)) return candidate;
  }
  throw new Error(
    `PoB item-mod data not found in ${dataDir} — looked for ${candidates.join(", ")}. ` +
      `Set POB_INSTALL_DIR to the intended PoB install or source checkout.`,
  );
}

// ---------------------------------------------------------------------------
// Cache + normalization
// ---------------------------------------------------------------------------

interface CacheEntry {
  signature: string;
  mods: Record<string, PobMod>;
  /** PoB2 lookup-only definitions, never part of the equipment rolling pool. */
  exclusiveMods: Record<string, PobMod>;
  byGroup: Map<string, PobMod[]>;
  byTag: Map<string, PobMod[]>;
  /**
   * Normalized first stat-line → mods sharing that template. Built once
   * at load time; key shape comes from `normalizeStatLine` (numbers
   * replaced with `#`, lowercased, whitespace collapsed). Used by
   * matchStatLine to identify items.
   */
  byFirstStatTemplate: Map<string, PobMod[]>;
}

/**
 * Strip rolled values from a stat line so two lines with different
 * numerical values but the same template compare equal. Replaces both
 * `(N-N)` ranges and bare integers/decimals with `#`, lowercases,
 * collapses whitespace.
 *
 *   "+(8-12) to Strength"             -> "+# to strength"
 *   "+10 to Strength"                 -> "+# to strength"
 *   "Adds (2-3) to (4-5) Physical Damage"  -> "adds # to # physical damage"
 *   "Adds 7 to 12 Physical Damage"    -> "adds # to # physical damage"
 *   "Regenerate 12.5 Life per second" -> "regenerate # life per second"
 */
export function normalizeStatLine(s: string): string {
  return s
    .replace(/\(-?\d+(?:\.\d+)?-\d+(?:\.\d+)?\)/g, "#")
    .replace(/-?\d+(?:\.\d+)?/g, "#")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

/**
 * Extract every numeric value from a rolled stat line (i.e. an item's
 * actual mod text, not a template). Strips parenthesized ranges first
 * — those don't appear on identified items but guard against the rare
 * case where they leak through.
 */
export function parseRolledValues(line: string): number[] {
  const cleaned = line.replace(/\(-?\d+(?:\.\d+)?-\d+(?:\.\d+)?\)/g, "");
  return Array.from(cleaned.matchAll(/-?\d+(?:\.\d+)?/g), (m) => parseFloat(m[0]));
}

/**
 * Extract numeric ranges from a template stat line — each value-position
 * becomes a {min,max}. A `(N-N)` range yields {min:N,max:N}; a bare N
 * yields {min:N,max:N} (for low-tier mods that have a single fixed value).
 */
export function parseTemplateRanges(tpl: string): Array<{ min: number; max: number }> {
  const ranges: Array<{ min: number; max: number }> = [];
  const re = /\((-?\d+(?:\.\d+)?)-(\d+(?:\.\d+)?)\)|(-?\d+(?:\.\d+)?)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(tpl)) !== null) {
    if (m[1] !== undefined && m[2] !== undefined) {
      ranges.push({ min: parseFloat(m[1]), max: parseFloat(m[2]) });
    } else if (m[3] !== undefined) {
      const v = parseFloat(m[3]);
      ranges.push({ min: v, max: v });
    }
  }
  return ranges;
}

/**
 * True iff every rolled value falls inside its corresponding template
 * range. Mismatched arity returns false (different mods).
 */
export function rolledValuesFitTemplate(rolled: number[], tpl: string): boolean {
  const ranges = parseTemplateRanges(tpl);
  if (ranges.length !== rolled.length) return false;
  for (let i = 0; i < rolled.length; i++) {
    if (rolled[i] < ranges[i].min || rolled[i] > ranges[i].max) return false;
  }
  return true;
}

let cached: CacheEntry | null = null;

/**
 * Extract stat lines (the implicit-index entries that luaToJs gave
 * numeric-string keys to) and return them in their original order.
 */
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

function zipWeights(
  keys: unknown,
  vals: unknown
): Array<{ tag: string; weight: number }> {
  if (!Array.isArray(keys) || !Array.isArray(vals)) return [];
  const out: Array<{ tag: string; weight: number }> = [];
  const len = Math.min(keys.length, vals.length);
  for (let i = 0; i < len; i++) {
    const tag = keys[i];
    const weight = vals[i];
    if (typeof tag === "string" && typeof weight === "number") {
      out.push({ tag, weight });
    }
  }
  return out;
}

function normalizeMod(id: string, raw: Record<string, unknown>): PobMod {
  const statLines = extractStatLines(raw);
  const weights = zipWeights(raw.weightKey, raw.weightVal);
  const modTags = Array.isArray(raw.modTags) ? (raw.modTags as string[]) : [];
  const statOrder = Array.isArray(raw.statOrder) ? (raw.statOrder as number[]) : undefined;
  return {
    id,
    type: typeof raw.type === "string" ? raw.type : "",
    affix: typeof raw.affix === "string" ? raw.affix : "",
    statLines,
    statOrder,
    level: typeof raw.level === "number" ? raw.level : 1,
    group: typeof raw.group === "string" ? raw.group : "",
    weights,
    modTags,
  };
}

function parseModFile(path: string): Record<string, Record<string, unknown>> {
  const source = readFileSync(path, "utf-8");
  const ast = luaparse.parse(source, { comments: false, ranges: false });
  let rootTable: LuaNode | null = null;
  for (const stmt of (ast as { body: { type: string; arguments?: LuaNode[] }[] }).body) {
    if (stmt.type === "ReturnStatement" && stmt.arguments && stmt.arguments[0]) {
      rootTable = stmt.arguments[0];
      break;
    }
  }
  if (!rootTable || rootTable.type !== "TableConstructorExpression") {
    throw new Error(`No returned mod table found in ${path}`);
  }
  const parsed = luaToJs(rootTable) as Record<string, Record<string, unknown>>;
  if (!parsed || typeof parsed !== "object") {
    throw new Error(`Failed to parse ${path}: top-level is not an object`);
  }

  for (const [id, entry] of Object.entries(parsed)) {
    if (!entry || typeof entry !== "object") throw new Error(`Invalid mod definition ${id} in ${path}`);
  }
  return parsed;
}

function load(): CacheEntry {
  const location = resolvePobDataLocation();
  const path = modItemPath(location);
  const exclusivePath = join(location.dataDir, "ModItemExclusive.lua");
  // PoB2's ItemsTab resolves essence IDs from Item first, then Exclusive.
  // Missing descriptions stay unresolved; no synthetic mod is substituted.
  const paths = [path];
  if (location.game === "poe2" && existsSync(exclusivePath)) paths.push(exclusivePath);
  const signature = JSON.stringify([location.game, paths.map(p => {
    const stat = statSync(p);
    return [p, stat.mtimeMs, stat.size];
  })]);
  if (cached && cached.signature === signature) return cached;

  const parsed = parseModFile(path);
  if (Object.keys(parsed).length === 0) throw new Error(`No item mod definitions found in ${path}`);
  const mods: Record<string, PobMod> = Object.create(null);
  const exclusiveMods: Record<string, PobMod> = Object.create(null);
  const byGroup = new Map<string, PobMod[]>();
  const byTag = new Map<string, PobMod[]>();
  const byFirstStatTemplate = new Map<string, PobMod[]>();
  for (const [id, rawEntry] of Object.entries(parsed)) {
    const mod = normalizeMod(id, rawEntry);
    mods[id] = mod;
    if (mod.group) {
      const arr = byGroup.get(mod.group) ?? [];
      arr.push(mod);
      byGroup.set(mod.group, arr);
    }
    for (const tag of mod.modTags) {
      const arr = byTag.get(tag) ?? [];
      arr.push(mod);
      byTag.set(tag, arr);
    }
    if (mod.statLines.length > 0) {
      const key = normalizeStatLine(mod.statLines[0]);
      const arr = byFirstStatTemplate.get(key) ?? [];
      arr.push(mod);
      byFirstStatTemplate.set(key, arr);
    }
  }

  if (paths.length > 1) {
    for (const [id, rawEntry] of Object.entries(parseModFile(exclusivePath))) {
      exclusiveMods[id] = normalizeMod(id, rawEntry);
    }
  }

  cached = { signature, mods, exclusiveMods, byGroup, byTag, byFirstStatTemplate };
  return cached;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface ModSearchFilters {
  /** Substring (case-insensitive) match against any stat line. */
  statContains?: string;
  /**
   * Restrict to mods that can roll on an item carrying these tags.
   * Pass the full tag list for accurate matching — e.g. an Astral Plate
   * is `["body_armour", "armour", "str_armour"]`. The first weight entry
   * matching ANY of these tags wins; if none match, the mod's `default`
   * weight is used. A mod is included only when the resolved weight > 0.
   */
  itemTags?: string[];
  /** "prefix" / "suffix" / etc — case-insensitive. */
  type?: string;
  /** Minimum mod-level (rolling ilvl). */
  minLevel?: number;
  /** Maximum mod-level. */
  maxLevel?: number;
  /** Filter to a specific mod group (e.g. "IncreasedLife"). */
  group?: string;
  /** Mod must include ALL of these tags. */
  hasTags?: string[];
  /** Substring (case-insensitive) match against the affix name. */
  affixContains?: string;
  /** Cap results. Default 50. Pass 0 to disable. */
  limit?: number;
}

/**
 * Force-load (or refresh) the mod data. Useful for diagnostics or to bypass
 * lazy-loading.
 */
export function ensureLoaded(): void {
  load();
}

/**
 * Get a single mod entry by ID, including PoB2's lookup-only Exclusive table.
 * Item definitions win on duplicate IDs. Returns null for missing descriptions.
 */
export function getMod(id: string): PobMod | null {
  const c = load();
  return c.mods[id] ?? c.exclusiveMods[id] ?? null;
}

/**
 * List all mods in a given mod group (conflicting mods on the same item).
 */
export function getModGroup(group: string): PobMod[] {
  return load().byGroup.get(group) ?? [];
}

/**
 * Number of item-pool mod entries (excludes lookup-only Exclusive definitions).
 */
export function getModCount(): number {
  return Object.keys(load().mods).length;
}

/**
 * Search mods with combinable filters. Returns mods in PoB's original order
 * (which is roughly: by group, then by level).
 *
 * Notes:
 *   - statContains and affixContains are case-insensitive substring matches.
 *   - itemTag filtering uses the first non-zero matching weight entry. This
 *     mirrors PoE's mod-rolling logic but isn't a perfect simulation —
 *     base-tag inheritance (e.g. "two_hand_sword" inheriting from "sword")
 *     is not yet modeled here.
 *   - All filters are AND-combined.
 */
export function searchMods(filters: ModSearchFilters): PobMod[] {
  const c = load();
  const all = Object.values(c.mods);
  const stat = filters.statContains?.toLowerCase();
  const affix = filters.affixContains?.toLowerCase();
  const type = filters.type?.toLowerCase();
  const tags = filters.itemTags && filters.itemTags.length > 0 ? filters.itemTags : null;
  const minLevel = filters.minLevel ?? 0;
  const maxLevel = filters.maxLevel ?? Number.POSITIVE_INFINITY;
  const group = filters.group;
  const hasTags = filters.hasTags ?? [];
  const limit = filters.limit === undefined ? 50 : filters.limit;

  const out: PobMod[] = [];
  for (const mod of all) {
    if (type && mod.type.toLowerCase() !== type) continue;
    if (group && mod.group !== group) continue;
    if (mod.level < minLevel || mod.level > maxLevel) continue;
    if (stat && !mod.statLines.some((s) => s.toLowerCase().includes(stat))) continue;
    if (affix && !mod.affix.toLowerCase().includes(affix)) continue;
    if (tags) {
      if (resolveWeightForTags(mod, tags) <= 0) continue;
    }
    if (hasTags.length > 0) {
      if (!hasTags.every((t) => mod.modTags.includes(t))) continue;
    }
    out.push(mod);
    if (limit > 0 && out.length >= limit) break;
  }
  return out;
}

export function getModItemPath(): string {
  return modItemPath();
}

export interface MatchOptions {
  /**
   * Base tag chain to constrain candidates — same shape as searchMods's
   * itemTags. When present, candidates whose resolved weight on the
   * base is 0 are deprioritized (still returned, but ranked last so
   * impossible matches are visible if the only-candidate fallback hits).
   */
  itemTags?: string[];
  /**
   * Item level — candidates with mod level > ilvl are deprioritized.
   * Useful when an item has rolled the maximum tier available at its
   * ilvl: matching against the top tier (which requires higher ilvl)
   * would be wrong.
   */
  ilvl?: number;
}

export interface MatchResult {
  /** The rolled line we were trying to identify. */
  query: string;
  /** All mods whose first stat-template equals the query template. */
  candidates: PobMod[];
  /**
   * Best-guess single mod after applying itemTags + ilvl ranking. Null
   * only when there are zero template matches (i.e. the line doesn't
   * correspond to a known mod — masters / unique implicits / explicit
   * crafted text that this loader doesn't index).
   */
  best: PobMod | null;
  /**
   * Tier rank within the matched mod's group: 1 = highest tier, N = lowest.
   * Useful for "this is T2 of 12 — next tier needs ilvl X".
   */
  tier?: number;
  /** Total mods in the matched group that can actually roll on the base. */
  tierMax?: number;
  /**
   * The next-higher-tier mod in the same group, if any (i.e. an upgrade
   * target). Null if the rolled tier is already the top.
   */
  nextTier?: PobMod;
  /**
   * Count of *genuinely* confusable candidates — those that fit the
   * rolled value AND are affixed AND (if itemTags given) rollable on the
   * base. Differs from `candidates.length`, which includes technical
   * range-overlap matches from essence/Hellscape/influence variants that
   * a player would never confuse with the natural roll. Use this for an
   * honest "is this ambiguous?" signal.
   */
  meaningfulCandidateCount: number;
}

/**
 * Identify which ModItem.lua entry a single rolled stat line corresponds
 * to. Returns all candidates whose template matches plus a best-guess
 * ranking, tier info, and next-tier upgrade target.
 *
 * Limitations:
 *   - Only matches against the FIRST stat line. Hybrid mods (e.g.
 *     IncreasedLifeAndPercent with two lines) are returned via the
 *     first line; the second line will also match the hybrid mod but
 *     `analyze_item_mods` collapses adjacent matching IDs.
 *   - Doesn't recognize master-crafted (`{crafted}`), fractured, or
 *     synthesized prefixes/suffixes on the line. Strip those before
 *     passing.
 *   - Doesn't index influence-implicit mods or unique-specific mods.
 */
export function matchStatLine(line: string, options: MatchOptions = {}): MatchResult {
  const c = load();
  const key = normalizeStatLine(line);
  const templateMatches = c.byFirstStatTemplate.get(key) ?? [];
  if (templateMatches.length === 0) {
    return { query: line, candidates: [], best: null, meaningfulCandidateCount: 0 };
  }

  // Narrow by rolled-value range: a life mod can roll +145-159; an item
  // showing "+150 to maximum Life" matches only the tier whose range
  // contains 150. This collapses the 40-candidate ambiguity for common
  // mods down to (usually) exactly one.
  const rolled = parseRolledValues(line);
  const valueMatches = templateMatches.filter((mod) =>
    rolledValuesFitTemplate(rolled, mod.statLines[0])
  );

  // If nothing fits the rolled value (corrupted/synthesized ranges, custom
  // unique-only values, etc.), fall back to template-only matches so the
  // caller still gets *something* — but the candidate list reflects that.
  const candidates = valueMatches.length > 0 ? valueMatches : templateMatches;

  // Rank: prefer rollable-on-base + level <= ilvl + higher weight.
  const tags = options.itemTags;
  const ilvl = options.ilvl ?? Infinity;

  const scored = candidates.map((mod) => {
    const weight = tags ? resolveWeightForTags(mod, tags) : 1;
    const rollable = weight > 0 ? 1 : 0;
    const ilvlOk = mod.level <= ilvl ? 1 : 0;
    // Prefer affixed mods over empty-affix entries. Empty affix usually
    // indicates a non-standard mod source (Hellscape modifier, certain
    // influence implicits, Synthesised) that shares stat-text with a
    // common prefix/suffix. Players almost always want the affixed
    // (naturally rollable) version.
    const hasAffix = mod.affix && mod.affix.length > 0 ? 1 : 0;
    // Prefer rollable, then within-ilvl, then affixed, then highest
    // LEVEL (top tier among candidates that already passed the range
    // filter), then weight. Without the level term we'd flip-coin
    // between tiers that share a range structure.
    const score =
      rollable * 100_000_000 +
      ilvlOk * 1_000_000 +
      hasAffix * 100_000 +
      mod.level * 100 +
      weight / 1000;
    return { mod, score };
  });
  scored.sort((a, b) => b.score - a.score);

  const best = scored[0].mod;

  // Tier info from the matched mod's group, restricted to mods rollable
  // on the base (if tags given) — otherwise tier numbers would include
  // unrollable essence/fossil-only entries.
  let tier: number | undefined;
  let tierMax: number | undefined;
  let nextTier: PobMod | undefined;

  // Build the tier ladder from mods that are equivalent to `best` for
  // crafting purposes: same group, with an affix (excludes Hellscape
  // downsides, synthesis implicits, and other non-standard entries
  // that share a group key but aren't part of the natural prefix/
  // suffix ladder), and (if tags given) actually rollable on the base.
  const group = c.byGroup.get(best.group) ?? [];
  let ladder = group.filter((m) => m.affix && m.affix.length > 0);
  if (tags) {
    ladder = ladder.filter((m) => resolveWeightForTags(m, tags) > 0);
  }
  ladder.sort((a, b) => b.level - a.level); // top tier first
  if (ladder.length > 0) {
    tierMax = ladder.length;
    const idx = ladder.findIndex((m) => m.id === best.id);
    if (idx >= 0) {
      tier = idx + 1; // 1-indexed, 1 = top
      if (idx > 0) nextTier = ladder[idx - 1];
    }
  }

  // Genuine ambiguity: value-fitting candidates that are also affixed and
  // (if tags given) rollable on the base. Excludes essence/Hellscape/
  // influence range-overlaps a player would never confuse with the roll.
  const meaningfulCandidateCount = candidates.filter((m) => {
    if (!m.affix || m.affix.length === 0) return false;
    if (tags && resolveWeightForTags(m, tags) <= 0) return false;
    return true;
  }).length;

  return {
    query: line,
    candidates,
    best,
    tier,
    tierMax,
    nextTier,
    meaningfulCandidateCount,
  };
}

/**
 * Resolve the effective spawn weight for a mod on a given item-class tag,
 * mirroring PoE's mod-rolling logic: first matching entry in `weights`
 * wins; if no entry matches, fall back to the `default` entry; if there's
 * no default either, the mod is unrollable (weight 0).
 *
 * Returns the weight number — caller decides whether > 0 means "can roll".
 */
export function resolveWeightForTag(mod: PobMod, tag: string): number {
  return resolveWeightForTags(mod, [tag]);
}

/**
 * Like resolveWeightForTag but accepts an array of tags (representing all
 * tags a base item carries). The first entry in the mod's `weights` whose
 * tag is in the provided list wins. This matches PoE's actual rolling
 * logic: a base like Astral Plate has tags ["body_armour","armour",
 * "str_armour"], and the mod's weights are walked in order until one
 * matches any of those.
 */
export function resolveWeightForTags(mod: PobMod, tags: string[]): number {
  const tagSet = new Set(tags);
  for (const w of mod.weights) {
    if (tagSet.has(w.tag)) return w.weight;
  }
  const def = mod.weights.find((w) => w.tag === "default");
  return def ? def.weight : 0;
}
