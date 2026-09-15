import { tradeGame } from './tradeClient.js';
import {
  TradeQuery,
  StatFilterGroup,
  ItemRequirements,
  ResistanceRequirements,
  SearchOptions,
} from '../types/tradeTypes.js';

/**
 * Builder class for constructing Path of Exile Trade API queries
 *
 * Provides a fluent API for building complex trade queries with:
 * - Item type and name filtering
 * - Price ranges
 * - Stat requirements
 * - Socket/link requirements
 * - Resistance requirements
 * - Online-only filtering
 */
export class TradeQueryBuilder {
  private readonly game = tradeGame();
  private equipment(field: string, value: {min?:number;max?:number}): this {
    this.query.query.filters ??= {};
    this.query.query.filters.equipment_filters ??= {filters:{}};
    this.query.query.filters.equipment_filters.filters![field] = value;
    return this;
  }
  withRuneSockets(min?:number,max?:number):this {return this.equipment('rune_sockets',{min,max});}
  withSpirit(min?:number,max?:number):this {return this.equipment('spirit',{min,max});}
  withWard(min?:number,max?:number):this {return this.equipment('ward',{min,max});}
  /** Gem acquisition level, distinct from item level and character requirements. */
  withGemLevel(min?: number, max?: number): this {
    const filters = this.query.query.filters ??= {};
    const misc = (filters as typeof filters & {
      misc_filters?: { filters?: Record<string, { min?: number; max?: number }> };
    }).misc_filters ??= {};
    (misc.filters ??= {}).gem_level = { min, max };
    return this;
  }
  /** Quality uses the native trade type filter for both equipment and gems. */
  withQuality(min?: number, max?: number): this {
    const filters = this.query.query.filters ??= {};
    const type = filters.type_filters ??= {};
    (type.filters ??= {}).quality = { min, max };
    return this;
  }
  withItemState(field:'corrupted'|'identified',value:boolean):this {
    if(typeof value!=='boolean')throw new Error(`${field} must be a boolean`);
    const filters=this.query.query.filters??={};
    const misc=(filters as any).misc_filters??={filters:{}};
    misc.filters[field]={option:String(value)};
    return this;
  }
  private query: TradeQuery = {
    query: {
      status: { option: 'available' },
      filters: {},
    },
  };

  /**
   * Set item name filter
   */
  withName(name: string): this {
    this.query.query.name = name;
    return this;
  }

  /**
   * Set item type filter (base type or category)
   */
  withType(type: string): this {
    // Map generic categories to trade API categories
    const categoryMap: Record<string, string> = {
      'boots': 'armour.boots',
      'gloves': 'armour.gloves',
      'helmet': 'armour.helmet',
      'body armour': 'armour.chest',
      'chest': 'armour.chest',
      'shield': 'armour.shield',
      'quiver': 'armour.quiver',
      'ring': 'accessory.ring',
      'amulet': 'accessory.amulet',
      'belt': 'accessory.belt',
      'jewel': 'jewel',
      'flask': 'flask',
      'bow': 'weapon.bow',
      'claw': 'weapon.claw',
      'dagger': 'weapon.dagger',
      'wand': 'weapon.wand',
      'one hand sword': 'weapon.onesword',
      'two hand sword': 'weapon.twosword',
      'one hand axe': 'weapon.oneaxe',
      'two hand axe': 'weapon.twoaxe',
      'one hand mace': 'weapon.onemace',
      'two hand mace': 'weapon.twomace',
      'sceptre': 'weapon.sceptre',
      'staff': 'weapon.staff',
      'warstaff': 'weapon.warstaff',
    };

    if (this.game === 'poe2') Object.assign(categoryMap, {
      crossbow:'weapon.crossbow', spear:'weapon.spear', flail:'weapon.flail',
      quarterstaff:'weapon.warstaff', talisman:'weapon.talisman', focus:'armour.focus',
      buckler:'armour.buckler', charm:'flask.charm', rune:'currency.rune',
      tablet:'map.tablet', waystone:'map.waystone',
    });
    const typeLower = type.trim().toLowerCase();
    const category = categoryMap[typeLower];

    if (category) {
      // Use category filter for generic types
      this.withCategory(category);
    } else {
      // Use specific base type
      this.query.query.type = type;
    }

    return this;
  }

  /**
   * Set item category filter
   */
  withCategory(category: string): this {
    if (!this.query.query.filters) {
      this.query.query.filters = {};
    }
    if (!this.query.query.filters.type_filters) {
      this.query.query.filters.type_filters = {};
    }
    if (!this.query.query.filters.type_filters.filters) {
      this.query.query.filters.type_filters.filters = {};
    }

    this.query.query.filters.type_filters.filters.category = {
      option: category,
    };

    return this;
  }

