/** Searches real listings and compares item evidence; build outcomes need PoB. */
import { TradeApiClient } from './tradeClient.js';
import { TradeQueryBuilder } from './tradeQueryBuilder.js';
import { StatMapper } from './statMapper.js';
import { ItemListing, ItemRequirements, BudgetConstraints, ItemRecommendation, ResistanceRequirements } from '../types/tradeTypes.js';
import { CostBenefitAnalyzer, ItemValueAnalysis, StatExtraction, getChaosRate, normalizeCurrencyId, priceInCurrency } from './costBenefitAnalyzer.js';

export interface CurrencyRateClient {
  getCurrencyExchangeMap(league: string): Promise<Map<string, number>>;
}

/** Verified trade2 semantics: body-armour Spirit is a flat modifier, not the
 * maximum-quality equipment Spirit property indexed for weapons. */
export function applyItemSpiritRequirement(builder: TradeQueryBuilder, min: number, mapper?: StatMapper): void {
  const category = builder.build().query.filters?.type_filters?.filters?.category?.option;
  if (category === 'armour.chest') {
    const id = 'explicit.stat_3981240776';
    if (!mapper?.getPobName(id)) throw new Error('Required body-armour Spirit stat is absent from verified trade metadata.');
    builder.withStats([{ id, min }]);
  } else {
    builder.withSpirit(min);
  }
}

export interface UpgradeContext {
  currentItem?: {
    name: string;
    slot: string;
    /** Raw item contribution, not whole-build life/ES. */
    life?: number;
    es?: number;
    resistances?: { fire?: number; cold?: number; lightning?: number; chaos?: number };
    dps?: number;
  };
  buildNeeds: {
    /** Requested item contribution; with a known current value, requested delta. */
    resistanceGaps?: ResistanceRequirements;
    lifeNeeded?: number;
    esNeeded?: number;
    /** Retained as context only. Native calculation is required to evaluate it. */
    dpsTarget?: number;
  };
  /** Explicit candidate constraints; minDPS/PDPS/EDPS mean displayed weapon DPS. */
  itemRequirements?: Omit<ItemRequirements, 'slot'> & { baseType?: string };
  budget: BudgetConstraints;
  league: string;
  /** Actual chaos equivalents for this league. Overrides the injected client. */
  currencyRates?: Map<string, number>;
}

export interface ItemCandidateRecommendation extends ItemRecommendation {
  itemEvidence: { scope: 'item'; stats: StatExtraction; knownStats: string[]; unparsedMods: string[] };
  costBenefit: ItemRecommendation['costBenefit'] & {
    priceInChaos?: number;
    priceInBudgetCurrency: number;
    budgetCurrency: string;
    /** efficiency retains its original listing-currency denominator. */
    efficiencyCurrency: string;
  };
}

type StatRequirement = { stat: keyof StatExtraction; min: number };
const resists = ['fire', 'cold', 'lightning', 'chaos'] as const;
const nativeWarning = 'Item modifiers and displayed weapon DPS are candidate evidence; whole-build gains require a native PoB calculation.';

export class ItemRecommendationEngine {
  private readonly analyzer = new CostBenefitAnalyzer();

  constructor(private tradeClient: TradeApiClient, private statMapper: StatMapper, private currencyClient?: CurrencyRateClient) {}

