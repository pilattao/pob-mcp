import { wrapHandler } from '../utils/errorHandling.js';
import { TradeApiClient, tradeSearchUrl, tradeGame } from '../services/tradeClient.js';
import { TradeQueryBuilder } from '../services/tradeQueryBuilder.js';
import { StatMapper } from '../services/statMapper.js';
import { ItemRecommendationEngine, UpgradeContext, type ItemCandidateRecommendation } from '../services/itemRecommendationEngine.js';
import { ItemListing, SearchOptions, ItemRecommendation, ResistanceRequirements, BudgetConstraints, TradeQuery } from '../types/tradeTypes.js';
import { CostBenefitAnalyzer } from '../services/costBenefitAnalyzer.js';
import { PoeNinjaClient, withCurrencyAliases } from '../services/poeNinjaClient.js';
import type { AnyLuaClient } from '../pobLuaBridge.js';
import { resolveLeague } from '../services/leagueResolver.js';
import { prepareWeightedTradeQuery, validateWeightedTradeOptions } from '../services/weightedTradeQuery.js';

import type { EvidenceContext } from '../services/poe2BuildEvidence.js';
import { compareNativeTradeItems } from '../services/nativeTradeComparison.js';

interface TradeContext extends Partial<EvidenceContext> {
  tradeClient: TradeApiClient;
  statMapper?: StatMapper;
  recommendationEngine?: ItemRecommendationEngine;
  ninjaClient?: PoeNinjaClient;
}

interface WeightedTradeContext extends TradeContext {
  getLuaClient: () => AnyLuaClient | null;
  ensureLuaClient: () => Promise<void>;
}

// ========================================
// Trade Site URL Helpers
// ========================================

function getTradeSearchUrl(league: string, searchId: string): string {
  return tradeSearchUrl(league,searchId);
}

function getTradeItemUrl(league: string, searchId: string, itemId: string): string {
  // Individual items can be highlighted in the search results
  return `${tradeSearchUrl(league,searchId)}#${encodeURIComponent(itemId)}`;
}

// The MCP schema exposes `mods` with `stat_id` while the handler internally
// uses `stats` with `id` (the PoE trade API shape). Accept both and normalize
// so neither convention silently drops filters.
export function toStatFilters(
  stats?: Array<{ id: string; min?: number; max?: number }>,
  mods?: Array<{ stat_id: string; min?: number; max?: number }>
): Array<{ id: string; min?: number; max?: number }> {
  if (stats && stats.length > 0) return stats;
  if (mods && mods.length > 0) {
    return mods.map((mod) => ({ id: mod.stat_id, min: mod.min, max: mod.max }));
  }
  return [];
}

/**
 * Search the Path of Exile trade site for items
 */
