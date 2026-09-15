/** Listing evidence and price comparisons. Item stats are not build gains. */
import { ItemListing, Property } from '../types/tradeTypes.js';

export interface StatExtraction {
  life: number;
  /** Displayed item defense totals, already including local modifiers. */
  es: number;
  armour: number;
  evasion: number;
  /** Displayed Spirit, or unconditional flat Spirit mods when no property exists. */
  spirit?: number;
  /** Current displayed equipment values; absent evidence is not a measured zero. */
  ward?: number;
  runeSockets?: number;
  flatEnergyShield?: number;
  fireResist: number;
  coldResist: number;
  lightningResist: number;
  chaosResist: number;
  totalResist: number;
  strength: number;
  dexterity: number;
  intelligence: number;
  /** Weapon property DPS only; never character or skill DPS. */
  physicalDPS?: number;
  elementalDPS?: number;
  chaosDPS?: number;
  totalDPS?: number;
}

export interface CostBenefitMetrics {
  lifePerChaos?: number;
  esPerChaos?: number;
  totalResistPerChaos?: number;
  armourPerChaos?: number;
  evasionPerChaos?: number;
  dpsPerChaos?: number;
  /** @deprecated Build EHP requires a native calculation; never populated. */
  ehpPerChaos?: number;
  /** Heuristics in item-stat units, not effective defense or damage. */
  defensiveValuePerChaos?: number;
  offensiveValuePerChaos?: number;
  valueScore?: number;
  valueTier: 'excellent' | 'good' | 'average' | 'poor' | 'unknown';
  isBudgetPick: boolean;
  isPremiumPick: boolean;
  warnings: string[];
}

export interface ListingPriceEvidence {
  amount?: number;
  currency?: string;
  priceInChaos?: number;
  status: 'known' | 'missing-price' | 'invalid-price' | 'missing-rate';
}

export interface ItemValueAnalysis {
  listing: ItemListing;
  stats: StatExtraction;
  /** Zero in stats is not evidence when the corresponding key is absent here. */
  knownStats: string[];
  unparsedMods: string[];
  metrics: CostBenefitMetrics;
  priceInChaos?: number;
  priceEvidence: ListingPriceEvidence;
  rank?: number;
}

const currencyAliases: Record<string, string> = {
  'chaos orb': 'chaos', c: 'chaos', 'divine orb': 'divine', div: 'divine',
  'exalted orb': 'exalted', exa: 'exalted', ex: 'exalted',
  'mirror of kalandra': 'mirror', 'orb of alchemy': 'alch', alchemy: 'alch',
  'orb of augmentation': 'aug', augmentation: 'aug', 'regal orb': 'regal',
  'orb of transmutation': 'transmute', transmutation: 'transmute',
  'vaal orb': 'vaal', 'orb of annulment': 'annul', annulment: 'annul',
  'orb of fusing': 'fusing', fuse: 'fusing', 'orb of regret': 'regret',
  "gemcutter's prism": 'gcp', 'chromatic orb': 'chrome', chromatic: 'chrome',
  "jeweller's orb": 'jewellers', 'orb of alteration': 'alt', alteration: 'alt',
  "cartographer's chisel": 'chisel', 'blessed orb': 'blessed',
  'orb of scouring': 'scouring', scour: 'scouring',
};

export function normalizeCurrencyId(currency: string): string {
  const key = currency.trim().toLowerCase();
  return currencyAliases[key] ?? key;
}

/** Supplied values must be actual chaos per unit, e.g. getCurrencyExchangeMap. */
export function getChaosRate(currency: string, rates?: ReadonlyMap<string, number>): number | undefined {
  const key = normalizeCurrencyId(currency);
  if (key === 'chaos') return 1;
  let found: number | undefined;
  for (const [name, rate] of rates ?? []) {
    if (normalizeCurrencyId(name) !== key) continue;
    if (!Number.isFinite(rate) || rate <= 0 || (found !== undefined && found !== rate)) return undefined;
    found = rate;
  }
  return found;
}

export function getListingPrice(listing: ItemListing, rates?: ReadonlyMap<string, number>): ListingPriceEvidence {
  const price = listing.listing.price;
  if (!price) return { status: 'missing-price' };
  if (!Number.isFinite(price.amount) || price.amount <= 0 || typeof price.currency !== 'string' || !price.currency.trim()) {
    return { status: 'invalid-price' };
  }
  const evidence = { amount: price.amount, currency: price.currency };
  const rate = getChaosRate(price.currency, rates);
  const converted = rate === undefined ? undefined : price.amount * rate;
  return converted !== undefined && Number.isFinite(converted) && converted > 0
    ? { ...evidence, status: 'known', priceInChaos: converted }
    : { ...evidence, status: 'missing-rate' };
}