  /**
   * Set search term (generic search)
   */
  withTerm(term: string): this {
    this.query.query.term = term;
    return this;
  }

  /**
   * Filter by online status
   * - 'available': Shows both instant buyout and in-person trade items (recommended)
   * - 'online': Only shows items from currently online sellers
   * - 'onlineleague': Only shows items from sellers online in the same league
   * - 'any': Shows all items regardless of seller status
   */
  withOnlineStatus(status: 'available' | 'online' | 'onlineleague' | 'securable' | 'any'): this {
    this.query.query.status = { option: status };
    return this;
  }

  /**
   * Set sale type filter
   */
  withSaleType(saleType: 'priced' | 'unpriced' | 'any' = 'any'): this {
    if (!this.query.query.filters) {
      this.query.query.filters = {};
    }
    if (!this.query.query.filters.trade_filters) {
      this.query.query.filters.trade_filters = {};
    }
    if (!this.query.query.filters.trade_filters.filters) {
      this.query.query.filters.trade_filters.filters = {};
    }

    // PoE2's omitted default is Buyout or Fixed Price. Explicit any includes other sale types.
    if (this.game === 'poe2') {
      if (saleType === 'priced') delete this.query.query.filters.trade_filters.filters.sale_type;
      else this.query.query.filters.trade_filters.filters.sale_type = {option:saleType};
      return this;
    }
    if (saleType !== 'any') {
      this.query.query.filters.trade_filters.filters.sale_type = {
        option: saleType,
      };
    }

    return this;
  }

  /**
   * Set price range filter
   */
  withPriceRange(min?: number, max?: number, currency: string | null = 'chaos'): this {
    if (!this.query.query.filters) {
      this.query.query.filters = {};
    }
    if (!this.query.query.filters.trade_filters) {
      this.query.query.filters.trade_filters = {};
    }
    if (!this.query.query.filters.trade_filters.filters) {
      this.query.query.filters.trade_filters.filters = {};
    }

    this.query.query.filters.trade_filters.filters.price = {
      min, max, ...(currency === null ? {} : {option:currency}),
    };

    return this;
  }

  /**
   * Set item rarity filter
   */
  withRarity(rarity: 'normal' | 'magic' | 'rare' | 'unique' | 'any'): this {
    if (!this.query.query.filters) {
      this.query.query.filters = {};
    }
    if (!this.query.query.filters.type_filters) {
      this.query.query.filters.type_filters = {};
    }
    if (!this.query.query.filters.type_filters.filters) {
      this.query.query.filters.type_filters.filters = {};
    }

    this.query.query.filters.type_filters.filters.rarity = {
      option: rarity,
    };

    return this;
  }

  /**
   * Set item level range
   */
  withItemLevel(min?: number, max?: number): this {
    if (!this.query.query.filters) {
      this.query.query.filters = {};
    }
    if (!this.query.query.filters.type_filters) {
      this.query.query.filters.type_filters = {};
    }
    if (!this.query.query.filters.type_filters.filters) {
      this.query.query.filters.type_filters.filters = {};
    }

    this.query.query.filters.type_filters.filters.ilvl = {
      min,
      max,
    };

    return this;
  }

  /**
   * Set link requirement
   */
  withLinks(min?: number, max?: number): this {
    if (this.game === 'poe2') throw new Error('PoE2 equipment has rune sockets, not linked gem sockets; use rune socket constraints');
    if (!this.query.query.filters) {
      this.query.query.filters = {};
    }
    if (!this.query.query.filters.socket_filters) {
      this.query.query.filters.socket_filters = {};
    }
    if (!this.query.query.filters.socket_filters.filters) {
      this.query.query.filters.socket_filters.filters = {};
    }

    this.query.query.filters.socket_filters.filters.links = {
      min,
      max,
    };

    return this;
  }

  /**
   * Set socket color requirements
   */
  withSockets(r?: number, g?: number, b?: number, w?: number): this {
    if (this.game === 'poe2') throw new Error('PoE2 equipment socket colors cannot constrain skill support groups');
    if (!this.query.query.filters) {
      this.query.query.filters = {};
    }
    if (!this.query.query.filters.socket_filters) {
      this.query.query.filters.socket_filters = {};
    }
    if (!this.query.query.filters.socket_filters.filters) {
      this.query.query.filters.socket_filters.filters = {};
    }

    this.query.query.filters.socket_filters.filters.sockets = {
      r,
      g,
      b,
      w,
    };

    return this;
  }