export async function handleSearchTradeItems(
  context: TradeContext,
  args: {
    league: string;
    item_name?: string;
    item_type?: string;
    min_price?: number;
    max_price?: number;
    price_currency?: string;
    online_only?: boolean;
    online_status?: 'available' | 'online' | 'onlineleague' | 'securable' | 'any';
    rarity?: 'normal' | 'magic' | 'rare' | 'unique' | 'any';
    item_rarity?: 'normal' | 'magic' | 'rare' | 'unique' | 'any';
    min_links?: number;
    min_rune_sockets?: number;
    min_spirit?: number;
    min_ward?: number;
    corrupted?: boolean;
    identified?: boolean;
    stats?: Array<{ id: string; min?: number; max?: number }>;
    mods?: Array<{ stat_id: string; min?: number; max?: number }>;
    sort?: 'price_asc' | 'price_desc';
    limit?: number;
  }
): Promise<{
  content: Array<{
    type: string;
    text: string;
  }>;
}> {
  return wrapHandler('search trade items', async () => {
    const {
      league,
      item_name,
      item_type,
      min_price,
      max_price,
      price_currency = 'chaos',
      online_only = true,
      online_status,
      rarity,
      item_rarity,
      min_links,
      stats,
      mods,
      sort = 'price_asc',
      limit = 5,
    } = args;

    // Build the query
    const builder = new TradeQueryBuilder();

    if (item_name) {
      builder.withName(item_name);
    }

    if (item_type) {
      builder.withType(item_type);
    }

    const effectiveRarity = rarity ?? item_rarity;
    if (effectiveRarity) {
      builder.withRarity(effectiveRarity);
    }

    if (min_links !== undefined) {
      builder.withLinks(min_links);
    }

    if(args.min_rune_sockets!==undefined)builder.withRuneSockets(args.min_rune_sockets);
    if(args.min_spirit!==undefined)builder.withSpirit(args.min_spirit);
    if(args.min_ward!==undefined)builder.withWard(args.min_ward);
    if(args.corrupted!==undefined)builder.withItemState('corrupted',args.corrupted);
    if(args.identified!==undefined)builder.withItemState('identified',args.identified);
    const statFilters = toStatFilters(stats, mods);
    if (statFilters.length > 0) {
      builder.withStats(statFilters);
    }

    builder.applyOptions({
      league,
      onlineOnly: online_only,
      onlineStatus: online_status,
      minPrice: min_price,
      maxPrice: max_price,
      priceCurrency: price_currency,
      sort,
      limit,
    });

    const query = builder.build();

    if (!Number.isInteger(limit) || limit < 1 || limit > 20) throw new Error('limit must be an integer from 1 to 20');
    const searchResult = await context.tradeClient.searchItems(league, query);
    if (searchResult.total === 0) {
      return {content:[{type:'text',text:`No matching listings returned for ${league}.`} ]};
    }
    if (context.tradeClient.game === 'poe2') {
      const wanted = searchResult.result.slice(0,limit);
      const rows:ItemListing[]=[];
      for(let start=0;start<wanted.length;start+=10) rows.push(...await context.tradeClient.fetchItems(wanted.slice(start,start+10),searchResult.id));
      const matched=rows.filter(row=>row.item.league===league);
      const lines=[`=== PoE2 Trade Search (${league}) ===`, `Source matches: ${searchResult.total}; fetched: ${matched.length}/${wanted.length}`,
        `Search: ${getTradeSearchUrl(league,searchResult.id)}`,`Read at: ${new Date().toISOString()}`];
      if(matched.length<rows.length)lines.push('Some fetched items no longer belong to the requested league and were excluded.');
      for(const row of matched) {
        const price=row.listing.price;
        lines.push('',`## ${row.item.name || row.item.typeLine} (${row.item.typeLine})`,
          `Price: ${price ? `${price.amount} ${price.currency}` : 'not listed'}`,`Item level: ${row.item.ilvl ?? 'unknown'}`,`Listing ID: ${row.id}`);
        for(const key of ['implicitMods','explicitMods','enchantMods','runeMods','desecratedMods'] as const) {
          for(const mod of (row.item as any)[key] ?? [])lines.push(`- ${mod}`);
        }
      }
      lines.push('', 'Prices are the returned listing denominations. An explicit price currency filters those denominations; availability can change.');
      return {content:[{type:'text',text:lines.join('\n')}]};
    }

    const url = getTradeSearchUrl(league, searchResult.id);
    const output =
      `=== Trade Search (${league}) ===\n` +
      `Total listings: ${searchResult.total}\n` +
      `\n🔗 ${url}\n` +
      `\nOpen the link above to browse results on the trade site.\n` +
      `Note: This product is not affiliated with or endorsed by Grinding Gear Games.`;

    return {
      content: [{ type: 'text', text: output }],
    };
  });
}

/**
 * Get current market price for an item
 */
export async function handleGetItemPrice(
  context: TradeContext,
  args: {
    item_name: string;
    league?: string;
    item_type?: string;
    rarity?: 'unique' | 'rare' | 'magic' | 'normal';
    variant?: string;
    corrupted?: boolean;
    stats?: Array<{id:string;min?:number;max?:number}>;
  }
): Promise<{
  content: Array<{
    type: string;
    text: string;
  }>;
}> {
  return wrapHandler('get item price', async () => {
    const { item_name, item_type, rarity } = args;
    const league = resolveLeague(args.league);

    if (context.ninjaClient && (!rarity || rarity === 'unique')) {
      const price = await context.ninjaClient.getItemPrice(league,item_name,{variant:args.variant,corrupted:args.corrupted});
      if (price.status !== 'not-found') {
        return {content:[{type:'text',text:JSON.stringify({
          ...price,
          interpretation:'Aggregate source estimates. Variants and currencies remain separate; these are not exact-roll listing quotes.',
        },null,2)}]};
      }
    }

    // Fall back: build trade URL (one search POST, no listing fetch)
    const builder = new TradeQueryBuilder().withOnlineStatus('available');
    if(rarity && rarity !== 'unique') {
      if(!item_type)throw new Error('Rare/magic/normal comparison requires item_type (base or category); generated item names do not determine market value');
      if(args.stats?.length)builder.withStats(args.stats);
    } else builder.withName(item_name);

    if (item_type) builder.withType(item_type);
    if (rarity) builder.withRarity(rarity);
    builder.withSort('price', 'asc');

    const query = builder.build();
    const searchResult = await context.tradeClient.searchItems(league, query);

    if (!searchResult.result || searchResult.result.length === 0) {
      return {
        content: [{ type: 'text', text: `No listings found for "${item_name}" in ${league}.` }],
      };
    }

    const url = getTradeSearchUrl(league, searchResult.id);
    if(context.tradeClient.game==='poe2') {
      const rows=await context.tradeClient.fetchItems(searchResult.result.slice(0,10),searchResult.id);
      return {content:[{type:'text',text:JSON.stringify({game:'poe2',league,query:item_name,
        kind:rarity&&rarity!=='unique'?'comparable-listings':'listing-quotes',search:url,total:searchResult.total,
        prices:rows.filter(row=>row.item.league===league).map(row=>({id:row.id,name:row.item.name,baseType:row.item.typeLine,price:row.listing.price??null})),
        note:'These are returned listings matching the explicit filters, not a valuation of unseen rolls.',
      },null,2)}]};
    }
    return {
      content: [{
        type: 'text',
        text: `=== Price Check: ${item_name} ===\nLeague: ${league}\nTotal listings: ${searchResult.total}\n\n🔗 ${url}\n\nOpen the link above to see current prices.\nNote: This product is not affiliated with or endorsed by Grinding Gear Games.`,
      }],
    };
  });
}