/** Same-unit prices need no exchange quote. Unknown conversions remain unknown. */
export function priceInCurrency(price: ListingPriceEvidence, currency: string, rates?: ReadonlyMap<string, number>): number | undefined {
  if (price.amount === undefined || price.currency === undefined) return undefined;
  if (normalizeCurrencyId(price.currency) === normalizeCurrencyId(currency)) return price.amount;
  const denominator = getChaosRate(currency, rates);
  const value = denominator === undefined || price.priceInChaos === undefined ? undefined : price.priceInChaos / denominator;
  return value !== undefined && Number.isFinite(value) && value > 0 ? value : undefined;
}

const numberPattern = '[+-]?(?:\\d{1,3}(?:,\\d{3})+|\\d+)(?:\\.\\d+)?';
const flatPattern = new RegExp(`^(${numberPattern}) to (.+)$`, 'i');
const percentPattern = new RegExp(`^(${numberPattern})% to (.+)$`, 'i');
const numberValue = (text: string): number => Number(text.replace(/,/g, ''));
const propertyName = (text: string): string => text.replace(/<[^>]+>\{([^}]+)\}/g, '$1')
  .replace(/\[([^|\]]+)\]/g, '$1').replace(/\[[^|\]]+\|([^|\]]+)\]/g, '$1');
const modFields = ['implicitMods', 'explicitMods', 'craftedMods', 'fracturedMods', 'enchantMods', 'runeMods', 'desecratedMods', 'utilityMods'] as const;
function modifierDescription(value: unknown): string | undefined {
  if (typeof value === 'string') return value;
  if (value && typeof value === 'object' && 'description' in value && typeof value.description === 'string') return value.description;
  return undefined;
}

/** Trade2 returns modifier records with descriptions; older responses use strings. */
export function itemModifierLines(item: ItemListing['item']): string[] {
  const source = item as unknown as Record<string, unknown>;
  return modFields.flatMap(field => {
    const values = source[field];
    return Array.isArray(values) ? values.flatMap(value => {
      const text = modifierDescription(value);
      return text === undefined ? [] : text.split(/\r?\n/).map(line => propertyName(line).trim()).filter(Boolean);
    }) : [];
  });
}
const finiteRatio = (numerator: number, denominator: number): number | undefined => {
  const value = numerator / denominator;
  return Number.isFinite(value) ? value : undefined;
};

function propertyNumber(property: Property | undefined): number | undefined {
  const raw = property?.values?.[0]?.[0]?.trim();
  if (!raw || !new RegExp(`^${numberPattern}$`).test(raw)) return undefined;
  const value = numberValue(raw);
  return Number.isFinite(value) && value >= 0 ? value : undefined;
}

function propertyDamage(property: Property | undefined, aps: number): number | undefined {
  if (!property?.values?.length) return undefined;
  let average = 0;
  for (const [text] of property.values) {
    // Trade may return each elemental range separately or comma-separated.
    for (const part of text.split(/,\s+/)) {
      const range = part.trim().match(new RegExp(`^(${numberPattern})\\s*[-–]\\s*(${numberPattern})$`));
      if (!range) return undefined;
      const min = numberValue(range[1]), max = numberValue(range[2]);
      if (!Number.isFinite(min) || !Number.isFinite(max) || min < 0 || max < min) return undefined;
      average += (min + max) / 2;
    }
  }
  const value = average * aps;
  return Number.isFinite(value) ? value : undefined;
}

export class CostBenefitAnalyzer {
  analyzeItem(listing: ItemListing, currencyRates?: Map<string, number>): ItemValueAnalysis {
    const { stats, knownStats, unparsedMods } = this.extractStats(listing);
    const priceEvidence = getListingPrice(listing, currencyRates);
    const metrics = this.calculateMetrics(stats, knownStats, priceEvidence);
    return { listing, stats, knownStats, unparsedMods, priceEvidence, priceInChaos: priceEvidence.priceInChaos, metrics };
  }

  analyzeAndRank(listings: ItemListing[], currencyRates?: Map<string, number>): ItemValueAnalysis[] {
    const analyses = listings.map(listing => this.analyzeItem(listing, currencyRates));
    analyses.sort((a, b) => {
      if (a.metrics.valueScore === undefined) return b.metrics.valueScore === undefined ? 0 : 1;
      if (b.metrics.valueScore === undefined) return -1;
      return b.metrics.valueScore - a.metrics.valueScore || a.priceInChaos! - b.priceInChaos!;
    });
    let rank = 0;
    for (const analysis of analyses) if (analysis.metrics.valueScore !== undefined) analysis.rank = ++rank;
    return analyses;
  }

