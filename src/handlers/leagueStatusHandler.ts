/**
 * Handler for the get_active_leagues MCP tool.
 *
 * Queries the PoE trade API for the currently-active leagues, cross-checks
 * them against the POE_LEAGUE env var, and reports:
 *   - which leagues are currently temp (challenge) leagues
 *   - which leagues are permanent
 *   - whether POE_LEAGUE matches a current league (warning if not — usually
 *     means a temp league ended and the env var is stale)
 *   - the parent-league mapping (where each temp league's characters dump
 *     into when the league ends)
 *
 * Complements the existing `get_leagues` tool, which is a raw passthrough
 * of the trade-leagues endpoint. `get_active_leagues` is opinionated:
 * focuses on "are we ready for the current PoE state, and what happens
 * at the next transition".
 */

import type { TradeApiClient } from "../services/tradeClient.js";
import {
  classifyLeague,
  getDefaultLeague,
  PERMANENT_LEAGUES,
} from "../services/leagueResolver.js";

export interface LeagueStatusContext {
  tradeClient: TradeApiClient | null;
}

export async function handleGetActiveLeagues(context: LeagueStatusContext) {
  if ((process.env.POE_GAME ?? 'poe2') === 'poe2') {
    if (!context.tradeClient) return {isError:true,content:[{type:'text',text:'PoE2 trade client is disabled.'}]};
    try {
      const data=await context.tradeClient.getLeagues();
      const configured=process.env.POE_LEAGUE?.trim() || null;
      return {content:[{type:'text',text:JSON.stringify({game:'poe2',
        source:'https://www.pathofexile.com/api/trade2/data/leagues',
        configuredLeague:configured,configuredLeagueIsListed:configured===null?null:data.result.some(l=>l.id===configured),
        leagues:data.result,migrationTargets:'not supplied by this endpoint; no destinations inferred',
        cache:'Metadata may be cached for up to one hour.',
      },null,2)}]};
    } catch(error) {return {isError:true,content:[{type:'text',text:`PoE2 league metadata unavailable: ${error instanceof Error?error.message:String(error)}`}]};}
  }

  if (!context.tradeClient) {
    return {
      content: [
        {
          type: "text",
          text:
            "Trade API is not enabled — can't query the league list. Set " +
            "POE_TRADE_ENABLED=true to enable. The configured default " +
            `league (POE_LEAGUE) is currently: ${getDefaultLeague()}.`,
        },
      ],
      isError: true,
    };
  }

  let leagueData;
  try {
    leagueData = await context.tradeClient.getLeagues();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      content: [
        {
          type: "text",
          text:
            `Failed to fetch league list from PoE trade API: ${msg}\n\n` +
            `Default league (POE_LEAGUE env): ${getDefaultLeague()}`,
        },
      ],
      isError: true,
    };
  }

  const apiLeagues: string[] = (leagueData.result ?? [])
    .map((l) => l.id)
    .filter((id): id is string => typeof id === "string");

  const defaultLeague = getDefaultLeague();
  const apiSet = new Set(apiLeagues);
  const envSet = process.env.POE_LEAGUE !== undefined && process.env.POE_LEAGUE.trim() !== "";

  // Split into temp (non-permanent) and permanent leagues
  const temp: string[] = [];
  const permanent: string[] = [];
  for (const id of apiLeagues) {
    if (PERMANENT_LEAGUES.has(id)) permanent.push(id);
    else temp.push(id);
  }

  const lines: string[] = [];
  lines.push("=== PoE League Status ===");
  lines.push("");
  lines.push(`POE_LEAGUE env var: ${envSet ? defaultLeague : "(unset, falls back to 'Standard')"}`);

  // Warn if env var doesn't match an active league
  if (envSet && !apiSet.has(defaultLeague)) {
    lines.push("");
    lines.push("⚠ WARNING: POE_LEAGUE points to a league NOT in the active list.");
    lines.push("  This usually means a temp league ended and the env var is stale.");
    lines.push("  See playbooks/league-transition.md for the migration checklist.");
  } else if (envSet) {
    const cls = classifyLeague(defaultLeague);
    lines.push(`  ✓ Active. ${cls.isPermanent ? "Permanent league — no transition." : `Temp league — characters will move to "${cls.parent}" when it ends.`}`);
  }

  lines.push("");
  if (temp.length > 0) {
    lines.push(`Temp (challenge) leagues — currently ${temp.length}:`);
    for (const l of temp) {
      const cls = classifyLeague(l);
      const flags: string[] = [];
      if (cls.isHardcore) flags.push("HC");
      if (cls.isSsf) flags.push("SSF");
      if (cls.isRuthless) flags.push("Ruthless");
      const flagText = flags.length > 0 ? ` [${flags.join("/")}]` : "";
      lines.push(`  - ${l}${flagText}  → ends to "${cls.parent}"`);
    }
    lines.push("");
  }

  if (permanent.length > 0) {
    lines.push(`Permanent leagues — currently ${permanent.length}:`);
    for (const l of permanent) lines.push(`  - ${l}`);
    lines.push("");
  }

  lines.push("Notes:");
  lines.push("  • Tools that take a `league` argument default to POE_LEAGUE when omitted.");
  lines.push("  • Parent-league mapping is a naming-based heuristic; cross-check at transition.");
  lines.push("  • Use the existing `get_leagues` tool for the raw API passthrough.");

  return { content: [{ type: "text", text: lines.join("\n") }] };
}