  async findUpgrades(slot: string, context: UpgradeContext): Promise<ItemCandidateRecommendation[]> {
    const { builder, requirements, maxPrice } = this.buildUpgradeQuery(slot, context);
    if (maxPrice === 0) return [];
    const { rates, warning } = await this.getRates(context);
    const currency = normalizeCurrencyId(context.budget.currency);
    const budgetRate = getChaosRate(currency, rates), exaltedRate = getChaosRate('exalted', rates);
    const equivalentMax = currency === 'exalted' ? maxPrice : budgetRate === undefined || exaltedRate === undefined ? undefined : maxPrice * budgetRate / exaltedRate;
    const usesEquivalent = this.tradeClient.game === 'poe2' && equivalentMax !== undefined && Number.isFinite(equivalentMax) && equivalentMax > 0;
    if (usesEquivalent) builder.withPriceRange(undefined, equivalentMax, null);
    const search = await this.tradeClient.searchItems(context.league, builder.build());
    if (!search.result?.length) return [];
    const ids = [...new Set(search.result)].slice(0, 20);
    const listings: ItemListing[] = [];
    for (let offset = 0; offset < ids.length; offset += 10) {
      listings.push(...await this.tradeClient.fetchItems(ids.slice(offset, offset + 10), search.id));
    }
    const seen = new Set<string>();
    const recommendations: ItemCandidateRecommendation[] = [];
    for (const listing of listings) {
      if (!listing || seen.has(listing.id)) continue;
      seen.add(listing.id);
      const analysis = this.analyzer.analyzeItem(listing, rates);
      const comparablePrice = priceInCurrency(analysis.priceEvidence, context.budget.currency, rates);
      // Unknown price/rate is not proof of affordability. Keep these items in the
      // general comparison analyzer, but exclude them from budgeted candidates.
      if (comparablePrice === undefined || comparablePrice > maxPrice) continue;
      if (!this.matchesEvidence(listing, analysis, requirements, context)) continue;
      const recommendation = this.scoreItem(analysis, context, search.id, comparablePrice, maxPrice, requirements, warning);
      recommendation.warnings!.push('Bounded sample of up to 20 search results; ranking does not establish the best item across the market.');
      if (!usesEquivalent) recommendation.warnings!.push(`Search is limited to listings denominated in ${currency}; listings in other quote currencies may be missed.`);
      if (usesEquivalent || normalizeCurrencyId(analysis.priceEvidence.currency!) !== currency) {
        recommendation.warnings!.push('Budget comparisons use reference exchange rates, not executable currency quotes; the listing price and currency remain the actual asking price.');
      }
      recommendations.push(recommendation);
    }
    return this.rank(recommendations);
  }

  /** Independent candidate alternatives, not a jointly affordable shopping set. */
  async findResistanceGear(resistanceGaps: ResistanceRequirements, budget: BudgetConstraints, league: string, slots?: string[]): Promise<ItemCandidateRecommendation[]> {
    this.validateGaps(resistanceGaps);
    if (!resists.some(r => (resistanceGaps[r] ?? 0) > 0)) throw new Error('Specify at least one positive resistance requirement.');
    const context: UpgradeContext = { buildNeeds: { resistanceGaps }, budget, league };
    const { rates, warning } = await this.getRates(context);
    const searchSlots = slots ?? ['Ring 1', 'Amulet', 'Belt', 'Gloves', 'Boots', 'Helmet'];
    const unique = new Map<string, ItemCandidateRecommendation>();
    const searched = new Set<string>();
    for (const slot of searchSlots) {
      const key = /^Ring [123]$/.test(slot) ? `Ring:${budget.preferredBudgetDistribution?.[slot] ?? ''}` : slot;
      if (searched.has(key)) continue;
      searched.add(key);
      const candidates = await this.findUpgrades(slot, { ...context, currencyRates: rates });
      for (const candidate of candidates) {
        if (warning) candidate.warnings!.push(warning);
        candidate.warnings!.push('Independent item alternative; replacing current gear and buying several items requires a new build and total-budget check.');
        const existing = unique.get(candidate.listing.id);
        if (!existing || candidate.score > existing.score) unique.set(candidate.listing.id, candidate);
      }
    }
    return this.rank([...unique.values()]).slice(0, 20);
  }

  private async getRates(context: UpgradeContext): Promise<{ rates: Map<string, number>; warning?: string }> {
    if (context.currencyRates) return { rates: context.currencyRates };
    if (!this.currencyClient) return { rates: new Map() };
    try {
      return { rates: await this.currencyClient.getCurrencyExchangeMap(context.league) };
    } catch {
      return { rates: new Map(), warning: 'Currency quotes unavailable; only listings whose budget can be verified without those quotes are included.' };
    }
  }

  private rank(recommendations: ItemCandidateRecommendation[]): ItemCandidateRecommendation[] {
    // Within each result set all compared costs have the same budget unit.
    recommendations.sort((a, b) => b.score - a.score || a.costBenefit.priceInBudgetCurrency - b.costBenefit.priceInBudgetCurrency);
    recommendations.forEach((rec, index) => { rec.rank = index + 1; });
    return recommendations;
  }