  /**
   * Set weapon DPS requirement
   */
  withDPS(min?: number, max?: number): this {
    if (this.game === 'poe2') return this.equipment('dps',{min,max});
    if (!this.query.query.filters) {
      this.query.query.filters = {};
    }
    if (!this.query.query.filters.weapon_filters) {
      this.query.query.filters.weapon_filters = {};
    }
    if (!this.query.query.filters.weapon_filters.filters) {
      this.query.query.filters.weapon_filters.filters = {};
    }

    this.query.query.filters.weapon_filters.filters.dps = {
      min,
      max,
    };

    return this;
  }

  /**
   * Set physical DPS requirement
   */
  withPDPS(min?: number, max?: number): this {
    if (this.game === 'poe2') return this.equipment('pdps',{min,max});
    if (!this.query.query.filters) {
      this.query.query.filters = {};
    }
    if (!this.query.query.filters.weapon_filters) {
      this.query.query.filters.weapon_filters = {};
    }
    if (!this.query.query.filters.weapon_filters.filters) {
      this.query.query.filters.weapon_filters.filters = {};
    }

    this.query.query.filters.weapon_filters.filters.pdps = {
      min,
      max,
    };

    return this;
  }

  /**
   * Set elemental DPS requirement
   */
  withEDPS(min?: number, max?: number): this {
    if (this.game === 'poe2') return this.equipment('edps',{min,max});
    if (!this.query.query.filters) {
      this.query.query.filters = {};
    }
    if (!this.query.query.filters.weapon_filters) {
      this.query.query.filters.weapon_filters = {};
    }
    if (!this.query.query.filters.weapon_filters.filters) {
      this.query.query.filters.weapon_filters.filters = {};
    }

    this.query.query.filters.weapon_filters.filters.edps = {
      min,
      max,
    };

    return this;
  }

  /**
   * Add armour/evasion/ES requirements
   */
  withDefenses(armour?: { min?: number; max?: number }, evasion?: { min?: number; max?: number }, es?: { min?: number; max?: number }): this {
    if (this.game === 'poe2') {
      if (armour) this.equipment('ar',armour);
      if (evasion) this.equipment('ev',evasion);
      if (es) this.equipment('es',es);
      return this;
    }
    if (!this.query.query.filters) {
      this.query.query.filters = {};
    }
    if (!this.query.query.filters.armour_filters) {
      this.query.query.filters.armour_filters = {};
    }
    if (!this.query.query.filters.armour_filters.filters) {
      this.query.query.filters.armour_filters.filters = {};
    }

    if (armour) {
      this.query.query.filters.armour_filters.filters.ar = armour;
    }
    if (evasion) {
      this.query.query.filters.armour_filters.filters.ev = evasion;
    }
    if (es) {
      this.query.query.filters.armour_filters.filters.es = es;
    }

    return this;
  }

  /**
   * Add stat requirements (uses stat IDs from Trade API)
   */
  withStats(stats: Array<{ id: string; min?: number; max?: number }>): this {
    const statFilters: StatFilterGroup = {
      type: 'and',
      filters: stats.map(stat => ({
        id: stat.id,
        value: {
          min: stat.min,
          max: stat.max,
        },
      })),
    };

    if (!this.query.query.stats) {
      this.query.query.stats = [];
    }

    this.query.query.stats.push(statFilters);
    return this;
  }

  /**
   * Add resistance requirements
   * Uses pseudo stats for total resistances
   */
  withResistances(resists: ResistanceRequirements): this {
    const resistStats: Array<{ id: string; min?: number }> = [];

    if (resists.fire > 0) {
      resistStats.push({
        id: 'pseudo.pseudo_total_fire_resistance',
        min: resists.fire,
      });
    }
    if (resists.cold > 0) {
      resistStats.push({
        id: 'pseudo.pseudo_total_cold_resistance',
        min: resists.cold,
      });
    }
    if (resists.lightning > 0) {
      resistStats.push({
        id: 'pseudo.pseudo_total_lightning_resistance',
        min: resists.lightning,
      });
    }
    if (resists.chaos && resists.chaos > 0) {
      resistStats.push({
        id: 'pseudo.pseudo_total_chaos_resistance',
        min: resists.chaos,
      });
    }

    return this.withStats(resistStats);
  }

  /**
   * Set sort order
   */
  withSort(field: 'price', order: 'asc' | 'desc'): this {
    this.query.sort = {
      [field]: order,
    };
    return this;
  }