/**
 * Get available leagues
 */
export async function handleGetLeagues(
  context: TradeContext
): Promise<{
  content: Array<{
    type: string;
    text: string;
  }>;
}> {
  return wrapHandler('get leagues', async () => {
    const leagueData = await context.tradeClient.getLeagues();

    if (!leagueData.result || leagueData.result.length === 0) {
      return {
        content: [
          {
            type: 'text',
            text: 'No leagues found.',
          },
        ],
      };
    }

    let output = '=== Available Leagues ===\n\n';

    for (const league of leagueData.result) {
      output += `- ${league.id}`;
      if (league.text) {
        output += ` (${league.text})`;
      }
      if (league.realm) {
        output += ` [${league.realm}]`;
      }
      output += '\n';
    }

    return {
      content: [
        {
          type: 'text',
          text: output,
        },
      ],
    };
  });
}

// ========================================
// Helper Functions
// ========================================

/**
 * Fetch and map currency rates from poe.ninja
 * Maps full currency names to short names used by trade API
 */
async function getCurrencyRatesMap(ninjaClient: PoeNinjaClient | undefined, league: string): Promise<Map<string, number>> {
  if (!ninjaClient) return new Map();
  const rates = await ninjaClient.getCurrencyExchangeMap(league);
  return withCurrencyAliases(rates);
}

async function formatSearchResults(items: ItemListing[], totalResults: number, league: string, searchId: string, ninjaClient?: PoeNinjaClient): Promise<string> {
  let output = `=== Trade Search (${league}) ===\n`;
  output += `Found: ${totalResults} | Showing: ${items.length}\n`;
  output += `🔗 ${getTradeSearchUrl(league, searchId)}\n\n`;

  // Fetch real-time currency rates from poe.ninja
  const currencyRates = await getCurrencyRatesMap(ninjaClient, league);

  // Analyze items for cost/benefit with real rates
  const analyzer = new CostBenefitAnalyzer();
  const analyses = analyzer.analyzeAndRank(items, currencyRates);

  for (let i = 0; i < analyses.length; i++) {
    const analysis = analyses[i];
    const listing = analysis.listing;
    const item = listing.item;
    const price = listing.listing.price;
    const seller = listing.listing.account;
    const metrics = analysis.metrics;

    // Rank by value, not by search order
    const valueRank = analysis.rank || (i + 1);
    const searchRank = items.indexOf(listing) + 1;

    output += `${searchRank}. ${item.name || item.typeLine}`;

    // Show value indicator
    const tierEmoji = {
      'excellent': ' 💎',
      'good': ' ✨',
      'average': '',
      'poor': ' ⚠️',
      'unknown': ' ?'
    }[metrics.valueTier];
    output += tierEmoji;

    if (metrics.isBudgetPick) {
      output += ' 💰';
    }

    output += `\n`;

    if (item.name && item.typeLine && item.name !== item.typeLine) {
      output += `   Base: ${item.typeLine}\n`;
    }

    if (price) {
      output += `   Price: ${price.amount} ${price.currency}`;
      if (analysis.priceInChaos !== undefined && analysis.priceInChaos > 0 && price.currency !== 'chaos') {
        output += ` (~${analysis.priceInChaos.toFixed(0)} chaos)`;
      }
      output += `\n`;
    } else {
      output += `   Price: Not listed\n`;
    }

    // Show value score
    output += `   Value: ${metrics.valueScore === undefined ? 'unknown' : metrics.valueScore.toFixed(0) + '/100'} (${metrics.valueTier})`;
    if (valueRank <= 3) {
      output += ` - #${valueRank} best value`;
    }
    output += `\n`;

    output += `   ilvl: ${item.ilvl}`;

    if (item.corrupted) {
      output += ' (Corrupted)';
    }

    output += '\n';

    // Links
    if (item.sockets && item.sockets.length > 0) {
      const maxLinks = getMaxLinks(item.sockets);
      if (maxLinks > 1) {
        output += `   Links: ${maxLinks}L\n`;
      }
    }

    // Show key stats in condensed format
    const stats = analysis.stats;
    const statParts: string[] = [];
    if (stats.life > 0) statParts.push(`+${stats.life} Life`);
    if (stats.es > 0) statParts.push(`+${stats.es} ES`);
    if (stats.totalResist > 0) statParts.push(`+${stats.totalResist}% Res`);
    if (statParts.length > 0) {
      output += `   Stats: ${statParts.join(', ')}\n`;
    }

    output += `   ${seller.online ? '🟢' : '🔴'} ${seller.name}\n`;
    output += `   🔗 ${getTradeItemUrl(league, searchId, listing.id)}\n\n`;
  }

  output += `\n💎=excellent ✨=good ⚠️=poor 💰=budget 🟢=online 🔴=offline`;
  return output;
}

