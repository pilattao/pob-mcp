/**
 * League resolution helpers.
 *
 * Centralizes the answer to two questions:
 *
 * 1. "What league should we default to if the caller didn't specify one?"
 *    Reads POE_LEAGUE env (the project's existing single source of truth)
 *    and falls back to "Standard". This matches how poe-mcp-server (Python)
 *    already resolves it.
 *
 * 2. "What permanent league does this temp league dump into when it ends?"
 *    Deterministic heuristic on the league name:
 *      - "Hardcore <League>"            -> "Hardcore"
 *      - "SSF <League>" / "<League> SSF" -> "SSF Standard"
 *      - "Hardcore SSF <League>"        -> "SSF Hardcore"
 *      - <permanent league>             -> itself (no transition)
 *      - otherwise (softcore challenge) -> "Standard"
 *    GGG's actual naming uses prefix-style for Hardcore/SSF variants
 *    historically (e.g. "Hardcore Settlers", "Hardcore SSF Settlers").
 *    The heuristic is best-effort; permanent leagues are well-known and
 *    explicit overrides via the league_overrides table take precedence.
 *
 * This file deliberately has no network calls. For the *actual* list of
 * currently-running leagues, use TradeApiClient.getLeagues().
 */

/** The permanent (non-challenge) leagues that always exist. */
export const PERMANENT_LEAGUES = new Set<string>([
  "Standard",
  "Hardcore",
  "SSF Standard",
  "SSF Hardcore",
  "Ruthless",
  "Hardcore Ruthless",
  "SSF Ruthless",
  "Hardcore SSF Ruthless",
]);

/**
 * Resolve the default league for tools that didn't get an explicit one.
 * Priority: POE_LEAGUE env var > "Standard" fallback.
 *
 * The fallback exists so the trade tools don't crash when env isn't set,
 * but Standard prices are usually not what someone playing a temp league
 * actually wants — set POE_LEAGUE in your .mcp.json to keep this honest.
 */
export function getDefaultLeague(): string {
  const env = process.env.POE_LEAGUE;
  if (env && env.trim().length > 0) return env.trim();
  if ((process.env.POE_GAME ?? "poe2") === "poe2") throw new Error("Provide an explicit PoE2 league or POE_LEAGUE; no Standard fallback is selected");
  return "Standard";
}

/**
 * Given an explicit league argument (or undefined), return the league
 * that should actually be used — caller's value if present, otherwise
 * the default. Trims whitespace and treats empty strings as missing.
 */
export function resolveLeague(explicit?: string | null): string {
  if (typeof explicit === "string" && explicit.trim().length > 0) {
    return explicit.trim();
  }
  return getDefaultLeague();
}

/**
 * Compute the parent (permanent) league that a temp/challenge league
 * dumps into when it ends. Returns the league itself if it's already a
 * permanent league. The heuristic mirrors GGG's historical naming:
 *
 *   Mirage                       -> Standard
 *   Hardcore Mirage              -> Hardcore
 *   SSF Mirage                   -> SSF Standard
 *   Hardcore SSF Mirage          -> SSF Hardcore
 *   Standard                     -> Standard  (no-op)
 *
 * This is a best-effort guess for *display purposes* (e.g. "when this
 * league ends, characters move to X"). For the authoritative answer,
 * cross-check against the trade API league list at transition time.
 */
export function getParentLeague(league: string): string {
  if (PERMANENT_LEAGUES.has(league)) return league;
  const ruthless = /ruthless/i.test(league);
  const ssf = /\bssf\b/i.test(league);
  const hardcore = /^hardcore\b/i.test(league) || /\b(?:hardcore|hc)\b/i.test(league);
  if (ruthless) {
    if (hardcore && ssf) return "Hardcore SSF Ruthless";
    if (hardcore) return "Hardcore Ruthless";
    if (ssf) return "SSF Ruthless";
    return "Ruthless";
  }
  if (hardcore && ssf) return "SSF Hardcore";
  if (hardcore) return "Hardcore";
  if (ssf) return "SSF Standard";
  return "Standard";
}

export interface LeagueClassification {
  /** Input as given. */
  name: string;
  /** True if this is a permanent league (never ends, no parent transition). */
  isPermanent: boolean;
  /** The permanent league this dumps into on end. Same as `name` if permanent. */
  parent: string;
  /** True if SSF flag detected. */
  isSsf: boolean;
  /** True if Hardcore flag detected. */
  isHardcore: boolean;
  /** True if Ruthless flag detected. */
  isRuthless: boolean;
}

export function classifyLeague(league: string): LeagueClassification {
  const isPermanent = PERMANENT_LEAGUES.has(league);
  const ssf = /\bssf\b/i.test(league);
  const hardcore = /\b(?:hardcore|hc)\b/i.test(league);
  const ruthless = /\bruthless\b/i.test(league);
  return {
    name: league,
    isPermanent,
    parent: getParentLeague(league),
    isSsf: ssf,
    isHardcore: hardcore,
    isRuthless: ruthless,
  };
}