  private scoreItem(analysis: ItemValueAnalysis, context: UpgradeContext, searchId: string, budgetPrice: number,
    maxPrice: number, requirements: StatRequirement[], rateWarning?: string): ItemCandidateRecommendation {
    const { listing, stats, knownStats, priceEvidence } = analysis;
    // findUpgrades already verified a real positive listing price and affordability.
    const amount = priceEvidence.amount!, currency = priceEvidence.currency!;
    const warnings = [nativeWarning];
    const reasons: string[] = [];
    if (rateWarning) warnings.push(rateWarning);
    if (priceEvidence.priceInChaos === undefined) warnings.push(`No verified chaos conversion rate for ${currency}; points per chaos are unavailable.`);
    if (!context.currentItem) warnings.push('Current item baseline is missing; candidate contributions are not replacement gains.');
    else {
      const missingBaseline = (context.buildNeeds.lifeNeeded !== undefined && context.currentItem.life === undefined)
        || (context.buildNeeds.esNeeded !== undefined && context.currentItem.es === undefined)
        || resists.some(r => (context.buildNeeds.resistanceGaps?.[r] ?? 0) > 0 && context.currentItem?.resistances?.[r] === undefined);
      if (missingBaseline) warnings.push('Some current item stat baselines are missing; corresponding candidate values are not replacement gains.');
    }
    if (context.buildNeeds.dpsTarget !== undefined) warnings.push('The requested build DPS target cannot be checked from listing mods; evaluate candidates with the native build calculator.');
    if (analysis.unparsedMods.length) warnings.push('Some modifiers are outside the local parser; inspect the full listing before evaluating the build.');
    const current: Record<string, number> = {}, upgraded: Record<string, number> = {}, delta: Record<string, number> = {};
    const compare = (key: keyof StatExtraction, baseline: number | undefined) => {
      const value = stats[key];
      if (baseline !== undefined && value !== undefined && knownStats.includes(key)) {
        current[key] = baseline; upgraded[key] = value; delta[key] = value - baseline;
        if (delta[key] < 0) warnings.push(`Item-stat loss: ${key} ${delta[key]} compared with the supplied current item.`);
      }
    };
    compare('life', context.currentItem?.life);
    compare('es', context.currentItem?.es);
    for (const resist of resists) compare(`${resist}Resist`, context.currentItem?.resistances?.[resist]);
    const knownResistDeltas: NonNullable<ItemRecommendation['costBenefit']['resistGain']> = {};
    for (const resist of resists) if (delta[`${resist}Resist`] !== undefined) knownResistDeltas[resist] = delta[`${resist}Resist`];
    // A match score measures requested item evidence, not percent build improvement.
    const goals = requirements.filter(req => req.min > 0);
    const coverage = goals.length ? goals.reduce((sum, req) => sum + Math.min(1, Math.max(0, (stats[req.stat] ?? 0) / req.min)), 0) / goals.length : 0;
    const affordability = Math.max(0, 1 - budgetPrice / maxPrice);
    const score = 80 * coverage + 20 * affordability;
    for (const req of goals) reasons.push(`Item ${req.stat}: ${stats[req.stat]} (requested at least ${req.min}).`);
    if (!goals.length) reasons.push('Candidate matches the requested search constraints; no supported item-stat target was supplied for local scoring.');
    if (context.itemRequirements?.stats?.length) reasons.push('Custom stat constraints were applied by the trade search; they are not whole-build gains.');
    reasons.push(`Within item budget: ${budgetPrice} ${normalizeCurrencyId(context.budget.currency)}.`);
    const rawEfficiency = score / amount;
    const chaosEfficiency = priceEvidence.priceInChaos === undefined ? undefined : score / priceEvidence.priceInChaos;
    return {
      listing, searchId, score, rank: 0, reasons, warnings,
      priority: goals.length && score >= 80 ? 'high' : goals.length && score >= 50 ? 'medium' : 'low',
      itemEvidence: { scope: 'item', stats, knownStats, unparsedMods: analysis.unparsedMods },
      ...(Object.keys(delta).length ? { statComparison: { current, upgraded, delta } } : {}),
      costBenefit: {
        price: amount, currency, priceInChaos: priceEvidence.priceInChaos,
        priceInBudgetCurrency: budgetPrice, budgetCurrency: normalizeCurrencyId(context.budget.currency), efficiencyCurrency: currency,
        // Kept for existing formatters; never used to rank across currencies.
        efficiency: Number.isFinite(rawEfficiency) ? rawEfficiency : 0,
        ...(chaosEfficiency !== undefined && Number.isFinite(chaosEfficiency) ? { pointsPerChaos: chaosEfficiency } : {}),
        ...(delta.life !== undefined ? { lifeGain: delta.life } : {}),
        ...(delta.es !== undefined ? { esGain: delta.es } : {}),
        ...(Object.keys(knownResistDeltas).length ? { resistGain: knownResistDeltas } : {}),
      },
    };
  }