function getMaxLinks(sockets: Array<{ group: number }>): number {
  const groups = new Map<number, number>();
  for (const socket of sockets) {
    const count = groups.get(socket.group) || 0;
    groups.set(socket.group, count + 1);
  }
  return Math.max(...groups.values());
}

/**
 * Search for stat IDs by name (fuzzy matching)
 */
export async function handleSearchStats(
  context: TradeContext,
  args: {
    query: string;
    limit?: number;
  }
): Promise<{
  content: Array<{
    type: string;
    text: string;
  }>;
}> {
  return wrapHandler('search stats', async () => {
    const { query, limit = 10 } = args;

    if (!context.statMapper) {
      return {
        content: [
          {
            type: 'text',
            text: 'Stat mapper not available.',
          },
        ],
      };
    }

    if (context.tradeClient.game === 'poe2') await context.statMapper.loadFromTradeAPI(await context.tradeClient.getStats());
    const results = context.statMapper.fuzzySearch(query, limit);

    if (results.length === 0) {
      return {
        content: [
          {
            type: 'text',
            text: `No stats found matching "${query}".`,
          },
        ],
      };
    }

    let output = `=== Stat Search Results for "${query}" ===\n\n`;
    output += `Found ${results.length} matching stats:\n\n`;

    for (let i = 0; i < results.length; i++) {
      const stat = results[i];
      output += `${i + 1}. ${stat.pobName}\n`;
      output += `   Trade ID: ${stat.tradeId}\n`;
      output += `   Category: ${stat.category}\n`;

      if (stat.description) {
        output += `   Description: ${stat.description}\n`;
      }

      if (stat.aliases.length > 0) {
        output += `   Aliases: ${stat.aliases.slice(0, 3).join(', ')}`;
        if (stat.aliases.length > 3) {
          output += ` (+${stat.aliases.length - 3} more)`;
        }
        output += '\n';
      }

      output += '\n';
    }

    output += `\nTo use in searches, reference the Trade ID in the stats parameter.`;

    return {
      content: [
        {
          type: 'text',
          text: output,
        },
      ],
    };
  });
}

// Phase 3: Recommendation Engine Handlers

export async function handleFindItemUpgrades(
  context: TradeContext,
  args: any
): Promise<{ content: Array<{ type: string; text: string }> }> {
  return wrapHandler('find item upgrades', async () => {
    const {
      slot,
      league,
      build_needs,
      current_item,
      max_price = 100,
      currency = 'chaos',
      limit = 5,
    } = args;

    if (!context.recommendationEngine) {
      return {
        content: [{ type: 'text', text: 'Recommendation engine not available.' }],
      };
    }

    const upgradeContext: UpgradeContext = {
      currentItem: current_item ? {
        name: current_item.name || 'Current Item',
        slot,
        life: current_item.life,
        es: current_item.es,
        resistances: {
          fire: current_item.fire_resist,
          cold: current_item.cold_resist,
          lightning: current_item.lightning_resist,
          chaos: current_item.chaos_resist,
        },
      } : undefined,
      itemRequirements: args.item_requirements,
      buildNeeds: {
        lifeNeeded: build_needs?.life,
        esNeeded: build_needs?.es,
        dpsTarget: build_needs?.dps,
        resistanceGaps: (build_needs && (build_needs.fire_resist || build_needs.cold_resist || build_needs.lightning_resist)) ? {
          fire: build_needs.fire_resist || 0,
          cold: build_needs.cold_resist || 0,
          lightning: build_needs.lightning_resist || 0,
          chaos: build_needs.chaos_resist || 0,
        } : undefined,
      },
      budget: {
        maxPricePerItem: max_price,
        totalBudget: max_price * 2,
        currency,
      },
      league,
    };

    const recommendations = await context.recommendationEngine.findUpgrades(slot, upgradeContext);

    if (recommendations.length === 0) {
      return {
        content: [{ type: 'text', text: `No upgrade recommendations found for ${slot} in ${league} within budget.` }],
      };
    }

    const output = formatItemRecommendations(recommendations.slice(0, limit), slot, league);
    return { content: [{ type: 'text', text: output }] };
  });
}