  private extractStats(listing: ItemListing): { stats: StatExtraction; knownStats: string[]; unparsedMods: string[] } {
    const item = listing.item;
    const stats: StatExtraction = { life: 0, es: 0, armour: 0, evasion: 0, fireResist: 0, coldResist: 0,
      lightningResist: 0, chaosResist: 0, totalResist: 0, strength: 0, dexterity: 0, intelligence: 0 };
    const knownStats = new Set<string>();
    const unparsedMods: string[] = [];
    const modArrays = item as unknown as Record<string, unknown>;
    const hasMods = modFields.some(field => Array.isArray(modArrays[field]));
    const hasUnreadableMods = modFields.some(field => Array.isArray(modArrays[field]) && (modArrays[field] as unknown[]).some(mod => modifierDescription(mod) === undefined));
    let flatSpirit: number | undefined;
    if (hasMods && !hasUnreadableMods && item.identified !== false) {
      for (const name of ['life', 'fireResist', 'coldResist', 'lightningResist', 'chaosResist', 'totalResist', 'strength', 'dexterity', 'intelligence']) knownStats.add(name);
    }
    for (const field of modFields) {
      const mods = modArrays[field];
      if (!Array.isArray(mods)) continue;
      for (const raw of mods) {
        const description = modifierDescription(raw);
        if (description === undefined) { unparsedMods.push('Unrecognized modifier record; numeric totals may be incomplete.'); continue; }
        for (const line of description.split(/\r?\n/)) {
          const text = propertyName(line).trim();
          const flat = text.match(flatPattern), percent = text.match(percentPattern);
          let parsed = false;
          if (flat) {
            const value = numberValue(flat[1]), target = flat[2].toLowerCase();
            if (Number.isFinite(value)) {
              if (target === 'maximum life') { stats.life += value; parsed = true; }
              else if (target === 'spirit') { flatSpirit = (flatSpirit ?? 0) + value; parsed = true; }
              else if (target === 'maximum energy shield') { stats.flatEnergyShield = (stats.flatEnergyShield ?? 0) + value; parsed = true; }
              else {
                const attributes = target === 'all attributes' ? ['strength', 'dexterity', 'intelligence'] : target.split(/,\s*| and /);
                if (attributes.length && attributes.every(t => ['strength', 'dexterity', 'intelligence'].includes(t))) {
                  for (const attribute of attributes) stats[attribute as 'strength' | 'dexterity' | 'intelligence'] += value;
                  parsed = true;
                }
              }
            }
          }
          if (percent) {
            const value = numberValue(percent[1]), target = percent[2].toLowerCase();
            const resists = target === 'all elemental resistances' ? ['fire', 'cold', 'lightning']
              : target === 'all resistances' ? ['fire', 'cold', 'lightning', 'chaos']
                : target.replace(/ resistances?$/, '').split(/,\s*| and /);
            if (Number.isFinite(value) && /resistances?$/.test(target) && resists.length && resists.every(r => ['fire', 'cold', 'lightning', 'chaos'].includes(r))) {
              for (const resist of resists) stats[`${resist}Resist` as 'fireResist' | 'coldResist' | 'lightningResist' | 'chaosResist'] += value;
              parsed = true;
            }
          }
          if (!parsed && text) unparsedMods.push(text);
        }
      }
    }
    stats.totalResist = stats.fireResist + stats.coldResist + stats.lightningResist + stats.chaosResist;
    for (const [key, names] of [['es', ['Energy Shield']], ['armour', ['Armour']], ['evasion', ['Evasion Rating']],
      ['spirit', ['Spirit']], ['ward', ['Runic Ward', 'Ward']]] as const) {
      const property = names.map(name => item.properties?.find(p => propertyName(p.name) === name)).find(p => p !== undefined);
      const value = propertyNumber(property);
      if (value !== undefined) { stats[key] = value; knownStats.add(key); }
    }
    // Body armour exposes its Spirit modifier rather than a Spirit property.
    // Never add it again to a displayed weapon total, or repair a malformed total.
    if (!item.properties?.some(p => propertyName(p.name) === 'Spirit') && flatSpirit !== undefined
      && Number.isFinite(flatSpirit) && !hasUnreadableMods && item.identified !== false) {
      stats.spirit = flatSpirit;
      knownStats.add('spirit');
    }
    // PoB2 imports item sockets separately from sockets whose type is "jewel".
    // Missing or malformed arrays remain unknown; an explicit [] proves zero.
    const sockets = item.sockets as Array<{ type?: string }> | undefined;
    if (Array.isArray(sockets) && sockets.every(socket => socket !== null && typeof socket === 'object'
      && !Array.isArray(socket) && (socket.type === undefined || socket.type === 'rune' || socket.type === 'jewel'))) {
      stats.runeSockets = sockets.filter(socket => socket.type !== 'jewel').length;
      knownStats.add('runeSockets');
    }
    const aps = propertyNumber(item.properties?.find(p => p.name === 'Attacks per Second'));
    if (aps !== undefined && aps > 0) {
      let total = 0, count = 0, complete = true;
      for (const [name, key] of [['Physical Damage', 'physicalDPS'], ['Elemental Damage', 'elementalDPS'], ['Chaos Damage', 'chaosDPS']] as const) {
        const prop = item.properties?.find(p => p.name === name);
        if (!prop) continue;
        const dps = propertyDamage(prop, aps);
        if (dps === undefined) { complete = false; continue; }
        stats[key] = dps; knownStats.add(key); total += dps; count++;
      }
      if (complete && count && Number.isFinite(total)) { stats.totalDPS = total; knownStats.add('totalDPS'); }
    }
    return { stats, knownStats: [...knownStats], unparsedMods };
  }