  /**
   * Build query from ItemRequirements
   */
  static fromItemRequirements(requirements: ItemRequirements): TradeQueryBuilder {
    const builder = new TradeQueryBuilder();

    // Set type/base filter if specified
    if (requirements.slot) {
      // Map slot names to item categories
      const slotToType: Record<string, string> = {
        'Weapon 1': 'weapon',
        'Weapon 2': 'weapon',
        'Body Armour': 'armour.chest',
        'Helmet': 'armour.helmet',
        'Gloves': 'armour.gloves',
        'Boots': 'armour.boots',
        'Amulet': 'accessory.amulet',
        'Ring 1': 'accessory.ring',
        'Ring 2': 'accessory.ring',
        'Belt': 'accessory.belt',
      };
      Object.assign(slotToType, { 'Weapon 1 Swap':'weapon', 'Ring 3':'accessory.ring', 'Charm 1':'flask.charm', 'Charm 2':'flask.charm', 'Charm 3':'flask.charm', 'Flask 1':'flask.life', 'Flask 2':'flask.mana' });
      if (requirements.itemCategory) builder.withCategory(requirements.itemCategory);
      else if (builder.game === 'poe2' && /Weapon 2(?: Swap)?/.test(requirements.slot)) {
        throw new Error('Specify itemCategory for a PoE2 offhand: weapon, shield, focus, quiver or buckler have different compatibility');
      } else if (slotToType[requirements.slot]) builder.withCategory(slotToType[requirements.slot]);
      else throw new Error(`Unknown equipment slot: ${requirements.slot}`);
    }

    // Links
    if (requirements.links) {
      builder.withLinks(requirements.links);
    }

    // Sockets
    if (requirements.sockets) {
      builder.withSockets(
        requirements.sockets.r,
        requirements.sockets.g,
        requirements.sockets.b,
        requirements.sockets.w
      );
    }

    // Weapon DPS
    if (requirements.minDPS) {
      builder.withDPS(requirements.minDPS);
    }
    if (requirements.minPDPS) {
      builder.withPDPS(requirements.minPDPS);
    }
    if (requirements.minEDPS) {
      builder.withEDPS(requirements.minEDPS);
    }

    // Defenses
    if (requirements.minWard !== undefined) builder.withWard(requirements.minWard);
    if (requirements.minSpirit !== undefined) builder.withSpirit(requirements.minSpirit);
    if (requirements.minRuneSockets !== undefined) builder.withRuneSockets(requirements.minRuneSockets);
    if (requirements.minArmour || requirements.minEvasion || requirements.minES) {
      builder.withDefenses(
        requirements.minArmour ? { min: requirements.minArmour } : undefined,
        requirements.minEvasion ? { min: requirements.minEvasion } : undefined,
        requirements.minES ? { min: requirements.minES } : undefined
      );
    }

    // Resistances
    if (requirements.fireResist || requirements.coldResist || requirements.lightningResist || requirements.chaosResist) {
      builder.withResistances({
        fire: requirements.fireResist || 0,
        cold: requirements.coldResist || 0,
        lightning: requirements.lightningResist || 0,
        chaos: requirements.chaosResist || 0,
      });
    }

    // Life/ES (using pseudo stats)
    const lifeESStats: Array<{ id: string; min?: number }> = [];
    if (requirements.minLife) {
      lifeESStats.push({
        id: 'pseudo.pseudo_total_life',
        min: requirements.minLife,
      });
    }
    if (requirements.minES && builder.game !== 'poe2') {
      lifeESStats.push({
        id: 'pseudo.pseudo_total_energy_shield',
        min: requirements.minES,
      });
    }
    if (lifeESStats.length > 0) {
      builder.withStats(lifeESStats);
    }

    // Custom stats
    if (requirements.stats && requirements.stats.length > 0) {
      builder.withStats(requirements.stats);
    }

    return builder;
  }

  /**
   * Apply common search options
   */
  applyOptions(options: SearchOptions): this {
    if (options.onlineOnly === false && !options.onlineStatus) this.withOnlineStatus('any');
    if (options.onlineOnly !== false || options.onlineStatus) {
      // Default to 'available' (both instant-buyout and in-person trade items).
      // Callers that want to restrict to instant-buyout-from-online-seller can
      // pass onlineStatus: 'securable' explicitly.
      this.withOnlineStatus(options.onlineStatus ?? 'available');
    }

    // Note: We intentionally do NOT set sale_type filter here.
    // By omitting it, we search for ALL items (both priced instant-buyout items AND unpriced negotiable items).
    // This gives users the full range of available items.

    if (options.minPrice !== undefined || options.maxPrice !== undefined) {
      this.withPriceRange(options.minPrice, options.maxPrice, options.priceCurrency);
    }

    if (options.sort) {
      const [field, order] = options.sort.split('_') as ['price', 'asc' | 'desc'];
      this.withSort(field, order);
    }

    return this;
  }

  /**
   * Build and return the final query
   */
  build(): TradeQuery {
    if (this.game === 'poe2') this.query.query.stats ??= [{type:'and',filters:[]}];
    return JSON.parse(JSON.stringify(this.query)); // Deep clone
  }

  /**
   * Reset the builder to start fresh
   */
  reset(): this {
    this.query = {
      query: {
        status: { option: 'online' },
        filters: {},
      },
    };
    return this;
  }
}