export async function handleFindResistanceGear(
  context: TradeContext,
  args: any
): Promise<{ content: Array<{ type: string; text: string }> }> {
  return wrapHandler('find resistance gear', async () => {
    const {
      league,
      fire_resist_needed = 0,
      cold_resist_needed = 0,
      lightning_resist_needed = 0,
      chaos_resist_needed = 0,
      max_price_per_item = 50,
      total_budget = 200,
      currency = 'chaos',
      slots,
      limit = 8,
    } = args;

    if (!Number.isInteger(limit) || limit < 1 || limit > 20) throw new Error('limit must be an integer from 1 to 20');

    if (!context.recommendationEngine) {
      throw new Error('Recommendation engine not available.');
    }

    const resistanceGaps: ResistanceRequirements = {
      fire: fire_resist_needed,
      cold: cold_resist_needed,
      lightning: lightning_resist_needed,
      chaos: chaos_resist_needed,
    };

    const budget: BudgetConstraints = {
      maxPricePerItem: max_price_per_item,
      totalBudget: total_budget,
      currency,
    };

    const recommendations = await context.recommendationEngine.findResistanceGear(
      resistanceGaps,
      budget,
      league,
      slots
    );

    if (recommendations.length === 0) {
      return {
        content: [{ type: 'text', text: `No resistance gear found in ${league} that matches your requirements within budget.` }],
      };
    }

    const output = formatResistanceRecommendations(recommendations.slice(0, limit), resistanceGaps, league, true);
    return { content: [{ type: 'text', text: output }] };
  });
}

function formatCandidateEvidence(rec: ItemRecommendation): string {
  const candidate = rec as Partial<ItemCandidateRecommendation>;
  const evidence = candidate.itemEvidence;
  const lines: string[] = [];
  if (evidence) {
    lines.push(`   Observed item contributions: ${JSON.stringify(Object.fromEntries(evidence.knownStats.map(key => [key, (evidence.stats as any)[key]])))}`);
    if (evidence.unparsedMods.length) lines.push(`   Mods not included in local scoring: ${evidence.unparsedMods.join('; ')}`);
    if (rec.statComparison) lines.push(`   Item contribution changes: ${JSON.stringify(rec.statComparison.delta)}`);
  }
  const cost = candidate.costBenefit;
  if (cost?.priceInBudgetCurrency !== undefined) lines.push(`   Reference budget value: ${cost.priceInBudgetCurrency} ${cost.budgetCurrency}`);
  for (const warning of rec.warnings ?? []) lines.push(`   ${warning}`);
  if (rec.listing.listing.indexed) lines.push(`   Listing indexed: ${rec.listing.listing.indexed}`);
  return lines.length ? lines.join('\n') + '\n' : '';
}

function formatItemRecommendations(
  recommendations: ItemRecommendation[],
  slot: string,
  league: string,
  includeLinks: boolean = false
): string {
  let output = `=== ${slot} Upgrades (${league}) ===\n`;
  output += `${recommendations.length} found\n\n`;

  for (const rec of recommendations) {
    const item = rec.listing.item;
    const price = rec.listing.listing.price;

    output += `${rec.rank}. ${item.name || item.typeLine}`;
    if (rec.priority === 'high') output += ' ⭐';
    output += `\n`;

    if (item.name && item.typeLine && item.name !== item.typeLine) {
      output += `   Base: ${item.typeLine}\n`;
    }

    output += `   Candidate fit score: ${rec.score.toFixed(1)}/100 (${rec.priority} priority)\n`;

    if (price) {
      output += `   Price: ${price.amount} ${price.currency}\n`;
    }

    if (rec.costBenefit) {
      const cb = rec.costBenefit;
      if (cb.lifeGain && cb.lifeGain > 0) {
        output += `   Item Life delta: +${cb.lifeGain}\n`;
      }
      if (cb.esGain && cb.esGain > 0) {
        output += `   Item ES delta: +${cb.esGain}\n`;
      }
      if (cb.efficiency) {
        output += `   Efficiency: ${cb.efficiency.toFixed(2)} points per ${cb.currency}\n`;
      }
    }

    if (rec.reasons.length > 0) {
      output += `   Why:\n`;
      for (const reason of rec.reasons.slice(0, 3)) {
        output += `     - ${reason}\n`;
      }
    }

    output += formatCandidateEvidence(rec);
    output += `   ${rec.listing.listing.account.online ? '🟢' : '🔴'} ${rec.listing.listing.account.name}\n`;
    output += `   🔗 ${getTradeItemUrl(league, rec.searchId, rec.listing.id)}\n\n`;
  }

  return output;
}