  private calculateMetrics(stats: StatExtraction, knownStats: string[], price: ListingPriceEvidence): CostBenefitMetrics {
    const warnings = ['Item stats are candidate evidence. Whole-build gains, DPS and EHP require a native build calculation.'];
    const metrics: CostBenefitMetrics = { valueTier: 'unknown', isBudgetPick: false, isPremiumPick: false, warnings };
    if (price.priceInChaos === undefined) {
      warnings.push(price.status === 'missing-rate' ? `No verified chaos conversion rate for ${price.currency}; value comparison unavailable.` : 'Listing price is missing or invalid; value comparison unavailable.');
      return metrics;
    }
    const denominator = price.priceInChaos;
    const pairs = [['life', 'lifePerChaos'], ['es', 'esPerChaos'], ['totalResist', 'totalResistPerChaos'],
      ['armour', 'armourPerChaos'], ['evasion', 'evasionPerChaos'], ['totalDPS', 'dpsPerChaos']] as const;
    for (const [stat, metric] of pairs) {
      if (knownStats.includes(stat) && stats[stat] !== undefined) metrics[metric] = finiteRatio(stats[stat]!, denominator);
    }
    const available = pairs.some(([, metric]) => metrics[metric] !== undefined);
    if (!available) { warnings.push('No supported item-stat evidence for value scoring.'); return metrics; }
    // Compatibility heuristic: transparent item-stat weights, never a build outcome.
    const positive = (n: number | undefined) => Math.max(0, n ?? 0);
    const defensive = positive(metrics.lifePerChaos) * 2 + positive(metrics.esPerChaos)
      + positive(metrics.totalResistPerChaos) * 0.5 + positive(metrics.armourPerChaos) * 0.01 + positive(metrics.evasionPerChaos) * 0.01;
    if (Number.isFinite(defensive)) metrics.defensiveValuePerChaos = defensive;
    metrics.offensiveValuePerChaos = metrics.dpsPerChaos;
    const score = Math.min(25, positive(metrics.lifePerChaos) * 2.5) + Math.min(15, positive(metrics.esPerChaos) * 1.5)
      + Math.min(30, positive(metrics.totalResistPerChaos) * 3) + Math.min(15, (positive(metrics.armourPerChaos) + positive(metrics.evasionPerChaos)) * 0.01)
      + Math.min(15, positive(metrics.dpsPerChaos) * 0.05);
    metrics.valueScore = score;
    metrics.valueTier = score >= 70 ? 'excellent' : score >= 50 ? 'good' : score >= 30 ? 'average' : 'poor';
    // No hardcoded market-price threshold or build-quality classification.
    return metrics;
  }

  formatAnalysis(analysis: ItemValueAnalysis): string {
    const { listing, metrics, stats } = analysis;
    const price = listing.listing.price;
    const lines = [`Listing price: ${price ? `${price.amount} ${price.currency}` : 'unavailable'}`];
    if (analysis.priceInChaos !== undefined) lines.push(`Comparable price: ${analysis.priceInChaos} chaos`);
    lines.push(metrics.valueScore === undefined ? 'Item-stat value comparison: unavailable' : `Item-stat value heuristic: ${metrics.valueScore.toFixed(1)}/100 (${metrics.valueTier})`);
    for (const [label, value] of [['Flat life', metrics.lifePerChaos], ['Displayed ES', metrics.esPerChaos],
      ['Resistance points', metrics.totalResistPerChaos], ['Displayed armour', metrics.armourPerChaos],
      ['Displayed evasion', metrics.evasionPerChaos], ['Displayed weapon DPS', metrics.dpsPerChaos]] as const) {
      if (value !== undefined) lines.push(`${label}: ${value.toFixed(2)} per chaos`);
    }
    if (stats.totalDPS !== undefined) lines.push(`Displayed weapon DPS: ${stats.totalDPS.toFixed(2)}`);
    lines.push(...metrics.warnings);
    return `${lines.join('\n')}\n`;
  }
}