  private matchesEvidence(listing: ItemListing, analysis: ItemValueAnalysis, requirements: StatRequirement[], context: UpgradeContext): boolean {
    if (listing.item.identified === false) return false;
    if (listing.item.league && listing.item.league !== context.league) return false;
    const base = context.itemRequirements?.baseType;
    if (base && listing.item.baseType !== base) return false;
    return requirements.every(req => analysis.knownStats.includes(req.stat) && (analysis.stats[req.stat] ?? -Infinity) >= req.min);
  }

  private buildUpgradeQuery(slot: string, context: UpgradeContext): { builder: TradeQueryBuilder; requirements: StatRequirement[]; maxPrice: number } {
    if (!context.league?.trim()) throw new Error('An explicit league is required.');
    if (!context.budget.currency?.trim()) throw new Error('An explicit budget currency is required.');
    for (const [key, value] of Object.entries({ maxPricePerItem: context.budget.maxPricePerItem, totalBudget: context.budget.totalBudget })) this.nonnegative(key, value);
    const distribution = context.budget.preferredBudgetDistribution?.[slot];
    if (distribution !== undefined) {
      this.nonnegative('budget distribution', distribution);
      if (distribution > 100) throw new Error('Budget distribution must not exceed 100 percent.');
    }
    const maxPrice = Math.min(context.budget.maxPricePerItem, context.budget.totalBudget * (distribution === undefined ? 1 : distribution / 100));
    const needs = context.buildNeeds, explicit = context.itemRequirements ?? {};
    const numericConstraints = ['minLife', 'minES', 'minSpirit', 'minWard', 'minRuneSockets', 'fireResist', 'coldResist', 'lightningResist', 'chaosResist', 'minDPS', 'minPDPS', 'minEDPS', 'minArmour', 'minEvasion', 'links'];
    const supportedConstraints = [...numericConstraints, 'sockets', 'stats', 'baseType', 'itemCategory'];
    for (const [key, value] of Object.entries(explicit)) {
      if (!supportedConstraints.includes(key)) throw new Error(`Unknown item constraint: ${key}. Use a verified trade stat ID for custom requirements.`);
      if (numericConstraints.includes(key) && value !== undefined) this.nonnegative(key, value as number);
    }
    for (const [key, value] of Object.entries(needs)) if (key !== 'resistanceGaps' && value !== undefined) this.nonnegative(key, value as number);
    if (needs.resistanceGaps) this.validateGaps(needs.resistanceGaps);
    if (context.currentItem && context.currentItem.slot !== slot) throw new Error('Current item slot does not match the requested slot.');
    for (const value of [context.currentItem?.life, context.currentItem?.es, ...Object.values(context.currentItem?.resistances ?? {})]) {
      if (value !== undefined && !Number.isFinite(value)) throw new Error('Current item stats must be finite.');
    }
    // Use only the builder's catalog-aware slot handling here. Life/resistance
    // mappings below come from the loaded mapper; ES uses displayed equipment ES.
    const builder = TradeQueryBuilder.fromItemRequirements({ slot, itemCategory: explicit.itemCategory });
    if (explicit.baseType) {
      builder.withType(explicit.baseType);
      if (builder.build().query.type !== explicit.baseType) throw new Error('baseType must be an exact item base, not a category alias.');
    }
    if (explicit.links !== undefined) builder.withLinks(explicit.links);
    if (explicit.sockets !== undefined) builder.withSockets(explicit.sockets.r, explicit.sockets.g, explicit.sockets.b, explicit.sockets.w);
    const requirements: StatRequirement[] = [];
    const minimum = (requested: number | undefined, gap: number | undefined, baseline: number | undefined): number | undefined => {
      const inferred = gap !== undefined && gap > 0 ? gap + (baseline ?? 0) : undefined;
      if (inferred !== undefined && !Number.isFinite(inferred)) throw new Error('Item requirement exceeds the supported numeric range.');
      return requested === undefined ? inferred : inferred === undefined ? requested : Math.max(requested, inferred);
    };
    const add = (stat: keyof StatExtraction, min: number | undefined) => { if (min !== undefined) requirements.push({ stat, min }); };
    const life = minimum(explicit.minLife, needs.lifeNeeded, context.currentItem?.life);
    const es = minimum(explicit.minES, needs.esNeeded, context.currentItem?.es);
    if (life !== undefined) { builder.withStats([{ id: this.requiredStat('Life', 'pseudo.pseudo_total_life'), min: life }]); add('life', life); }
    if (es !== undefined) { builder.withDefenses(undefined, undefined, { min: es }); add('es', es); }
    if (explicit.minSpirit !== undefined) { applyItemSpiritRequirement(builder, explicit.minSpirit, this.statMapper); add('spirit', explicit.minSpirit); }
    if (explicit.minWard !== undefined) { builder.withWard(explicit.minWard); add('ward', explicit.minWard); }
    if (explicit.minRuneSockets !== undefined) { builder.withRuneSockets(explicit.minRuneSockets); add('runeSockets', explicit.minRuneSockets); }
    for (const resist of resists) {
      const key = `${resist}Resist` as const;
      const min = minimum(explicit[key], needs.resistanceGaps?.[resist], context.currentItem?.resistances?.[resist]);
      if (min !== undefined) {
        builder.withStats([{ id: this.requiredStat(`${resist[0].toUpperCase()}${resist.slice(1)}Resist`, `pseudo.pseudo_total_${resist}_resistance`), min }]);
        add(key, min);
      }
    }
    if (explicit.minArmour !== undefined) { builder.withDefenses({ min: explicit.minArmour }); add('armour', explicit.minArmour); }
    if (explicit.minEvasion !== undefined) { builder.withDefenses(undefined, { min: explicit.minEvasion }); add('evasion', explicit.minEvasion); }
    if (explicit.minDPS !== undefined) { builder.withDPS(explicit.minDPS); add('totalDPS', explicit.minDPS); }
    if (explicit.minPDPS !== undefined) { builder.withPDPS(explicit.minPDPS); add('physicalDPS', explicit.minPDPS); }
    if (explicit.minEDPS !== undefined) { builder.withEDPS(explicit.minEDPS); add('elementalDPS', explicit.minEDPS); }
    if (explicit.stats?.length) {
      for (const stat of explicit.stats) {
        if (!stat.id?.trim()) throw new Error('A custom stat ID is required.');
        for (const value of [stat.min, stat.max]) if (value !== undefined && !Number.isFinite(value)) throw new Error('Custom stat bounds must be finite.');
        if (stat.min !== undefined && stat.max !== undefined && stat.min > stat.max) throw new Error('Custom stat minimum exceeds maximum.');
      }
      builder.withStats(explicit.stats);
    }
    builder.withPriceRange(undefined, maxPrice, normalizeCurrencyId(context.budget.currency)).withOnlineStatus('available').withSort('price', 'asc');
    return { builder, requirements, maxPrice };
  }

  private requiredStat(name: string, id: string): string {
    const mapped = this.statMapper.getTradeId(name);
    if (mapped) return mapped;
    if (this.statMapper.getPobName(id)) return id;
    throw new Error(`Required stat mapping ${name} is unavailable; load verified trade stat metadata before searching.`);
  }

  private nonnegative(name: string, value: number): void {
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) throw new Error(`${name} must be a finite non-negative number.`);
  }

  private validateGaps(gaps: ResistanceRequirements): void {
    for (const resist of resists) if (gaps[resist] !== undefined) this.nonnegative(`${resist} resistance requirement`, gaps[resist]!);
  }
}