function formatResistanceRecommendations(
  recommendations: ItemRecommendation[],
  resistanceGaps: ResistanceRequirements,
  league: string,
  includeLinks: boolean = false
): string {
  const targets = [];
  if (resistanceGaps.fire > 0) targets.push(`${resistanceGaps.fire}% Fire`);
  if (resistanceGaps.cold > 0) targets.push(`${resistanceGaps.cold}% Cold`);
  if (resistanceGaps.lightning > 0) targets.push(`${resistanceGaps.lightning}% Lightning`);
  if (resistanceGaps.chaos && resistanceGaps.chaos > 0) targets.push(`${resistanceGaps.chaos}% Chaos`);

  let output = `=== Resistance Gear (${league}) ===\n`;
  output += `Need: ${targets.join(', ')}\n`;
  output += `${recommendations.length} found\n\n`;

  for (const rec of recommendations) {
    const item = rec.listing.item;
    const price = rec.listing.listing.price;

    output += `${rec.rank}. ${item.name || item.typeLine}`;
    if (rec.priority === 'high') output += ' ⭐';
    output += `\n`;

    if (item.typeLine && item.name !== item.typeLine) {
      output += `   Type: ${item.typeLine}\n`;
    }

    output += `   Candidate fit score: ${rec.score.toFixed(1)}/100 (${rec.priority} priority)\n`;

    if (price) {
      output += `   Price: ${price.amount} ${price.currency}\n`;
    }

    if (rec.costBenefit.resistGain) {
      const gains = [];
      const rg = rec.costBenefit.resistGain;
      if (rg.fire) gains.push(`${rg.fire}% Fire`);
      if (rg.cold) gains.push(`${rg.cold}% Cold`);
      if (rg.lightning) gains.push(`${rg.lightning}% Lightning`);
      if (rg.chaos) gains.push(`${rg.chaos}% Chaos`);

      if (gains.length > 0) {
        output += `   Provides: ${gains.join(', ')}\n`;
      }
    }

    if (rec.costBenefit.efficiency) {
      output += `   Efficiency: ${rec.costBenefit.efficiency.toFixed(2)} resist per ${rec.costBenefit.currency}\n`;
    }

    if (rec.reasons.length > 0) {
      output += `   Why:\n`;
      for (const reason of rec.reasons.slice(0, 2)) {
        output += `     - ${reason}\n`;
      }
    }

    output += formatCandidateEvidence(rec);
    output += `   ${rec.listing.listing.account.online ? '🟢' : '🔴'} ${rec.listing.listing.account.name}\n`;
    output += `   🔗 ${getTradeItemUrl(league, rec.searchId, rec.listing.id)}\n\n`;
  }

  return output;
}

/**
 * Compare multiple trade items side-by-side
 */
export async function handleCompareTradeItems(
  context: TradeContext,
  args: {
    item_ids: string[];
    evaluate_native?: boolean;
    slot?: string;
    build_name?: string;
    query_id?: string;
    league?: string;
    build_context?: {
      life_needed?: number;
      es_needed?: number;
      dps_target?: number;
      fire_resist_needed?: number;
      cold_resist_needed?: number;
      lightning_resist_needed?: number;
    };
  }
): Promise<{
  content: Array<{
    type: string;
    text: string;
  }>;
}> {
  return wrapHandler('compare trade items', async () => {
    const { item_ids, build_context } = args;
    if (args.evaluate_native!==undefined && typeof args.evaluate_native!=='boolean') throw new Error('evaluate_native must be boolean');
    if (args.evaluate_native && !args.slot?.trim()) throw new Error('Native comparison requires the exact equipment slot');

    if (!item_ids || item_ids.length === 0) {
      return {
        content: [{ type: 'text', text: 'No item IDs provided for comparison.' }],
      };
    }

    if (item_ids.length > 5) {
      return {
        content: [{ type: 'text', text: 'Can only compare up to 5 items at once.' }],
      };
    }

    const items = await context.tradeClient.fetchItems(item_ids,args.query_id);

    if (items.length === 0) {
      return {
        content: [{ type: 'text', text: 'No items found with the provided IDs.' }],
      };
    }

    if(context.tradeClient.game==='poe2') {
      const leagues=new Set(items.map(row=>row.item.league));
      const league=args.league??(leagues.size===1?[...leagues][0]:undefined);
      if(!league || items.some(row=>row.item.league!==league))throw new Error('Comparison items must belong to the requested single PoE2 league');
      const rates=await getCurrencyRatesMap(context.ninjaClient,league);
      const analyzer=new CostBenefitAnalyzer();
      const evidence=items.map(item=>analyzer.analyzeItem(item,rates));
      const unavailableListingIds=item_ids.filter(id=>!items.some(item=>item.id===id));
      let nativeComparison;
      if (args.evaluate_native === true) {
        if (!context.buildService) throw new Error('Native comparison build service is unavailable');
        nativeComparison=await compareNativeTradeItems({...context,buildService:context.buildService},items,args.slot ?? '',args.build_name);
      }
      return {content:[{type:'text',text:JSON.stringify({game:'poe2',league,scope:nativeComparison?'native-build-and-item-evidence':'item-evidence',nativeComparison,unavailableListingIds,
        items:evidence.map(row=>({id:row.listing.id,name:row.listing.item.name,baseType:row.listing.item.typeLine,
          price:row.priceEvidence,stats:Object.fromEntries(row.knownStats.map(key=>[key,(row.stats as any)[key]])),
          unparsedMods:row.unparsedMods,warnings:row.metrics.warnings})),
        buildContext:build_context??null,note:'Displayed item stats and reference price conversions are not build DPS/EHP or a guarantee that the item can be equipped.',
      },null,2)}]};
    }
    const output = formatItemComparison(items, build_context);
    return { content: [{ type: 'text', text: output }] };
  });
}

