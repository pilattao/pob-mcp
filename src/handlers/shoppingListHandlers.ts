/** Selected-build shopping evidence and public candidate listings. No build writes. */
import { wrapHandler } from '../utils/errorHandling.js';
import { ShoppingListService, type BudgetTier, type ShoppingDependencies, type ShoppingList, type ShoppingOptions, type ShoppingRequirements } from '../services/shoppingListService.js';
import { readPoe2BuildEvidence, type EvidenceContext } from '../services/poe2BuildEvidence.js';
import type { TradeApiClient } from '../services/tradeClient.js';
import type { StatMapper } from '../services/statMapper.js';
import type { PoeNinjaClient } from '../services/poeNinjaClient.js';
import type { ItemRecommendationEngine } from '../services/itemRecommendationEngine.js';
import type { SkillGemService, GemReadOptions } from '../services/skillGemService.js';

export interface ShoppingListContext extends EvidenceContext {
  tradeClient?: TradeApiClient;
  statMapper?: StatMapper;
  ninjaClient?: PoeNinjaClient;
  recommendationEngine?: ItemRecommendationEngine;
  skillGemService?: SkillGemService;
  shoppingDependencies?: ShoppingDependencies;
}
export interface ShoppingListArgs {
  build_name?: string;
  league?: string;
  /** Numeric spending limit, or the legacy descriptive tier. */
  budget?: number | BudgetTier;
  budget_tier?: BudgetTier;
  currency?: string;
  max_price?: number;
  slots?: string[];
  item_requirements?: Record<string, ShoppingRequirements>;
  rune_targets?: Record<string, string[]>;
  include_gems?: boolean;
  priority?: ShoppingOptions['priority'];
  limit?: number;
  max_searches?: number;
}

export async function handleGenerateShoppingList(context: ShoppingListContext, args: ShoppingListArgs) {
  return wrapHandler('generate shopping list', async () => {
    const evidence = await readPoe2BuildEvidence(context, args.build_name);
    const client = context.getLuaClient?.();
    const gemOptions: GemReadOptions = { client };
    if (evidence.source === 'live' && client && args.include_gems !== false) gemOptions.liveSkills = await client.getSkills();
    const service = new ShoppingListService(context.tradeClient, context.statMapper, context.ninjaClient, {
      recommendationEngine: context.recommendationEngine, skillGemService: context.skillGemService, ...context.shoppingDependencies,
    });
    const result = await service.generateShoppingList(evidence.build, args.build_name ?? 'Current PoB2 build', args.league ?? '',
      args.budget_tier ?? (typeof args.budget === 'string' ? args.budget : 'medium'), {
        budget: typeof args.budget === 'number' ? args.budget : undefined, currency: args.currency, maxPricePerItem: args.max_price,
        slots: args.slots, itemRequirements: args.item_requirements, runeTargets: args.rune_targets, includeGems: args.include_gems,
        priority: args.priority, limitPerSlot: args.limit, maxSearches: args.max_searches, stats: evidence.stats, sourceNote: evidence.note, source: evidence.source, gemOptions,
      });
    return { content: [{ type: 'text', text: formatShoppingList(result) }] };
  });
}

export function formatShoppingList(list: ShoppingList): string {
  const lines = [`=== PoE2 Shopping List: ${list.buildName} ===`, list.source.note,
    `League: ${list.league || 'not specified'}`, `Item set: ${list.selection.itemSetId ?? 'unknown'}; weapon set: ${list.selection.weaponSet}; skill set: ${list.selection.skillSetId}`,
    `Entries: ${list.summary.totalItems}; quoted: ${list.summary.quotedItems}; unpriced: ${list.summary.unpricedItems}`];
  if (list.summary.requestedBudget !== undefined) lines.push(`Requested total budget: ${list.summary.requestedBudget} ${list.summary.currency}`);
  lines.push(list.summary.quotedSubtotal === undefined ? 'Quoted subtotal: unknown' : `Quoted subtotal for covered entries: ${list.summary.quotedSubtotal} ${list.summary.currency} (reference conversion where needed)`);
  const gaps = Object.entries(list.buildNeeds.resistanceGaps).map(([r, n]) => `${r}: ${n}`);
  lines.push(`Measured resistance shortfalls: ${gaps.length ? gaps.join(', ') : 'unknown'}`);
  if (Object.keys(list.buildNeeds.attributes).length) lines.push(`Measured attribute shortfalls: ${JSON.stringify(list.buildNeeds.attributes)}`);
  if (list.buildNeeds.spiritShortfall !== undefined) lines.push(`Measured Spirit shortfall: ${list.buildNeeds.spiritShortfall}`);
  for (const row of list.items) {
    lines.push('', `## ${row.slot} [${row.kind}, ${row.priority}]`);
    if (row.currentItem) lines.push(`Current: ${row.currentItem.name} — ${row.currentItem.baseType} (${row.currentItem.rarity}; item ID ${row.currentItem.id ?? 'inline'})`);
    lines.push(...row.reason);
    if (Object.keys(row.requirements).length) lines.push(`Candidate requirements: ${JSON.stringify(row.requirements)}`);
    if (row.gem) lines.push(`Gem identity and target requirements: ${JSON.stringify(row.gem)}`);
    if (row.search.url) lines.push(`Trade search: ${row.search.url}`);
    for (const candidate of row.candidates) {
      lines.push(`- Candidate ${candidate.listingId}: ${candidate.name} — ${candidate.baseType}`,
        `  Asking price: ${candidate.price ? `${candidate.price.amount} ${candidate.price.currency}` : 'unpriced'}`,
        `  Search: ${candidate.url}`, `  Source: PoE2 trade, ${candidate.source.league}; query ${candidate.source.queryId}; checked ${candidate.source.checkedAt}${candidate.source.indexed ? `; indexed ${candidate.source.indexed}` : ''}`);
      if (candidate.mods.length) lines.push(`  Item mods: ${candidate.mods.join('; ')}`);
      lines.push(...candidate.warnings.map(w => `  ${w}`));
    }
    if (!row.candidates.length) lines.push('No candidate listing was obtained; this entry is unpriced.');
    if (row.referencePrice) lines.push(`Reference estimate only: ${row.referencePrice.primaryValue} ${row.referencePrice.primaryCurrency}; ${row.referencePrice.name}`,
      `Reference source: ${JSON.stringify(row.referencePrice.provenance)}`);
    if (!row.search.url && row.search.query) lines.push(`Search query: ${JSON.stringify(row.search.query)}`);
    lines.push(...row.warnings);
  }
  if (list.runes.length) {
    lines.push('', '## Rune socket evidence');
    for (const rune of list.runes) lines.push(`${rune.slot}: capacity ${rune.capacity ?? 'unknown'}, socketed ${rune.occupied.join(', ') || 'none observed'}, empty ${rune.empty ?? 'unknown'}`, ...rune.warnings);
  }
  lines.push('', `Charm capacity: ${list.charms.capacity ?? 'unknown'} (${list.charms.capacitySource}); equipped in selected set: ${list.charms.equipped}`, ...list.charms.warnings);
  if (list.gems.length) {
    lines.push('', '## Selected enabled gems');
    for (const gem of list.gems) lines.push(`Group ${gem.groupIndex}, gem ${gem.gemIndex}: ${gem.name} (${gem.gemId ?? 'unresolved ID'}), level ${gem.level ?? 'unknown'}, natural cap ${gem.naturalMaxLevel ?? 'unknown'}${gem.source ? `, granted by ${gem.source}` : ''}`);
  }
  lines.push('', ...list.warnings);
  return lines.join('\n');
}