function formatItemComparison(
  items: ItemListing[],
  buildContext?: {
    life_needed?: number;
    es_needed?: number;
    dps_target?: number;
    fire_resist_needed?: number;
    cold_resist_needed?: number;
    lightning_resist_needed?: number;
  }
): string {
  let output = `=== Item Comparison (${items.length}) ===\n\n`;

  const itemStats = items.map(listing => {
    const item = listing.item;
    const price = listing.listing.price;

    return {
      name: item.name || item.typeLine,
      typeLine: item.typeLine,
      price: price ? price.amount + ' ' + price.currency : 'No price',
      priceAmount: price?.amount || 0,
      ilvl: item.ilvl,
      corrupted: item.corrupted || false,
      links: item.sockets ? getMaxLinks(item.sockets) : 0,
      life: extractStatValue(item, 'life'),
      es: extractStatValue(item, 'energy shield'),
      armour: extractStatValue(item, 'armour'),
      evasion: extractStatValue(item, 'evasion'),
      fireResist: extractResistValue(item, 'fire'),
      coldResist: extractResistValue(item, 'cold'),
      lightningResist: extractResistValue(item, 'lightning'),
      chaosResist: extractResistValue(item, 'chaos'),
      seller: listing.listing.account.name,
      online: listing.listing.account.online,
    };
  });

  const maxLife = Math.max(...itemStats.map(i => i.life));
  const maxES = Math.max(...itemStats.map(i => i.es));
  const minPrice = Math.min(...itemStats.filter(i => i.priceAmount > 0).map(i => i.priceAmount));

  for (let i = 0; i < itemStats.length; i++) {
    const stats = itemStats[i];
    output += (i + 1) + '. ' + stats.name + '\n';

    if (stats.name !== stats.typeLine) {
      output += '   Base: ' + stats.typeLine + '\n';
    }

    output += '   Price: ' + stats.price;
    if (stats.priceAmount === minPrice && minPrice > 0) {
      output += ' 💰 (Best Value)';
    }
    output += '\n';

    output += '   ilvl: ' + stats.ilvl;
    if (stats.corrupted) output += ' (Corrupted)';
    output += '\n';

    if (stats.links > 0) {
      output += '   Links: ' + stats.links + 'L\n';
    }

    if (stats.life > 0) {
      output += '   Life: +' + stats.life;
      if (stats.life === maxLife) output += ' ⭐';
      if (buildContext?.life_needed && stats.life >= buildContext.life_needed) {
        output += ' ✓';
      }
      output += '\n';
    }

    if (stats.es > 0) {
      output += '   ES: +' + stats.es;
      if (stats.es === maxES) output += ' ⭐';
      if (buildContext?.es_needed && stats.es >= buildContext.es_needed) {
        output += ' ✓';
      }
      output += '\n';
    }

    if (stats.armour > 0) {
      output += '   Armour: ' + stats.armour + '\n';
    }

    if (stats.evasion > 0) {
      output += '   Evasion: ' + stats.evasion + '\n';
    }

    const resists = [];
    if (stats.fireResist > 0) {
      let resistStr = stats.fireResist + '% Fire';
      if (buildContext?.fire_resist_needed && stats.fireResist >= buildContext.fire_resist_needed) {
        resistStr += ' ✓';
      }
      resists.push(resistStr);
    }
    if (stats.coldResist > 0) {
      let resistStr = stats.coldResist + '% Cold';
      if (buildContext?.cold_resist_needed && stats.coldResist >= buildContext.cold_resist_needed) {
        resistStr += ' ✓';
      }
      resists.push(resistStr);
    }
    if (stats.lightningResist > 0) {
      let resistStr = stats.lightningResist + '% Lightning';
      if (buildContext?.lightning_resist_needed && stats.lightningResist >= buildContext.lightning_resist_needed) {
        resistStr += ' ✓';
      }
      resists.push(resistStr);
    }
    if (stats.chaosResist > 0) {
      resists.push(stats.chaosResist + '% Chaos');
    }

    if (resists.length > 0) {
      output += '   Resistances: ' + resists.join(', ') + '\n';
    }

    output += '   Seller: ' + stats.seller;
    if (stats.online) output += ' (Online)';
    output += '\n\n';
  }

  output += '=== Summary ===\n';
  output += '⭐ = Best value for that stat\n';
  output += '✓ = Meets build requirement\n';
  output += '💰 = Cheapest option\n';

  return output;
}

function extractStatValue(item: any, statName: string): number {
  const allMods = [
    ...(item.explicitMods || []),
    ...(item.implicitMods || []),
    ...(item.craftedMods || []),
  ];

  for (const mod of allMods) {
    if (mod.toLowerCase().includes(statName.toLowerCase())) {
      const match = mod.match(/(\d+)/);
      if (match) {
        return parseInt(match[1], 10);
      }
    }
  }

  return 0;
}

function extractResistValue(item: any, element: string): number {
  const allMods = [
    ...(item.explicitMods || []),
    ...(item.implicitMods || []),
    ...(item.craftedMods || []),
  ];

  let total = 0;

  for (const mod of allMods) {
    const lowerMod = mod.toLowerCase();

    if (lowerMod.includes(element + ' resistance')) {
      const match = mod.match(/\+?(\d+)%/);
      if (match) total += parseInt(match[1], 10);
    }

    if ((element === 'fire' || element === 'cold' || element === 'lightning') &&
        (lowerMod.includes('all elemental resistances') || lowerMod.includes('to all resistances'))) {
      const match = mod.match(/\+?(\d+)%/);
      if (match) total += parseInt(match[1], 10);
    }
  }

  return total;
}

/**
 * Execute the loaded build's native weighted query and fetch a bounded listing
 * sample in source order. Search weights do not establish per-item DPS or value.
 */
export async function handleFindWeightedTradeItems(
  context: WeightedTradeContext,
  args: {
    league: string;
    slot: string;
    options?: Record<string, unknown>;
    limit?: number;
  }
): Promise<{ content: Array<{ type: string; text: string }> }> {
  return wrapHandler('find weighted trade items', async () => {
    const { league, slot, options, limit = 5 } = args;
    if (typeof league !== 'string' || !league.trim() || league !== league.trim()) throw new Error('An exact league is required');
    if (typeof slot !== 'string' || !slot.trim()) throw new Error('slot is required (e.g. "Belt", "Ring 1", "Body Armour")');
    if (!Number.isInteger(limit) || limit < 1 || limit > 20) throw new Error('limit must be an integer from 1 to 20');
    validateWeightedTradeOptions(options);

    await context.ensureLuaClient();
    const luaClient = context.getLuaClient();
    if (!luaClient) throw new Error('Lua client not initialized — load a build first');

    const { query: pobQuery, warning } = await luaClient.generateWeightedTradeQuery(slot, options);
    const game = context.tradeClient.game;
    const prepared = prepareWeightedTradeQuery(pobQuery, game);
    const searchResult = await context.tradeClient.searchItems(league, prepared.query);
    const wanted = [...new Set(searchResult.result.slice(0, limit))];
    const fetched: ItemListing[] = [];
    for (let start = 0; start < wanted.length; start += 10) {
      fetched.push(...await context.tradeClient.fetchItems(wanted.slice(start, start + 10), searchResult.id));
    }
    const byId = new Map(fetched.filter(row => row.item.league === league && wanted.includes(row.id)).map(row => [row.id, row]));
    const items = wanted.flatMap(id => byId.has(id) ? [byId.get(id)!] : []);
    const url = tradeSearchUrl(league, searchResult.id, game);
    const apiPath = game === 'poe2' ? 'trade2/search/poe2' : 'trade/search';
    const lines = [`=== Weighted Trade Search (${league}, slot: ${slot}) ===`,
      `Game: ${game}`, `Query ID: ${searchResult.id}`,
      `Source: https://www.pathofexile.com/api/${apiPath}/${encodeURIComponent(league)}`,
      `Search: ${url}`, `Read at: ${new Date().toISOString()}`,
      `Total source matches: ${searchResult.total}${searchResult.inexact ? ' (inexact)' : ''}`,
      `Requested listing IDs: ${wanted.length}; displayed: ${items.length}; limit: ${limit}`,
      `Active weighted mods: ${prepared.weightedMods}`];
    if (warning) lines.push(`PoB warning: ${warning}`);
    lines.push(...prepared.changes);
    const priceFilter = prepared.query.query.filters?.trade_filters?.filters?.price;
    if (priceFilter?.option) lines.push(`Price option: ${priceFilter.option}. A currency denomination filter selects listings in that denomination; it is not a converted budget across currencies.`);
    if (!wanted.length) lines.push('No matching listings returned by the source.');
    else if (items.length < wanted.length) lines.push(`${wanted.length - items.length} requested listings were unavailable or excluded because their league did not match; no replacement search was made.`);
    for (const [index, row] of items.entries()) {
      const price = row.listing.price;
      const priceText = price && Number.isFinite(price.amount) && price.amount >= 0 && typeof price.currency === 'string' && price.currency.trim() ?
        `${price.amount} ${price.currency}` : 'not listed';
      lines.push('', `${index + 1}. ${row.item.name || row.item.typeLine}`,
        `Base: ${row.item.typeLine}`, `League: ${row.item.league}`, `Price: ${priceText}`,
        `Item level: ${row.item.ilvl ?? 'unknown'}`, `Listing ID: ${row.id}`,
        `Indexed at source: ${row.listing.indexed ?? 'unknown'}`, `Listing: ${url}#${encodeURIComponent(row.id)}`);
      for (const mods of [row.item.implicitMods, row.item.explicitMods, row.item.craftedMods, row.item.enchantMods, row.item.fracturedMods]) {
        if (Array.isArray(mods)) lines.push(...mods.filter(mod => typeof mod === 'string'));
      }
    }
    lines.push('', 'Listings retain the weighted search order. Asking prices and generated weights do not establish item-specific DPS/EHP gains, market valuation or completed sales.',
      'Read-only search; no trades or messages were sent. This product is not affiliated with or endorsed by Grinding Gear Games.');
    return { content: [{ type: 'text', text: lines.join('\n') }] };
  });
}
