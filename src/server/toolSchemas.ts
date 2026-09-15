/**
 * Tool Schemas
 *
 * Defines all MCP tool schemas for the PoB server.
 * These schemas describe the available tools, their parameters, and documentation.
 */

export interface JsonSchemaProp {
  type: string;
  description?: string;
  enum?: string[];
  items?: JsonSchemaProp;
  properties?: Record<string, JsonSchemaProp>;
  required?: string[];
  default?: unknown;
}

export interface ToolSchema {
  name: string;
  description: string;
  inputSchema: {
    type: "object";
    properties: Record<string, JsonSchemaProp>;
    required?: string[];
  };
}

/**
 * Get all tool schemas for registration with the MCP server
 */
export function getToolSchemas(): ToolSchema[] {
  const poe2 = process.env.POE_GAME === "poe2";
  return [
    {
      name: "analyze_build",
      description: "Analyze a Path of Building build file and extract detailed information including stats, skills, gear, passive skill tree analysis with keystones, notables, jewel sockets, build archetype detection, and optimization suggestions",
      inputSchema: {
        type: "object",
        properties: {
          build_name: {
            type: "string",
            description: "Name of the build file (e.g., 'MyBuild.xml')",
          },
        },
        required: ["build_name"],
      },
    },
    {
      name: "compare_builds",
      description: "Compare two Path of Building builds side by side",
      inputSchema: {
        type: "object",
        properties: {
          build1: {
            type: "string",
            description: "First build file name",
          },
          build2: {
            type: "string",
            description: "Second build file name",
          },
        },
        required: ["build1", "build2"],
      },
    },
    {
      name: "list_builds",
      description: "List all available Path of Building builds",
      inputSchema: {
        type: "object",
        properties: {},
      },
    },
    {
      name: "lua_list_characters",
      description: "List all characters on a PoE account via the official API. Does not require the Lua bridge to be enabled. Use this to find a character to import. Account name needs the discriminator (e.g., account#1234). If omitted, falls back to POE_ACCOUNT_NAME.",
      inputSchema: {
        type: "object",
        properties: {
          account_name: {
            type: "string",
            description: "PoE account name including discriminator (e.g., 'account#1234'). Optional when POE_ACCOUNT_NAME is set.",
          },
          realm: {
            type: "string",
            description: "Realm: 'pc', 'xbox', or 'sony' (default: 'pc').",
            enum: ["pc", "xbox", "sony"],
            default: "pc",
          },
        },
      },
    },
    {
      name: "get_build_stats",
      description: "Extract specific stats from a build (Life, DPS, resistances, etc.)",
      inputSchema: {
        type: "object",
        properties: {
          build_name: {
            type: "string",
            description: "Name of the build file",
          },
        },
        required: ["build_name"],
      },
    },
    {
      name: "start_watching",
      description: "Start monitoring the builds directory for changes. Builds will be auto-reloaded when saved in PoB.",
      inputSchema: {
        type: "object",
        properties: {},
      },
    },
    {
      name: "stop_watching",
      description: "Stop monitoring the builds directory for changes.",
      inputSchema: {
        type: "object",
        properties: {},
      },
    },
    {
      name: "get_recent_changes",
      description: "Get a list of recently changed build files.",
      inputSchema: {
        type: "object",
        properties: {
          limit: {
            type: "number",
            description: "Maximum number of recent changes to return (default: 10)",
          },
        },
      },
    },
    {
      name: "watch_status",
      description: "Check if file watching is currently enabled.",
      inputSchema: {
        type: "object",
        properties: {},
      },
    },
    {
      name: "refresh_tree_data",
      description: "Force refresh the passive skill tree data cache. Use this if tree data seems outdated.",
      inputSchema: {
        type: "object",
        properties: {
          version: {
            type: "string",
            description: "Specific tree version to refresh (optional, defaults to all versions)",
          },
        },
      },
    },
    {
      name: "compare_trees",
      description: "Compare passive skill trees between two builds, showing differences in allocated nodes",
      inputSchema: {
        type: "object",
        properties: {
          build1: {
            type: "string",
            description: "First build file name",
          },
          build2: {
            type: "string",
            description: "Second build file name",
          },
        },
        required: ["build1", "build2"],
      },
    },
    {
      name: "get_nearby_nodes",
      description: "Find notable and keystone passives near your current tree allocation. Uses loaded Lua bridge build when no build_name is provided.",
      inputSchema: {
        type: "object",
        properties: {
          build_name: {
            type: "string",
            description: "Build file to analyze (optional if a build is loaded via lua_load_build)",
          },
          max_distance: {
            type: "number",
            description: "Maximum path distance to search (default: 5)",
          },
          filter: {
            type: "string",
            description: "Optional text filter for node names/stats",
          },
        },
      },
    },
    {
      name: "plan_tree_paths",
      description: "Plan the minimum combined passive node cost to reach multiple target notables at once. Finds the shortest path to each target from the current tree, merges shared path prefixes (de-duplicating nodes that lie on multiple paths), and returns the combined node list ready for lua_set_tree. Replaces N separate find_path_to_node calls when planning a milestone build.",
      inputSchema: {
        type: "object",
        properties: {
          target_node_ids: {
            type: "array",
            items: { type: "string" },
            description: "IDs of the destination passive nodes (2–20 targets)",
          },
          build_name: {
            type: "string",
            description: "Build file to route from (optional if a build is loaded via lua_load_build)",
          },
        },
        required: ["target_node_ids"],
      },
    },
    {
      name: "find_path_to_node",
      description: "Find the shortest path of passive nodes between two points on the tree. By default routes from the build's current allocation frontier to the target. Supply from_node_id to route between any two arbitrary nodes regardless of the current build — useful for measuring distance between keystones, planning routes across the tree, etc. Each node in the result includes its name, type (Keystone/Notable/travel), and full stat descriptions.",
      inputSchema: {
        type: "object",
        properties: {
          build_name: {
            type: "string",
            description: "Build to analyze (optional if a build is loaded via lua_load_build)",
          },
          target_node_id: {
            type: "string",
            description: "ID of the destination passive node",
          },
          from_node_id: {
            type: "string",
            description: "Route from this specific node instead of the build's allocated frontier. Enables any-node-to-any-node routing independent of the current build (e.g. 'how many nodes between Resolute Technique and Iron Reflexes?').",
          },
          show_alternatives: {
            type: "boolean",
            description: "Return up to 3 alternative paths instead of just the shortest (default: false)",
          },
        },
        required: ["target_node_id"],
      },
    },
    {
      name: "get_tree_node",
      description: "Look up a single passive tree node by ID, sourced from PoB community's `tree.lua` (parsed locally, always-current with each PoE league). Returns the node's name, type (Notable/Keystone/Jewel Socket/Mastery/Travel), stats (already rendered to human-readable strings), positional fields (group/orbit/orbitIndex), and in/out connection lists. The schema matches GGG's published data.json EXCEPT for `group`, which uses PoB's internal numbering (stable per-load but differs from GGG). Node IDs and connection IDs ARE stable across both — only group IDs differ. This tool does NOT apply Timeless Jewel transformations; pass through to in-game tooltip for jewel-transformed nodes. See `tree-analysis.md` pitfall on Timeless Jewels.",
      inputSchema: {
        type: "object",
        properties: {
          node_id: {
            type: "string",
            description: "Passive node ID (e.g., '11730' for Endurance)",
          },
          tree_version: {
            type: "string",
            description: "PoE tree version directory under PathOfBuilding/src/TreeData/ (e.g., '3_28'). Optional — defaults to the latest version directory present.",
          },
          raw_json: {
            type: "boolean",
            description: "Return the raw JSON node object instead of a human-readable summary (default: false).",
          },
        },
        required: ["node_id"],
      },
    },
    {
      name: "report_tree_node_discrepancy",
      description: "Record a correction to GGG's passive tree data for a single node — writes to the skilltree fork's `data_patches.json` overlay file. Use only after applying the verification protocol in `reference_data/skilltree/PATCHES.md`: in particular, confirm the discrepancy is NOT a Timeless Jewel transformation (the blank-line tooltip test). After this tool writes to disk, the maintainer must commit and push the fork submodule to share the correction with the community — this tool only modifies the local file. Stamps `verified_date` with today's date automatically.",
      inputSchema: {
        type: "object",
        properties: {
          node_id: {
            type: "string",
            description: "Passive node ID (e.g., '11730').",
          },
          operation: {
            type: "string",
            enum: ["stats_add", "stats_replace", "name_replace", "flags_set"],
            description: "stats_add appends to the existing stats array. stats_replace replaces the whole stats array. name_replace replaces the node's name. flags_set updates flag values like isNotable/isKeystone. See PATCHES.md for guidance on when to use each.",
          },
          value: {
            // Shape depends on operation — see description. Schema validator
            // accepts the broadest type; the handler enforces operation-specific
            // shape with a clear error message.
            type: "string",
            description: "Operation-specific value. For stats_add/stats_replace: pass an array of stat strings (the schema lists type=string for broad compatibility, but the handler accepts arrays/objects too). For name_replace: a single string. For flags_set: an object mapping flag names to values.",
          },
          verified_from: {
            type: "string",
            enum: ["in-game tooltip", "PoB tree data", "PoB lua_get_passive_detail", "wiki", "reddit/forum"],
            description: "Where the correct value was verified. In-game tooltip is the most authoritative source.",
          },
          verified_by: {
            type: "string",
            description: "Who verified the correction (e.g., 'Memophage#4428' or 'Claude').",
          },
          note: {
            type: "string",
            description: "Optional context — why this patch is needed, any caveats.",
          },
        },
        required: ["node_id", "operation", "value", "verified_from", "verified_by"],
      },
    },
    {
      name: "list_tree_patches",
      description: "Audit the current patches in `reference_data/skilltree/data_patches.json`. Lists each entry with its operations, verification metadata, and age in days. Useful for finding stale patches that should be re-verified after a GGG export refresh, or for collecting candidates to submit upstream to GGG.",
      inputSchema: {
        type: "object",
        properties: {
          filter_source: {
            type: "string",
            description: "Only return patches verified from this source (e.g., 'in-game tooltip').",
          },
          min_age_days: {
            type: "number",
            description: "Only return patches older than this many days. Useful for finding stale entries.",
          },
        },
      },
    },
    {
      name: "evaluate_threshold_jewels",
      description: "Scan equipped jewels for attribute-threshold syntax using the exact active native tree. Supported legacy PoE1 thresholds count printed base attributes on all eligible nodes, including unallocated nodes, using the item radius where supplied. Reports threshold, total and margin; transformations and overrides are outside the static calculation. PoE2 attribute-threshold evaluation is unavailable unless a native counterpart and its mechanics are established; retained legacy parser patterns are not proof of support.",
      inputSchema: {
        type: "object",
        properties: {},
      },
    },
    {
      name: "search_crafting_mods",
      description: "Search PoB's structured item-mod table (parsed from `PathOfBuilding/src/Data/ModItem.lua`) for prefixes/suffixes matching combined filters. Returns the *actual* mod entries — affix name, stat lines with roll ranges, mod group (conflict key), minimum ilvl, mod tags, and per-item-class spawn weights. This is the concrete-numbers complement to `suggest_crafting`: use it for 'what mods can roll for +Life on a body armour at ilvl 75?', 'what's the highest tier of fire resistance on a ring?', 'all mods in the IncreasedLife group sorted by level', etc. Require at least one filter — the table has thousands of entries.\n\n`item_tags` carries the item's PoE tag hierarchy in priority order. For accuracy pass the full chain — body armours, helmets, gloves, boots, and shields all carry `armour` plus a base-specific tag like `body_armour` plus an attribute tag like `str_armour` / `str_dex_armour` / `int_armour`. Examples: an Astral Plate is `[\"body_armour\",\"armour\",\"str_armour\"]`; a Sapphire Ring is `[\"ring\"]`; a Hubris Circlet is `[\"helmet\",\"armour\",\"int_armour\"]`; a Vaal Axe is `[\"two_hand_weapon\",\"weapon\",\"axe\"]`. The mod's first weight-entry matching any of these tags wins; if none match, the mod's `default` weight applies.\n\n`type`: 'Prefix' or 'Suffix'. `has_tags` examples: `attribute`, `resource`, `life`, `mana`, `defences`, `damage`, `fire`, `cold`, `lightning`, `physical`, `caster`, `attack`, `critical`, `speed`. The `group` field is PoB's mod-conflict key — two mods with the same group can't roll together (e.g. all `IncreasedLife*` share group `IncreasedLife`).",
      inputSchema: {
        type: "object",
        properties: {
          stat_contains: { type: "string", description: "Case-insensitive substring match against any stat line text (e.g. 'Life', 'Fire Resistance', 'increased Spell Damage')." },
          item_tags: { type: "array", items: { type: "string" }, description: "Item-tag chain (priority order) — restricts to mods rollable on an item carrying any of these tags. Pass the FULL hierarchy: e.g. ['body_armour','armour','str_armour'] for an Astral Plate. See description for examples." },
          type: { type: "string", description: "'Prefix' or 'Suffix' (case-insensitive)." },
          min_level: { type: "number", description: "Minimum item-level for the mod to roll (PoE's mod tier gating)." },
          max_level: { type: "number", description: "Maximum mod level — useful for finding low-tier rolls available at any ilvl." },
          group: { type: "string", description: "Exact PoB mod-group key (e.g. 'IncreasedLife', 'Strength', 'FireResistance'). All mods in a group conflict — only one rolls per item." },
          has_tags: { type: "array", items: { type: "string" }, description: "Mod must include ALL listed PoE mod tags (e.g. ['fire','damage'] for fire damage mods)." },
          affix_contains: { type: "string", description: "Case-insensitive substring match against the affix display name (e.g. 'Tyrannical', 'of the Brute')." },
          limit: { type: "number", description: "Cap on returned results. Default 50, pass 0 for no cap (use with caution)." },
          raw_json: { type: "boolean", description: "Return the raw JSON list of mod entries instead of formatted text. Default false." },
        },
      },
    },
    {
      name: "calculate_mod_odds",
      description: poe2 ? "Estimate one plain PoE2 exalt, augment or regal action using a validated Craft of Exile cache. Requires actual item rarity and the complete existing affix ID list. Native PoB 1/0 flags are eligibility, not probabilities. Targets use CoE family names or coe:<group-id>. Unsupported methods, effects, source patches and ambiguous mappings produce no numerical odds. Repeated attempts and currency cost are not modeled." : "Compute the probability of hitting target modifiers when rolling a base item, using the game's real spawn weights (from ModItem.lua). Answers 'what are my odds of T1 Life + T1 Fire Resistance on this base at ilvl 86?'. EXACT for the modeled cases: mods drawn weighted from the prefix/suffix pool, one mod per mod-group (sampling without replacement at group level), prefixes/suffixes independent given the slot counts.\n\nEach target is `{stat}` (keyword, e.g. 'maximum Life' — must resolve to a single mod group or you'll get a disambiguation list) OR `{group}` (exact PoB group key, e.g. 'IncreasedLife'), plus optional `min_tier` (worst acceptable tier rank; e.g. 2 = T1 or T2). `method`: 'chaos' (full rare reroll, default, 3/3 slots), 'alt' (magic item, 1 prefix + 1 suffix), or 'essence' (pass `essence_name` — the forced mod is guaranteed and pre-placed). Override slot assumptions with `prefix_count`/`suffix_count` (0–3).\n\nOutput: per-target weight share, P(prefix targets), P(suffix targets), tier-filter factor, combined probability, and estimated full rerolls (1/P). LIMITATIONS (deliberately not modeled — use Craft of Exile for these): fossil/harvest weight changes, meta-craft sequences, exact per-orb affix-count variance, and currency cost.",
      inputSchema: {
        type: "object",
        properties: {
          base_name: { type: "string", description: "PoE base name (e.g. 'Astral Plate', 'Sapphire Ring'). Case-insensitive." },
          ilvl: { type: "number", description: "Item level — gates which tiers are in the pool." },
          targets: {
            type: "array",
            items: {
              type: "object",
              properties: {
                stat: { type: "string", description: "Stat-text keyword (must resolve to one mod group; ambiguous keywords return a disambiguation list)." },
                group: { type: "string", description: poe2 ? "CoE family name, e.g. Strength, or coe:<group-id>." : "Exact PoB mod-group key." },
                min_tier: { type: "number", description: "Worst acceptable tier rank (1=best). e.g. 2 means T1 or T2 acceptable. Omit = any tier." },
              },
            },
            description: "Target mods you want to hit (1 or more).",
          },
          method: { type: "string", enum: poe2 ? ["exalt", "augment", "regal"] : ["chaos", "alt", "essence"], description: poe2 ? "Explicit one-step PoE2 operation; no default reroll is assumed." : "PoE1 chaos, alteration or essence model." },
          essence_name: { type: "string", description: "Required for method 'essence' (e.g. 'Deafening Essence of Greed'). The forced mod is guaranteed." },
          prefix_count: { type: "number", description: "Assumed prefix slots filled (0–3, default 3 for chaos / 1 for alt)." },
          suffix_count: { type: "number", description: "Assumed suffix slots filled (0–3, default 3 for chaos / 1 for alt)." },
          item_rarity: { type: "string", enum: ["magic", "rare"], description: "PoE2 current rarity." },
          existing_mod_ids: { type: "array", items: {type:"string"}, description: "Complete current explicit affix CoE keys, even if empty. Slot counts alone are insufficient." },
          raw_json: { type: "boolean", description: "Return structured JSON. Default false." },
        },
        required: poe2 ? ["base_name", "ilvl", "targets", "method", "item_rarity", "existing_mod_ids"] : ["base_name", "ilvl", "targets"],
      },
    },
    {
      name: "search_master_crafts",
      description: "Search PoB's bench (master) craft table (`Data/ModMaster.lua`) — the deterministic mods you can add at the crafting bench. Answers 'what can I bench-craft on a ring?', 'what bench crafts give cold resistance?', 'is there a bench craft for movement speed?'. Filters: `stat_contains` (substring on stat text), `item_type` (PoE TYPE name: 'Body Armour', 'Ring', 'Amulet', 'Belt', 'Gloves', 'Boots', 'Helmet', 'Shield', 'Quiver', 'One Handed Sword', 'Two Handed Axe', 'Wand', 'Staff', etc.), `type` (Prefix/Suffix), `has_tags`. Bench crafts are deterministic (no spawn weight / random tier) and occupy a prefix or suffix slot. Multiple level-tiers exist per group; higher level = stronger.",
      inputSchema: {
        type: "object",
        properties: {
          stat_contains: { type: "string", description: "Case-insensitive substring match against the craft's stat text (e.g. 'Cold Resistance', 'Movement Speed', 'maximum Life')." },
          item_type: { type: "string", description: "PoE item TYPE name (NOT a tag) the craft must apply to. Examples: 'Body Armour', 'Ring', 'One Handed Sword'." },
          type: { type: "string", description: "'Prefix' or 'Suffix'." },
          has_tags: { type: "array", items: { type: "string" }, description: "Craft must include all listed mod tags (e.g. ['resistance'])." },
          limit: { type: "number", description: "Max results. Default 50, 0 = no cap." },
          raw_json: { type: "boolean", description: "Return raw JSON. Default false." },
        },
      },
    },
    {
      name: "get_essence_detail",
      description: "Inspect essences (`Data/Essence.lua`). Two modes:\n1. Pass `essence_name` (e.g. 'Deafening Essence of Greed') to see exactly what mod that essence guarantees on each item type — resolved to real stat text from ModItem.lua. Optional `item_type` narrows to one type.\n2. Pass `stat_contains` (e.g. 'maximum Life') to list which essences provide that stat and on which item types.\nEssences reroll a rare and guarantee one specific mod for the item's type. Tier order (strongest first): Deafening > Shrieking > Screaming > Wailing > Weeping > Muttering > Whispering. Essence name lookup is case-insensitive with fuzzy suggestions on miss.",
      inputSchema: {
        type: "object",
        properties: {
          essence_name: { type: "string", description: "Full or partial essence name (e.g. 'Deafening Essence of Greed'). Mode 1." },
          stat_contains: { type: "string", description: "Stat-text substring to find essences that provide it (e.g. 'Fire Resistance'). Mode 2." },
          item_type: { type: "string", description: "Optional PoE item TYPE name to narrow mode-1 results to a single type." },
          raw_json: { type: "boolean", description: "Return raw JSON. Default false." },
        },
      },
    },
    {
      name: "get_stat_breakdown",
      description: "Explain WHY a stat has its value: tabulates every modifier contributing to it from the live PoB build, with source attribution (which passive, item, or config). Answers 'where does my Life / resistance / armour come from?'. Groups contributions by type — BASE (flat), INC (increased/reduced %), MORE (multiplicative %), OVERRIDE, FLAG — and resolves passive-tree sources to node names. This is SOURCE attribution; for the actual applied multiplier chain (the inc-vs-more diagnosis) use `get_calc_breakdown`.\n\n`stat` is PoB's internal MODIFIER name (CamelCase, no spaces), which often differs from the displayed label. VERIFIED-WORKING names (live-tested): 'Life', 'Mana', 'EnergyShield', 'Armour', 'Evasion', 'FireResist', 'ColdResist', 'LightningResist', 'ChaosResist', 'Str', 'Dex', 'Int', 'LifeRegen', 'ManaRegen', 'MovementSpeed', 'CritChance', 'CritMultiplier'. COMMON TRAPS: resistances are the short '...Resist' form (NOT '...Resistance'); attributes are 'Str'/'Dex'/'Int' (NOT 'Strength'/'Dexterity'/'Intelligence').\n\nGLOBAL vs SKILL config: by default it tabulates the player modDB with NO skill config — complete for unconditional stats (life, resists, attributes, armour/ES, regen, movement speed) but it OMITS skill-conditional mods. Set `use_skill_config: true` to tabulate the MAIN skill's modList with its config instead — this captures skill-conditional modifiers (e.g. 'Damage', 'FireDamage', 'AttackSpeed', 'CritChance' as they apply to the main skill) with full source attribution. For the *whole* damage multiplier chain (base→added→conversion→inc→more→crit→ailment) use `get_calc_breakdown` instead; this tool is per-modifier-name source attribution. Requires a live PoB build (LaunchPoBWithAPI.bat).",
      inputSchema: {
        type: "object",
        properties: {
          stat: { type: "string", description: "PoB internal modifier name (CamelCase, no spaces). Resistances use the SHORT form ('FireResist', 'ColdResist', 'LightningResist', 'ChaosResist'); attributes are 'Str'/'Dex'/'Int'. Also 'Life', 'Mana', 'EnergyShield', 'Armour', 'Evasion', 'LifeRegen', 'ManaRegen', 'MovementSpeed', 'CritChance', 'CritMultiplier'. With use_skill_config: damage names like 'Damage', 'FireDamage', 'AttackSpeed'." },
          actor: { type: "string", enum: ["player", "minion"], description: "Whose modifiers to tabulate. Default 'player'." },
          use_skill_config: { type: "boolean", description: "Tabulate against the MAIN skill's modList + config instead of the global player modDB. Required to capture skill-conditional mods (damage, attack/cast speed, crit for the skill). Default false." },
          raw_json: { type: "boolean", description: "Return structured JSON (with both raw and humanized sources) instead of formatted text. Default false." },
        },
        required: ["stat"],
      },
    },
    {
      name: "get_calc_breakdown",
      description: "Show PoB's OWN computed breakdown for an output stat — the multiplier chain exactly as the Calcs tab displays it: base → added → conversion → increased → more → crit → ailment → total. This is the 'why is my damage / stat this number, and which bucket is weak' view, relayed verbatim from PoB's calc engine (no math re-derived on our side). The complement to `get_stat_breakdown`: this gives the PIPELINE; that gives per-modifier SOURCE attribution (where a bucket's value comes from).\n\n`stat` is a PoB output-stat key (e.g. 'AverageDamage', 'TotalDPS', 'Speed', 'CritChance', 'AverageHit', 'ManaCost', and many more). Call with NO stat (or an unknown one) to get the list of stats that currently have a breakdown for the open build — the available set depends on the build (damage breakdowns require a valid main skill + configured enemy). Requires a live PoB build (LaunchPoBWithAPI.bat).",
      inputSchema: {
        type: "object",
        properties: {
          stat: { type: "string", description: "PoB output-stat key (e.g. 'AverageDamage', 'TotalDPS', 'Speed', 'CritChance'). Omit to list the stats that currently have a breakdown." },
          actor: { type: "string", enum: ["player", "minion"], description: "Whose breakdown. Default 'player'." },
          raw_json: { type: "boolean", description: "Return structured JSON instead of formatted text. Default false." },
        },
      },
    },
    {
      name: "analyze_item_mods",
      description: "Identify each mod line on an item against PoB's data and report tier info + next-tier upgrade target. Two input modes:\n1. `mod_lines` — array of explicit prefix/suffix lines, exactly as PoE shows them (e.g. '+150 to maximum Life'). Append ` {crafted}` / ` {fractured}` to tag those.\n2. `item_slot` — read a live equipped item straight from the open PoB build over TCP (e.g. 'Body Armour', 'Helmet', 'Ring 1', 'Weapon 1'). The tool fetches the item, extracts its explicit/crafted/fractured mods, and auto-derives base_name + ilvl from the item. Requires PoB launched via LaunchPoBWithAPI.bat. (item_slot takes precedence over mod_lines.)\n\nOptional `base_name` (e.g. 'Astral Plate') gates matching by tag chain — sharpens disambiguation and makes tier ladders reflect only mods rollable on the base. Optional `ilvl` filters the tier ladder. Both are auto-filled when item_slot is used.\n\nFor each line: matched mod ID, affix name, mod group, tier rank (e.g. T3 of 13), and the next-tier mod with required ilvl + new value range. `{crafted}` lines match the bench-craft pool (ModMaster.lua). Hybrid-mod continuation lines are collapsed. Provide one of mod_lines or item_slot.",
      inputSchema: {
        type: "object",
        properties: {
          mod_lines: { type: "array", items: { type: "string" }, description: "Array of explicit-mod text lines from the item (one per entry). Omit implicit/unique-specific mods. Append ' {crafted}' or ' {fractured}' to tag those sources." },
          item_slot: { type: "string", description: "Read the item from the live PoB build instead of mod_lines. PoB slot label: 'Body Armour', 'Helmet', 'Gloves', 'Boots', 'Belt', 'Amulet', 'Ring 1', 'Ring 2', 'Weapon 1', 'Weapon 2'. Requires a connected PoB TCP bridge." },
          base_name: { type: "string", description: "PoE base name (e.g. 'Astral Plate'). Auto-derived when item_slot is used. Case-insensitive; fuzzy suggestions on miss." },
          ilvl: { type: "number", description: "Item level — filters tier ladder. Auto-derived when item_slot is used." },
          raw_json: { type: "boolean", description: "Return structured JSON instead of formatted text. Default false." },
        },
      },
    },
    {
      name: "list_craftable_mods_for_base",
      description: "Dump the entire craftable mod space for a specific base item — every prefix and suffix that can roll on it, grouped by mod-group (conflict key) with the highest tier first. Builds on `search_crafting_mods` but resolves the base's tag chain automatically: pass 'Astral Plate' and the tool reads PoB's `Data/Bases/body.lua` to learn the base is `['armour','body_armour','default','str_armour','top_tier_base_item_type']`, then walks ModItem.lua applying PoE's first-match-wins weight resolution per group. Use this for 'what's the entire craftable space on a Hubris Circlet at ilvl 86?', 'what suffixes can I roll on a Steel Ring?', 'show me every life-related mod available on this base'. Output is split PREFIXES / SUFFIXES, with mods within each group sorted by descending level so the highest available tier is on top. Base name lookup is case-insensitive; if the name doesn't resolve, the tool surfaces fuzzy suggestions.",
      inputSchema: {
        type: "object",
        properties: {
          base_name: { type: "string", description: "Exact (case-insensitive) PoE base name, e.g. 'Astral Plate', 'Hubris Circlet', 'Sapphire Ring', 'Vaal Axe'. If not found, the tool returns 5 fuzzy-match suggestions." },
          ilvl: { type: "number", description: "Item level — gates mods whose `level` exceeds this. Omit to list every tier regardless of ilvl." },
          type: { type: "string", description: "Filter to 'Prefix' or 'Suffix' only. Omit for both." },
          tiers_per_group: { type: "number", description: "How many top tiers per mod group to display. Default 1 (top tier only — useful for 'what's the ceiling on this base'). Pass a higher number (e.g. 3) for tier ladders, or 0 for all tiers." },
          hide_unrollable: { type: "boolean", description: "Hide mods whose resolved weight is 0 on this base (essence-only / fossil-only / influenced-only entries that aren't naturally rollable). Default true." },
          stat_contains: { type: "string", description: "Optional substring filter on stat text (e.g. 'Life' to narrow the dump to life-related mods)." },
          raw_json: { type: "boolean", description: "Return structured JSON instead of formatted text. Default false." },
        },
        required: ["base_name"],
      },
    },
    {
      name: "get_atlas_node",
      description: poe2 ? "Read a PoE2 atlas node from the RePoE export, including source version, checksum, subtree and graph links. Only the default PoE2 graph is supported. Selector effects and player allocation are not supplied by this dataset." : "Look up a single Atlas of Worlds tree node by ID. Returns name, stats, type (Notable/Keystone/Jewel Socket/Mastery/Travel/Wormhole/Ascendancy), positional fields, and in/out connections. Data sourced from `reference_data/atlastree/data.json` (GGG's official atlas-export, mirrored in our community fork submodule). The data_patches.json overlay is applied if present. Unlike `get_tree_node` for the passive tree, there's no jewel-transformation layer — atlas doesn't have Timeless-Jewel-equivalent mechanics. Variants supported: `default`, `league` (current league), `ruthless`, `ruthless-league`.",
      inputSchema: {
        type: "object",
        properties: {
          node_id: { type: "string", description: poe2 ? "PoE2 atlas node ID from search_atlas_nodes." : "Atlas node ID (e.g., '1670' for Fortune's Favour)." },
          variant: { type: "string", description: "Atlas tree variant. Defaults to 'default' (standard atlas).", enum: poe2 ? ["default"] : ["default", "league", "ruthless", "ruthless-league"] },
          raw_json: { type: "boolean", description: "Return raw JSON node object instead of a human-readable summary. Default false." },
        },
        required: ["node_id"],
      },
    },
    {
      name: "search_atlas_nodes",
      description: poe2 ? "Search native PoE2 atlas node names and stat text, with source/version metadata. Display-only decorations are excluded. Only variant default is supported." : "Search the atlas tree for nodes matching a keyword (name or stat text). Optional node-type filter (`keystone`, `notable`, `jewel`, `mastery`, `wormhole`, `ascendancy`, `normal`). Useful for finding all atlas notables related to a mechanic (e.g., 'breach', 'expedition', 'heist'). Variant-aware (default/league/ruthless/ruthless-league).",
      inputSchema: {
        type: "object",
        properties: {
          query: { type: "string", description: "Substring to match against node names or stat text (case-insensitive)." },
          node_type: { type: "string", description: "Filter to a node type. Omit or pass 'any' for no filter.", enum: ["keystone", "notable", "jewel", "mastery", "wormhole", "ascendancy", "normal", "any"] },
          limit: { type: "number", description: "Max results (default 30)." },
          variant: { type: "string", description: "Atlas tree variant. Defaults to 'default'.", enum: poe2 ? ["default"] : ["default", "league", "ruthless", "ruthless-league"] },
        },
        required: ["query"],
      },
    },
    {
      name: "find_atlas_path_to_node",
      description: poe2 ? "Find an undirected graph path between explicit PoE2 atlas node IDs. Excludes display-only nodes. Distance is graph edges, not verified allocation cost; quest gates and current allocation remain unknown." : "Find the shortest path of passive nodes between two atlas tree nodes (BFS over the undirected in/out graph). The atlas tree's allocation state isn't visible to our tools via the public PoE API, so this tool requires an explicit `from_node_id` — there's no 'from build frontier' mode like in the passive-tree equivalent. Use it to measure distance between two notables, or to plan a route from your current allocation frontier (which you'd tell the tool manually) to a target notable.",
      inputSchema: {
        type: "object",
        properties: {
          target_node_id: { type: "string", description: "Destination atlas node ID." },
          from_node_id: { type: "string", description: "Source atlas node ID (required — atlas allocation isn't API-visible)." },
          variant: { type: "string", description: "Atlas tree variant. Defaults to 'default'.", enum: poe2 ? ["default"] : ["default", "league", "ruthless", "ruthless-league"] },
        },
        required: ["target_node_id", "from_node_id"],
      },
    },
    {
      name: "list_radius_effect_jewels",
      description: "Scan equipped jewels against the exact active native tree and weapon set. For PoE2, report supported Time-Lost node-type targets and the selected Controlled Metamorphosis ring, including inner/outer bounds, eligible allocated targets and eligible unallocated nodes. Inactive sockets and unavailable or ambiguous rules are explicit. This is node-scope reporting, not a numeric effect or jewel-limit calculation. Timeless conquest and attribute thresholds have separate queries.",
      inputSchema: {
        type: "object",
        properties: {},
      },
    },
    {
      name: "list_cluster_jewel_nodes",
      description: "Summarize what each socketed Cluster Jewel (Large/Medium/Small) contributes to the passive tree — total passives, jewel sockets, the small-passive enchant bonus, additional small-passive mods, and the specific notables added. Reads from the live build via PoB. Cluster jewels often drive the biggest build-shape differences (their notables are frequently the highest-value stats in a build), so this is useful for build comparisons, DPS analyses, and cluster shopping. PoB also stores the actual generated node entries — those still show up in lua_get_tree — but this tool provides the high-level cluster-by-cluster view that's hard to extract otherwise.",
      inputSchema: {
        type: "object",
        properties: {},
      },
    },
    {
      name: "get_tree_node_with_timeless_jewels",
      description: "Return a single passive node's CURRENT in-PoB stats, including any transformations applied by socketed Timeless Jewels (Lethal Pride, Glorious Vanity, etc.). Where `get_tree_node` returns the base data from PoB's tree.lua and `find_jewel_affected_nodes` tells you WHICH nodes are being transformed, this tool tells you WHAT they transform into — by reading PoB's already-computed post-transformation node state. No tooltip pastes, no game-data extraction, no template renderer needed; PoB has already done the work. Requires PoB Lua client (live TCP build or loaded XML). NOTE: requires the patched PathOfBuilding/src/API/BuildOps.lua + Handlers.lua with the `get_node_state` action — restart PoB via LaunchPoBWithAPI.bat after pulling the suite update for this tool to work.",
      inputSchema: {
        type: "object",
        properties: {
          node_id: {
            type: "string",
            description: "Passive node ID (e.g. '11730' for Endurance)",
          },
        },
        required: ["node_id"],
      },
    },
    {
      name: "get_node_power",
      description: "Return passive nodes ranked by PoB's built-in node power score (the same heat-map data shown by 'Show Node Power' on the tree). Each node gets an offence score (DPS contribution) and a defence score (life/armour/ES/evasion contribution). Requires the power to have been calculated — either enable 'Show Node Power' in PoB first, or pass recalculate=true (starts PoB's PowerBuilder; the API drives it in the background and partial data is available immediately). ⚠ Cost scales with the build's calc weight: on a build using the spectre MODELING GROUP (multiple Raise Spectre instances), a full recalculation is ~1300 nodes × several minion environments and can take MINUTES, degrading PoB's responsiveness meanwhile — consider temporarily disabling the modeling group (toggle_socket_group enabled=false) before tree-power work, then re-enabling. The API no longer pre-warms this on connect and never auto-restarts it on build changes (that starved the TCP bridge).",
      inputSchema: {
        type: "object",
        properties: {
          mode: {
            type: "string",
            enum: ["combined", "offence", "defence"],
            description: "Sort order: combined (offence+defence), offence only, or defence only. Default: combined.",
          },
          filter: {
            type: "string",
            enum: ["unallocated", "allocated", "all"],
            description: "Which nodes to include. Default: unallocated (most useful for 'what to take next').",
          },
          max_depth: {
            type: "number",
            description: "Only return nodes within this many hops from the current allocated tree. Omit for no limit.",
          },
          limit: {
            type: "number",
            description: "Maximum number of results to return. Default: 20.",
          },
          recalculate: {
            type: "boolean",
            description: "Force PoB to recompute node power before reading. Use if has_data=false or after changing the build. Default: false.",
          },
        },
      },
    },
    {
      name: "find_jewel_affected_nodes",
      description: "Read-only Timeless jewel awareness for the current native tree and weapon set. Identifies supported PoE1 jewels and catalog-verified PoE2 Heroic Tragedy / Undying Hate, including seed, leader and native radius. Reports geometric candidates and current get_node_state evidence for up to 30 allocated candidates, with explicit unread or unavailable coverage. Conquest metadata does not prove complete seed-dependent transformation support. No transformations are calculated independently.",
      inputSchema: {
        type: "object",
        properties: {},
      },
    },
    {
      name: "get_tree_node_patch",
      description: "Read the current patch entry (if any) for a single node from `data_patches.json`. Returns null/empty if no patch exists. Read-only; use `report_tree_node_discrepancy` to add or update.",
      inputSchema: {
        type: "object",
        properties: {
          node_id: {
            type: "string",
            description: "Passive node ID (e.g., '11730').",
          },
        },
        required: ["node_id"],
      },
    },
    {
      name: "get_build_notes",
      description: "Read the notes/documentation from a PoB build file",
      inputSchema: {
        type: "object",
        properties: {
          build_name: { type: "string", description: "Name of the build file (e.g., 'MyBuild.xml')" },
        },
        required: ["build_name"],
      },
    },
    {
      name: "set_build_notes",
      description: "Write notes/documentation into a PoB build file (overwrites existing notes)",
      inputSchema: {
        type: "object",
        properties: {
          build_name: { type: "string", description: "Name of the build file" },
          notes: { type: "string", description: "Notes content to write (plain text or markdown)" },
        },
        required: ["build_name", "notes"],
      },
    },
  ];
}

/**
 * Get Lua-specific tool schemas (only included if Lua is enabled)
 */
export function getLuaToolSchemas(): any[] {
  const poe2 = process.env.POE_GAME === "poe2";
  const legacySlots = ["Weapon 1", "Weapon 2", "Helmet", "Body Armour", "Gloves", "Boots", "Amulet", "Ring 1", "Ring 2", "Belt", "Flask 1", "Flask 2", "Flask 3", "Flask 4", "Flask 5"];
  // SkillsTab's slot-linked groups attach to equipment; consumables are item slots only.
  const skillSlots = poe2
    ? ["Weapon 1", "Weapon 2", "Weapon 1 Swap", "Weapon 2 Swap", "Helmet", "Body Armour", "Gloves", "Boots", "Amulet", "Ring 1", "Ring 2", "Ring 3", "Belt"]
    : legacySlots;
  const equipmentSlots = poe2
    ? [...skillSlots, "Flask 1", "Flask 2", "Charm 1", "Charm 2", "Charm 3", "Arm 1", "Arm 2", "Leg 1", "Leg 2"]
    : legacySlots;
  return [
    {
      name: "lua_start",
      description: "Start or connect to the PoB calculation engine. In TCP mode (POB_API_TCP=true) this connects to a running PoB GUI rather than spawning a headless process. PoB must be running via LaunchPoBWithAPI.bat and have a build open. A background keepalive subscript keeps PoB's frame loop ticking at ~60 fps even when PoB is minimised or in the background, so no foreground interaction is needed.",
      inputSchema: {
        type: "object",
        properties: {},
      },
    },
    {
      name: "lua_stop",
      description: "Stop the PoB headless API process and clean up resources.",
      inputSchema: {
        type: "object",
        properties: {},
      },
    },
    {
      name: "lua_new_build",
      description: poe2 ? "Create a blank PoB2 build. Class and ascendancy names are validated against the installed native tree before opening; creation completes only after that class is selected and calculated. No PoE1 IDs or fallback class are used." : "Create a new blank build with specified class and ascendancy. In TCP mode this opens the new build in the running PoB GUI. Auto-starts the Lua bridge if needed. Classes and ascendancies (PoE1): Scion: Ascendant | Marauder: Juggernaut, Berserker, Chieftain | Ranger: Raider, Deadeye, Pathfinder | Witch: Occultist, Elementalist, Necromancer | Duelist: Slayer, Gladiator, Champion | Templar: Inquisitor, Hierophant, Guardian | Shadow: Assassin, Trickster, Saboteur",
      inputSchema: {
        type: "object",
        properties: {
          class_name: { type: "string", description: poe2 ? "Exact class name from the installed PoB2 tree, e.g. Witch or Sorceress." : "Class name (e.g., 'Witch', 'Marauder')" },
          ascendancy: { type: "string", description: poe2 ? "Exact ascendancy belonging to that installed PoB2 class, e.g. Blood Mage for Witch. Omit or use None for unascended." : "Ascendancy class name (optional)" },
        },
        required: ["class_name"],
      },
    },
    {
      name: "lua_close_build",
      description: "Close the currently open build and return to the PoB build list screen. TCP mode only. Use this between batch operations (e.g. import all characters) to keep the GUI clean between builds. After closing, use lua_new_build or lua_load_build to open the next one.",
      inputSchema: { type: "object", properties: {} },
    },
    {
      name: "lua_save_build",
      description: "Save the currently loaded in-memory Lua bridge build to a file. Required before using file-based tools (validate_build, analyze_build, etc.) on an in-memory build. Also works as SAVE-AS: pass a new build_name to write a named version/checkpoint that appears in PoB's own build-load screen (the active build is NOT retargeted, so later saves still go to the original). Saving over a build OTHER than the one currently open is refused unless overwrite: true — it is a silent, permanent replacement and PoB keeps no backup. Call list_builds first when inventing a name.",
      inputSchema: {
        type: "object",
        properties: {
          build_name: {
            type: "string",
            description: "Output filename (e.g., 'MyBuild.xml'). .xml extension added automatically if missing.",
          },
          overwrite: {
            type: "boolean",
            description: "Allow replacing an EXISTING build file other than the one currently open. Default false. Only set this when the user has asked for that specific file to be replaced — it destroys the previous contents.",
          },
        },
        required: ["build_name"],
      },
    },
    {
      name: "lua_load_build",
      description: "Load a build file into the PoB calculation engine. In TCP mode this opens the build in the running PoB GUI. AUTO-RETURNS a brief summary (life, DPS, EHP, resistances, top issues) — do NOT immediately follow with lua_get_stats or get_build_issues just to get basic numbers. Call additional tools only when you need details beyond the summary.",
      inputSchema: {
        type: "object",
        properties: {
          build_name: {
            type: "string",
            description: "Name of the build file to load",
          },
          build_xml: { type: "string", description: "Complete build XML. For get_character_pob, pass its pob_xml field, not the JSON envelope. Preserves all sets and extensions." },
          name: { type: "string", description: "Optional display name for the opened build." },
        },
        oneOf: [{ required: ["build_name"] }, { required: ["build_xml"] }],
      },
    },
    {
      name: "lua_import_character",
      description: poe2 ? "Load a complete public PoB2 character snapshot. Call get_character_pob separately and pass its pob_xml field. Its pob_code and source metadata remain with that public result. This preserves the complete build and all sets; selective account/API imports are not supported by this public PoE2 route." : "Import a character from the official PoE API into the currently loaded build (replaces tree, items, and gems). Requires a build loaded via lua_load_build or lua_new_build. If account_name is omitted, falls back to POE_ACCOUNT_NAME. Set POE_SESSION_ID env var for private profiles.",
      inputSchema: {
        type: "object",
        properties: poe2 ? {
          pob_xml: { type: "string", description: "The actual pob_xml string returned by get_character_pob, without the JSON envelope." },
          character_name: { type: "string", description: "Optional display name for this public snapshot; no account lookup is performed." },
        } : {
          account_name: {
            type: "string",
            description: "PoE account name including discriminator (e.g., 'account#1234'). Optional when POE_ACCOUNT_NAME is set.",
          },
          character_name: {
            type: "string",
            description: "Exact character name to import (case-sensitive).",
          },
          realm: {
            type: "string",
            description: "Realm: 'pc', 'xbox', or 'sony' (default: 'pc').",
            enum: ["pc", "xbox", "sony"],
            default: "pc",
          },
          clear_jewels: {
            type: "boolean",
            description: "Clear existing jewels before importing the new tree (default: true).",
            default: true,
          },
          clear_items: {
            type: "boolean",
            description: "Clear existing equipped items before importing (default: true).",
            default: true,
          },
          clear_skills: {
            type: "boolean",
            description: "Clear existing skill gems before importing (default: true).",
            default: true,
          },
          ignore_weapon_swap: {
            type: "boolean",
            description: "Skip importing the weapon swap slots AND keep the build's existing 'use second weapon set' flag untouched. Use this when you have a custom swap configuration (e.g. leveling weapons in the swap) you want preserved. Default false: import the swap items and force the calc engine to use the primary slots so stats match the character's in-game active set.",
            default: false,
          },
          bandit: {
            type: "string",
            description: "Bandit choice to set after import. The PoE API does not expose this — ask the user which bandit they chose. Values: 'None' (Kill All, +1 passive point in current PoE1 — note the second point that was historically from Kill All is now from the 'Through Sacred Ground' quest), 'Alira' (+5 mana regen, +15% all res, +20% crit multi), 'Kraityn' (+6% atk/cast speed, +6% ailment avoidance, +6% move speed), 'Oak' (+2% life regen, +20 max life, +6% phys reduction).",
            enum: ["None", "Alira", "Kraityn", "Oak"],
          },
        },
        required: poe2 ? ["pob_xml"] : ["character_name"],
      },
    },
    {
      name: "lua_import_pobb",
      description: "Load a Path of Building build from a pobb.in or poedb.tw URL (or bare pobb.in ID) into PoB. Accepts: pobb.in URLs (https://pobb.in/abc123), user-namespaced pobb.in URLs (https://pobb.in/u/user/abc123), bare pobb.in IDs (abc123), or poedb.tw URLs (https://poedb.tw/us/PathOfBuilding?id=abc123). Fetches the build XML, opens it in PoB, and returns a stat summary. In TCP mode this opens the build in the running PoB GUI.",
      inputSchema: {
        type: "object",
        properties: {
          url_or_id: {
            type: "string",
            description: "pobb.in URL (https://pobb.in/abc123), user-namespaced URL (https://pobb.in/u/username/abc123), or raw build ID (abc123).",
          },
        },
        required: ["url_or_id"],
      },
    },
    {
      name: "lua_share_pobb",
      description: "Export the currently loaded PoB build and upload it to pobb.in (default) or poedb.tw. Returns a shareable URL. No account needed — creates an anonymous paste.",
      inputSchema: {
        type: "object",
        properties: {
          platform: {
            type: "string",
            description: "Paste platform: pobb.in (default) or poedb.tw.",
            enum: ["pobb.in", "poedb.tw"],
            default: "pobb.in",
          },
        },
      },
    },
    {
      name: "get_context_usage",
      description: "Read usage metadata from an explicitly selected Codex or Claude transcript whose session ID matches thread_id. Requires client, transcript_path and thread_id together. No arguments returns unavailable without filesystem access; never discovers or reads another session automatically. Cached input is a subset; cumulative usage is distinct from context occupancy and account limits.",
      inputSchema: { type: "object", properties: {
        client: { type: "string", enum: ["codex", "claude"] },
        transcript_path: { type: "string", description: "Explicit absolute path to the current authorized session transcript." },
        thread_id: { type: "string", description: "Expected current session ID; must match the transcript identity." },
      } },
    },
    {
      name: "list_specs",
      description: "List all passive tree specs in the currently loaded build. Each spec can have a different tree allocation, class, and ascendancy.",
      inputSchema: { type: "object", properties: {} },
    },
    {
      name: "select_spec",
      description: "Switch the active passive tree spec in the currently loaded build. Recalculates all stats with the selected spec.",
      inputSchema: {
        type: "object",
        properties: {
          index: { type: "number", description: "Spec index (1-based, use list_specs to see available specs)" },
        },
        required: ["index"],
      },
    },
    {
      name: "create_spec",
      description: "Create a new passive tree spec in the current build. Use for leveling guides: create specs titled 'Level 10', 'Level 20', etc. with different tree allocations. Use copyFrom to start from an existing spec and modify.",
      inputSchema: {
        type: "object",
        properties: {
          title: { type: "string", description: "Title for the new spec (e.g. 'Level 40 Tree')" },
          copyFrom: { type: "number", description: "Spec index (1-based) to copy class/ascendancy/nodes from" },
          activate: { type: "boolean", description: "Whether to switch to the new spec (default: true)" },
        },
      },
    },
    {
      name: "delete_spec",
      description: "Delete a passive tree spec from the current build. Cannot delete the last remaining spec or the currently active spec (switch first with select_spec).",
      inputSchema: {
        type: "object",
        properties: {
          index: { type: "number", description: "Spec index to delete (1-based, use list_specs to see available specs)" },
        },
        required: ["index"],
      },
    },
    {
      name: "rename_spec",
      description: "Rename a passive tree spec in the current build.",
      inputSchema: {
        type: "object",
        properties: {
          index: { type: "number", description: "Spec index to rename (1-based)" },
          title: { type: "string", description: "New title for the spec" },
        },
        required: ["index", "title"],
      },
    },
    {
      name: "list_item_sets",
      description: "List all item sets in the currently loaded build. Each item set can have different gear equipped.",
      inputSchema: { type: "object", properties: {} },
    },
    {
      name: "select_item_set",
      description: "Switch the active item set in the currently loaded build. Recalculates all stats with the selected item set.",
      inputSchema: {
        type: "object",
        properties: {
          id: { type: "number", description: "Item set ID (use list_item_sets to see available item sets)" },
        },
        required: ["id"],
      },
    },
    {
      name: "create_item_set",
      description: "Create a new item set in the current build. Use copyFrom to duplicate an existing item set (all equipped items are copied). Use for testing gear changes without affecting the active set.",
      inputSchema: {
        type: "object",
        properties: {
          title: { type: "string", description: "Name for the new item set (default: source title with ' (copy)' suffix, or 'Item Set N' for blank)" },
          copyFrom: { type: "number", description: "Item set ID to copy all equipped gear from (use list_item_sets to find IDs). Omit to create a blank set." },
          activate: { type: "boolean", description: "Switch to the new item set immediately after creation (default: false)" },
        },
      },
    },
    {
      name: "set_character_level",
      description: "Set the character level for the currently loaded build. Recalculates all stats.",
      inputSchema: {
        type: "object",
        properties: {
          level: {
            type: "number",
            description: "Character level (1-100)",
          },
        },
        required: ["level"],
      },
    },
    {
      name: "lua_get_stats",
      description: "Get comprehensive calculated stats from the currently loaded build (requires lua_load_build first). Use category='offense' for DPS details, category='defense' for survivability, category='all' only when you need everything at once. Avoid calling multiple times with different categories — pick the right one.",
      inputSchema: {
        type: "object",
        properties: {
          category: {
            type: "string",
            description: "Stat category: 'offense', 'defense', 'all' (default: all)",
          },
        },
      },
    },
    {
      name: "minion_dps_breakdown",
      description:
        "Per-skill Full DPS table for minion and multi-skill builds — each flagged socket group's DPS per instance × count, share of total, from PoB's cached calc (free, no recompute, build untouched). Requires socket groups to have 'Include in Full DPS' checked and their Count field set to the real minion quantity (PoB does NOT auto-multiply by minion limit); the tool explains how when nothing is flagged. Use whenever a build's damage lives in minions or multiple skills — the main-skill DPS alone under-reports those builds.",
      inputSchema: { type: "object", properties: {} },
    },
    {
      name: "compute_stat_weights",
      description:
        "Measure the loaded build's empirical DPS/EHP sensitivity to individual stat mods (life, attributes, attack/cast speed, crit, flat damage, resists) via non-mutating PoB sims — the user's build is never modified. Returns per-unit weights that replace hand-curated intuition: feed them to find_weighted_trade_items and record them in build-profile.md Sections 3-4. Run at gear/crafting pre-flight and after respecs. Requires the probe_stat_weights PoB API action (reinstall TCP API if missing).",
      inputSchema: {
        type: "object",
        properties: {
          slot: {
            type: "string",
            description: "Carrier slot whose equipped item hosts the probe mods (default: first equipped of Ring 1/Ring 2/Amulet/Belt/Helmet/Boots/Gloves). Results are slot-independent for global mods.",
          },
          mods: {
            type: "array",
            items: { type: "string" },
            description: "Custom probe mod lines (exact PoB item mod text) to test instead of the standard 15-probe battery",
          },
        },
      },
    },
    {
      name: "compute_constraint_margins",
      description:
        "Fill the Current and Margin columns of a build-profile.md Constraint Status table (Section 6) from live PoB stats. Parses the markdown table, maps each Stat row to a PoB output field, computes margin vs the Threshold, and flags violated (🔴) or near-floor (⚠️) constraints. Rows with non-numeric thresholds ('present', 'build-specific') are marked for manual evaluation. Use at analysis pre-flight (playbooks/README.md §2d) instead of computing margins by hand.",
      inputSchema: {
        type: "object",
        properties: {
          profile_path: {
            type: "string",
            description: "Path to the build-profile.md file containing the '| Stat | Tier | Threshold | Current | Margin | Notes |' table",
          },
          write_back: {
            type: "boolean",
            description: "Write the recomputed Current/Margin columns back into the file (default: false = report only)",
          },
        },
        required: ["profile_path"],
      },
    },
    {
      name: "sync_character_cache",
      description:
        "Refresh a character_data/{Account}/{League}/{Character}/ cache from the loaded PoB build: updates meta.json current_stats (life, resists, DPS, EHP, etc.) and level, and refreshes inventory.json equipped/flask entries for slots whose item changed (curated fields on unchanged slots are preserved; jewels/eldritch implicits are never touched). Narrative files (build.md, journal.md) are never modified. Use dry_run=true to preview.",
      inputSchema: {
        type: "object",
        properties: {
          character_dir: {
            type: "string",
            description: "Path to the character directory containing meta.json / inventory.json",
          },
          targets: {
            type: "array",
            items: { type: "string", enum: ["meta", "inventory"] },
            description: "Which files to sync (default: both)",
          },
          dry_run: {
            type: "boolean",
            description: "Report what would change without writing files (default: false)",
          },
        },
        required: ["character_dir"],
      },
    },
    {
      name: "lua_get_tree",
      description: "Get passive tree allocation from currently loaded build",
      inputSchema: {
        type: "object",
        properties: {
          include_node_ids: {
            type: "boolean",
            description: "Include the full list of allocated node IDs in the response (default: false). Omit unless you need to pass node IDs to another tool.",
          },
        },
      },
    },
    {
      name: "lua_set_tree",
      description: "Set passive tree allocation (modifies currently loaded build). IMPORTANT: (1) All nodes must form a connected path from the class start node — any node not reachable through other allocated nodes back to the start will be silently dropped. Use find_path_to_node first to discover the intermediate travel nodes needed to reach your target. (2) Maximum 8 ascendancy points — do not allocate more than 8 ascendancy nodes (excluding the ascendancy start node).",
      inputSchema: {
        type: "object",
        properties: {
          nodes: {
            type: "array",
            items: { type: "string" },
            description: "Array of node IDs to allocate",
          },
          classId: {
            type: "number",
            description: "PoB2 class ID from lua_get_tree. Omit to preserve the current class; do not use PoE1 class IDs.",
          },
          ascendClassId: {
            type: "number",
            description: "PoB2 ascendancy ID from lua_get_tree. Omit to preserve the current ascendancy.",
          },
          weaponSets: {
            type: "object",
            additionalProperties: { type: "integer", enum: [0, 1, 2] },
            description: "PoB2 node ID to allocation mode: 0 common, 1 weapon set 1, 2 weapon set 2. Omit to preserve assignments; an empty object makes all requested nodes common.",
          },
          treeVersion: { type: "string", description: "PoB2 tree version from lua_get_tree, e.g. 0_5. Omit to preserve." },
        },
        required: ["nodes"],
      },
    },
    {
      name: "update_tree_delta",
      description: "Incrementally add or remove specific passive nodes from the current tree allocation. Automatically finds and includes intermediate path nodes when adding nodes that aren't directly adjacent to the current tree. Safer than lua_set_tree because you only specify the nodes to change, not the entire tree. Note: max 8 ascendancy points allowed.",
      inputSchema: {
        type: "object",
        properties: {
          add_nodes: {
            type: "array",
            items: { type: "string" },
            description: "Node IDs to add to the current allocation",
          },
          remove_nodes: {
            type: "array",
            items: { type: "string" },
            description: "Node IDs to remove from the current allocation",
          },
        },
      },
    },
    {
      name: "lua_get_build_info",
      description: poe2 ? "Get actual metadata from the loaded PoB2 build: name, character level, class, ascendancy and tree version. Pending native mode transitions return an error." : "Get metadata about the currently loaded build: name, character level, class, ascendancy, and tree version. Useful to confirm which build is active after lua_load_build or lua_new_build. Classes and ascendancies (PoE1): Scion: Ascendant | Marauder: Juggernaut, Berserker, Chieftain | Ranger: Raider, Deadeye, Pathfinder | Witch: Occultist, Elementalist, Necromancer | Duelist: Slayer, Gladiator, Champion | Templar: Inquisitor, Hierophant, Guardian | Shadow: Assassin, Trickster, Saboteur",
      inputSchema: {
        type: "object",
        properties: {},
      },
    },
    {
      name: "get_gem_detail",
      description: "Get authoritative data for any skill or support gem straight from Path of Building's own game data — tags, active-skill type, requirements, cast time, per-level stat scaling, and quality bonus. Sourced from PoB's data (patch-current, matches the in-game gem tooltip), NOT web scraping. Works with no build loaded (reads static game data). Handles base gems (\"Fireball\"), Vaal variants (\"Vaal Summon Skeletons\"), transfigured gems (\"Absolution of Inspiring\"), supports, and minion gems. The result lists the sibling variants that share the base — use an exact variant name from that list to fetch a specific transfigured/Vaal gem. Prefer this over poemcp's get_gem_detail.",
      inputSchema: {
        type: "object",
        properties: {
          gem_name: {
            type: "string",
            description: "Gem name. Exact base name (\"Raise Zombie\"), Vaal variant (\"Vaal Summon Skeletons\"), or transfigured full name (\"Absolution of Inspiring\"). Case-insensitive; must be an exact gem name (not a partial/fuzzy match).",
          },
          levels: {
            type: "array",
            items: { type: "number" },
            description: "Optional gem levels to report (1–max). Omit for the default selection of level 1, a mid level, and max.",
          },
        },
        required: ["gem_name"],
      },
    },
    {
      name: "lua_reload_build",
      description: "Reload the current build from disk, picking up any changes made in PoB GUI or via direct XML editing. If build_name is omitted, reloads the build that is currently loaded (determined via lua_get_build_info).",
      inputSchema: {
        type: "object",
        properties: {
          build_name: {
            type: "string",
            description: "Name of the build file to reload (e.g., 'MyBuild.xml'). If omitted, reloads the currently loaded build.",
          },
        },
      },
    },
    {
      name: "search_tree_nodes",
      description: "Search passive tree for nodes matching specific criteria",
      inputSchema: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description: "Search query for node names or stats",
          },
          node_type: {
            type: "string",
            description: "Filter by node type: 'keystone', 'notable', 'jewel', 'mastery', 'ascendancy', or 'normal' (small travel nodes). Omit to search all types.",
          },
          limit: {
            type: "number",
            description: "Maximum results to return (default: 20)",
          },
        },
        required: ["query"],
      },
    },
    {
      name: "add_item",
      description: "Add an item to the build from item text (paste from game)",
      inputSchema: {
        type: "object",
        properties: {
          item_text: {
            type: "string",
            description: "Full item text from clipboard",
          },
          slot_name: {
            type: "string",
            description: `Equipment slot to equip: ${equipmentSlots.join(", ")}`,
            enum: equipmentSlots,
          },
        },
        required: ["item_text", "slot_name"],
      },
    },
    {
      name: 'clear_item_slot',
      description: 'Remove (unequip) the item from a specific gear slot. Use this to clear a slot before equipping a replacement item, or to test the build without a specific item.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          slot_name: {
            type: 'string',
            description: `Equipment slot to clear: ${equipmentSlots.join(", ")}`,
            enum: equipmentSlots,
          },
        },
        required: ['slot_name'],
      },
    },
    {
      name: "get_equipped_items",
      description: "Get all currently equipped items (empty slots are omitted). Returns name, base, rarity, and all mod lines (implicit, explicit, crafted, enchant) for each equipped item. Use when you need to evaluate gear choices or read specific affixes.",
      inputSchema: {
        type: "object",
        properties: {},
      },
    },
    {
      name: "get_socket_colors",
      description: "Report the actual socket colours and link groups of each equipped item on the loaded build, read from PoB's item data. Per slot: the R/G/B/W/A layout (dash = linked), total sockets, the largest link, and colour counts. Use for colour-dependent items (Triad Grip, Tinkerskin, Prismatic gems) or to check off-colours — data that get_equipped_items and the PoE API character summary do NOT expose.",
      inputSchema: {
        type: "object",
        properties: {},
      },
    },
    {
      name: "toggle_flask",
      description: poe2
        ? "Activate or deactivate a PoE2 flask or charm. Provide exactly one selector: flask_number 1 (life) or 2 (mana), or slotName for a Flask or Charm slot."
        : "Toggle a flask on/off",
      inputSchema: {
        type: "object",
        properties: {
          flask_number: {
            type: "integer",
            minimum: 1,
            maximum: poe2 ? 2 : 5,
            description: poe2 ? "Flask slot number: 1 life, 2 mana. Omit when using slotName." : "Flask slot number (1-5)",
          },
          ...(poe2 ? { slotName: {
            type: "string",
            enum: ["Flask 1", "Flask 2", "Charm 1", "Charm 2", "Charm 3"],
            description: "Explicit PoB2 consumable slot. Omit flask_number when using slotName.",
          } } : {}),
          active: {
            type: "boolean",
            description: "true to activate, false to deactivate",
          },
        },
        required: poe2 ? ["active"] : ["flask_number", "active"],
        ...(poe2 ? { oneOf: [{ required: ["flask_number"] }, { required: ["slotName"] }] } : {}),
      },
    },
    {
      name: "get_skill_setup",
      description: "Get current skill gem setup. Default main_only=true shows only the main DPS socket group — use this first. Set main_only=false only if you need to see all utility/aura/movement groups too.",
      inputSchema: {
        type: "object",
        properties: {
          main_only: {
            type: "boolean",
            description: "Only show the main socket group (default: true). Set to false to see all socket groups.",
          },
        },
      },
    },
    {
      name: "set_main_skill",
      description: "Set which skill group is the main skill for DPS calculations",
      inputSchema: {
        type: "object",
        properties: {
          group_index: {
            type: "number",
            description: "Socket group index (1-based)",
          },
          active_skill_index: {
            type: "number",
            description: "Active skill index within group (1-based, optional). Selects which active skill in the group to use for DPS calculation — relevant when a group has multiple active skills.",
          },
          skill_part: { type: "integer", minimum: 1, description: "Skill part index (1-based, optional)." },
          ...(poe2 ? { stat_set: {
            type: "integer", minimum: 1,
            description: "PoE2 stat-set index within the selected active skill (1-based). Updates MAIN and CALCS selections; independent of skill_part.",
          } } : {}),
        },
        required: ["group_index"],
      },
    },
    {
      name: "create_socket_group",
      description: poe2 ? "Create a gem group in the active PoE2 skill set. To support an item-granted skill, create a separate support group in that equipment slot; generated groups are read-only." : "Create a new socket group for skill gems",
      inputSchema: {
        type: "object",
        properties: {
          label: {
            type: "string",
            description: "Label for the socket group (e.g., 'Main Skill', 'Auras')",
          },
          slot: {
            type: "string",
            description: "Item slot for sockets (e.g., 'Weapon 1', 'Body Armour')",
            enum: skillSlots,
          },
          enabled: {
            type: "boolean",
            description: "Whether group is enabled (default: true)",
          },
        },
        required: ["label"],
      },
    },
    {
      name: "add_gem",
      description: "Add a gem to a socket group. IMPORTANT: Use the gem's base name WITHOUT 'Support' suffix — e.g. 'Brutality' not 'Brutality Support', 'Concentrated Effect' not 'Concentrated Effect Support', 'Melee Physical Damage' not 'Melee Physical Damage Support'. The server will auto-resolve names but correct names ensure proper matching.",
      inputSchema: {
        type: "object",
        properties: {
          group_index: {
            type: "number",
            description: "Socket group index (1-based)",
          },
          gem_name: {
            type: "string",
            description: "Gem name WITHOUT 'Support' suffix (e.g. 'Brutality', 'Concentrated Effect', 'Multistrike')",
          },
          level: {
            type: "number",
            description: "Gem level (default: 20)",
          },
          quality: {
            type: "number",
            description: "Gem quality % (default: 0)",
          },
          enabled: {
            type: "boolean",
            description: "Whether gem is enabled (default: true)",
          },
        },
        required: ["group_index", "gem_name"],
      },
    },
    {
      name: "set_gem_level",
      description: "Set the level of a gem",
      inputSchema: {
        type: "object",
        properties: {
          group_index: {
            type: "number",
            description: "Socket group index (1-based)",
          },
          gem_index: {
            type: "number",
            description: "Gem index within group (1-based)",
          },
          level: {
            type: "number",
            description: "New gem level",
          },
        },
        required: ["group_index", "gem_index", "level"],
      },
    },
    {
      name: "set_gem_quality",
      description: "Set the quality of a gem",
      inputSchema: {
        type: "object",
        properties: {
          group_index: {
            type: "number",
            description: "Socket group index (1-based)",
          },
          gem_index: {
            type: "number",
            description: "Gem index within group (1-based)",
          },
          quality: {
            type: "number",
            description: "Quality percentage (0-23 for normal, up to 30+ for corrupted)",
          },
          quality_type: {
            type: "string",
            description: "Type: 'Default', 'Anomalous', 'Divergent', 'Phantasmal' (optional)",
          },
        },
        required: ["group_index", "gem_index", "quality"],
      },
    },
    {
      name: "remove_skill",
      description: "Remove an entire socket group",
      inputSchema: {
        type: "object",
        properties: {
          group_index: {
            type: "number",
            description: "Socket group index to remove (1-based)",
          },
        },
        required: ["group_index"],
      },
    },
    {
      name: "remove_gem",
      description: "Remove a specific gem from a socket group",
      inputSchema: {
        type: "object",
        properties: {
          group_index: {
            type: "number",
            description: "Socket group index (1-based)",
          },
          gem_index: {
            type: "number",
            description: "Gem index to remove (1-based)",
          },
        },
        required: ["group_index", "gem_index"],
      },
    },
    {
      name: "toggle_socket_group",
      description: "Enable or disable an entire socket group (e.g. turn off a mana reservation aura to test its effect on stats), and set its Full-DPS flags. For MINION or multi-skill builds, pass `include_in_full_dps: true` plus `count` (the real minion quantity, e.g. 20 raging spirits) so `minion_dps_breakdown` can report swarm DPS — PoB does NOT auto-multiply by the minion limit, and a group without the flag is absent from Full DPS entirely. The response reports what PoB actually stored.",
      inputSchema: {
        type: "object",
        properties: {
          group_index: {
            type: "number",
            description: "Socket group index (1-based)",
          },
          enabled: {
            type: "boolean",
            description: "true to enable the group, false to disable it",
          },
          include_in_full_dps: {
            type: "boolean",
            description: "Set the group's 'Include in Full DPS' flag. Required for a group to appear in minion_dps_breakdown. Omit to leave unchanged.",
          },
          count: {
            type: "number",
            description: "Number of active instances of this skill (e.g. 20 raging spirits, 10 zombies). PoB multiplies the group's DPS by this. Omit to leave unchanged.",
          },
        },
        required: ["group_index", "enabled"],
      },
    },
    {
      name: "list_spectres",
      description: poe2 ? "List the spectre selected per gem in the active PoE2 skill set, including group/gem indices and enabled state. Optionally search the installed spectre catalog." : "List the spectres set on the build (the 'raised' set PoB simulates for Raise Spectre), and optionally search PoB's full spectre library by name. IMPORTANT: character imports NEVER set spectres — the PoE API doesn't report them — so a build with none set simulates generic spectres and misses any player/ally buffs (e.g. Perfect Guardian Turtle's Determination aura). Spectre benefits are also greppable in reference_data/text_lake/spectres.txt (grants: column).",
      inputSchema: {
        type: "object",
        properties: {
          search: {
            type: "string",
            description: poe2 ? "Optional case-insensitive substring to search the installed PoE2 spectre catalog." : "Optional case-insensitive substring to search the spectre library (e.g. 'turtle', 'perfect')",
          },
        },
      },
    },
    {
      name: "set_spectres",
      description: poe2 ? "Select exactly one spectre per gem using group_index and gem_index from the active skill set. Pass one catalog name or metadata ID. Use separate gems/groups for different spectres. Updates that gem selection and the shared catalog, then recalculates." : "Set which spectres are 'raised' on the build — the GUI-only spectre picker, now scriptable. Accepts display names (fuzzy: exact id → exact name → unique substring, e.g. 'perfect guardian turtle') or monster metadata ids. Replaces the whole list by default; mode 'add' appends. Triggers a recalc, so player-affecting spectre auras (Determination, Onslaught, etc.) show up in stats immediately. Spectres persist across imports — set once, re-set only when the in-game zoo changes.",
      inputSchema: {
        type: "object",
        properties: {
          spectres: {
            type: "array",
            items: { type: "string" },
            ...(poe2 ? { minItems: 1, maxItems: 1 } : {}),
            description: poe2 ? "Exactly one PoE2 spectre name or metadata ID for this gem." : "Spectre names or metadata ids, e.g. ['Perfect Guardian Turtle', 'Perfect Forest Warrior']",
          },
          mode: {
            type: "string",
            enum: poe2 ? ["replace"] : ["replace", "add"],
            description: poe2 ? "replace selects the spectre for this gem (default)." : "'replace' (default) sets exactly this list; 'add' appends to the existing list",
          },
          ...(poe2 ? {
            group_index: { type: "integer", minimum: 1, description: "Group index in the active skill set (1-based)." },
            gem_index: { type: "integer", minimum: 1, description: "Spectre gem index within that group (1-based)." },
          } : {}),
        },
        required: poe2 ? ["spectres", "group_index", "gem_index"] : ["spectres"],
      },
    },
    {
      name: "toggle_gem",
      description: "Enable or disable a specific gem within a socket group",
      inputSchema: {
        type: "object",
        properties: {
          group_index: {
            type: "number",
            description: "Socket group index (1-based)",
          },
          gem_index: {
            type: "number",
            description: "Gem index within group (1-based)",
          },
          enabled: {
            type: "boolean",
            description: "true to enable the gem, false to disable it",
          },
        },
        required: ["group_index", "gem_index", "enabled"],
      },
    },
    {
      name: "setup_skill_with_gems",
      description: "Setup a complete skill with multiple support gems in one operation. Does NOT auto-set as main skill for DPS. Call set_main_skill with the returned group_index afterward if this should be the primary DPS skill.",
      inputSchema: {
        type: "object",
        properties: {
          label: {
            type: "string",
            description: "Label for skill group",
          },
          active_gem: {
            type: "string",
            description: "Active skill gem name",
          },
          support_gems: {
            type: "array",
            items: { type: "string" },
            description: "Array of support gem names",
          },
          slot: {
            type: "string",
            description: "Item slot (optional)",
            enum: skillSlots,
          },
        },
        required: ["label", "active_gem", "support_gems"],
      },
    },
    {
      name: "add_multiple_items",
      description: "Add multiple items at once (efficient bulk operation)",
      inputSchema: {
        type: "object",
        properties: {
          items: {
            type: "array",
            items: {
              type: "object",
              properties: {
                item_text: { type: "string" },
                slot_name: { type: "string" },
              },
              required: ["item_text", "slot_name"],
            },
            description: "Array of items to add",
          },
        },
        required: ["items"],
      },
    },
    {
      name: "suggest_masteries",
      description: "Analyze all allocated mastery nodes and suggest the best effect choices by simulating each option's DPS/EHP impact. Requires a build to be loaded via lua_load_build.",
      inputSchema: {
        type: "object",
        properties: {},
      },
    },
    {
      name: "plan_leveling",
      description: "Generate an act-by-act leveling progression guide for a build, including skill gem progression, lab timing, and passive tree priority order",
      inputSchema: {
        type: "object",
        properties: {
          build_name: { type: "string", description: "Build file to read class/skill from (optional if build loaded in Lua bridge)" },
          class_name: { type: "string", description: "Override class name (e.g. 'Witch', 'Ranger')" },
          main_skill: { type: "string", description: "Override main skill name" },
          ascendancy: { type: "string", description: "Override ascendancy name" },
        },
      },
    },
    {
      name: "find_item_upgrades",
      description: "Generate a shopping spec for a gear slot — describes what item type, base, and mods to look for based on the build's current gaps (resistances, life, ES, DPS). Works with a loaded build in the Lua bridge. No trade API required.",
      inputSchema: {
        type: "object",
        properties: {
          slot: {
            type: "string",
            description: "Gear slot to get a shopping spec for (e.g., 'Helmet', 'Body Armour', 'Boots', 'Gloves', 'Belt', 'Amulet', 'Ring 1', 'Ring 2', 'Weapon 1', 'Weapon 2')",
          },
          build_name: {
            type: "string",
            description: "Build file to analyze (optional if a build is loaded via lua_load_build)",
          },
          priority: {
            type: "string",
            description: "What to optimize for: 'dps', 'defense', 'resistance', or 'balanced' (default: 'balanced')",
            enum: ["dps", "defense", "resistance", "balanced"],
          },
        },
        required: ["slot"],
      },
    },
  ];
}

/**
 * Get optimization tool schemas
 */
export function getOptimizationToolSchemas(): any[] {
  return [
    {
      name: "analyze_defenses",
      description: "Deep-dive into defensive layers (avoidance/mitigation/recovery): EHP, spell suppression, evasion, block, armour/PDR, life regen, leech. Use this when you specifically want detailed defense breakdown. validate_build already covers this — only call analyze_defenses separately if you need more defensive detail than validate_build provides.",
      inputSchema: {
        type: "object",
        properties: {
          build_name: {
            type: "string",
            description: "Build to analyze",
          },
        },
        required: ["build_name"],
      },
    },
    {
      name: "suggest_optimal_nodes",
      description: "AI-powered suggestion of optimal passive nodes based on build goals",
      inputSchema: {
        type: "object",
        properties: {
          build_name: {
            type: "string",
            description: "Build to optimize",
          },
          goal: {
            type: "string",
            description: "Optimization goal: 'damage', 'defense', 'life', 'es', or stat name",
          },
          points_available: {
            type: "number",
            description: "Number of passive points to spend (default: 10)",
          },
        },
        required: ["build_name", "goal"],
      },
    },
    {
      name: "optimize_tree",
      description: "Full passive tree optimization - removes inefficient nodes and reallocates to better options",
      inputSchema: {
        type: "object",
        properties: {
          build_name: {
            type: "string",
            description: "Build to optimize",
          },
          goal: {
            type: "string",
            description: "Primary optimization goal: 'damage', 'defense', 'balanced'",
          },
          constraints: {
            type: "object",
            description: "Constraints like minimum life, required keystones, etc.",
          },
          preserve_keystones: {
            type: "boolean",
            description: "Whether to preserve allocated keystones (default: true)",
          },
        },
        required: ["build_name", "goal"],
      },
    },
    {
      name: "analyze_items",
      description: process.env.POE_GAME === "poe2" ? "Read selected PoE2 items, exact modifiers and measured constraints from live state or a requested XML file. Missing stats stay unknown. Candidate upgrade rankings require native comparisons and current prices." : "Analyze equipped items and suggest upgrades or improvements",
      inputSchema: {
        type: "object",
        properties: {
          build_name: {
            type: "string",
            description: "Build to analyze",
          },
        },
        required: process.env.POE_GAME === "poe2" ? [] : ["build_name"],
      },
    },
    {
      name: "optimize_skill_links",
      description: "Analyze skill gem setups for 'more' multipliers, penetration, and support gem synergies. Flags missing multiplicative damage supports and suggests clear-speed vs bossing balance.",
      inputSchema: {
        type: "object",
        properties: {
          build_name: {
            type: "string",
            description: "Build to analyze",
          },
        },
        required: ["build_name"],
      },
    },
    {
      name: "create_budget_build",
      description: "Create a league-start/budget-friendly version of a build",
      inputSchema: {
        type: "object",
        properties: {
          build_name: {
            type: "string",
            description: "Build to create budget version of",
          },
          budget_tier: {
            type: "string",
            description: "Budget tier: 'league-start', 'low', 'medium' (default: league-start)",
          },
        },
        required: ["build_name"],
      },
    },
  ];
}

/**
 * Get configuration tool schemas (Phase 9)
 */
export function getConfigToolSchemas(): any[] {
  const poe2 = process.env.POE_GAME === "poe2";
  return [
    {
      name: "get_config",
      description: poe2 ? "Read the selected native PoB2 config set, effective enemy level and raw inputs. Initialized flags do not establish applicability or uptime. Requires a live build." : "View current configuration state including charge usage, enemy settings, and active conditions. Requires Lua bridge with a loaded build.",
      inputSchema: {
        type: "object",
        properties: {},
      },
    },
    {
      name: "set_config",
      description: "Apply explicit native configuration inputs and verify stored values in the same selected config set. Provide a flat config object or one config_name/value pair. Unknown native options are rejected before writes. PoE2 rejects Bandit/Pantheon fields. Read get_config for actual inputs and effective values.",
      inputSchema: {
        type: "object",
        properties: {
          config_name: { type: "string", description: "Exact native ConfigOptions variable, e.g. enemyLevel." },
          value: { type: ["boolean", "number", "string"], description: "Explicit value for config_name." },
          config: { type: "object", minProperties: 1, additionalProperties: {type: ["boolean", "number", "string"]}, description: "Flat batch of explicit native inputs. Unlisted inputs are retained." },
        },
        oneOf: [{required:["config_name","value"]},{required:["config"]}],
      },
    },
    {
      name: "set_pob_view",
      description: "Switch the visible tab in the live Path of Building GUI (TCP mode) so a human can watch what you're changing in real time. Modes: TREE, SKILLS, ITEMS, CALCS, CONFIG, NOTES, IMPORT, PARTY, COMPARE. Mutating tools already auto-switch to the relevant tab before they run (import→TREE, gem edits→SKILLS, item edits→ITEMS); use this for explicit control. No visible effect in headless mode.",
      inputSchema: {
        type: "object",
        properties: {
          mode: {
            type: "string",
            enum: ["TREE", "SKILLS", "ITEMS", "CALCS", "CONFIG", "NOTES", "IMPORT", "PARTY", "COMPARE"],
            description: "The PoB tab to display.",
          },
        },
        required: ["mode"],
      },
    },
    {
      name: "set_enemy_stats",
      description: "Apply only the supplied enemy parameters to the native config and verify readback. Omitted fields remain unchanged; zero resistances are explicit valid values. Effective enemy level can differ from the stored override.",
      inputSchema: {
        type: "object",
        properties: {
          level: {
            type: "number",
            description: "Explicit enemy level override",
          },
          fire_resist: {
            type: "number",
            description: "Explicit fire resistance %",
          },
          cold_resist: {
            type: "number",
            description: "Explicit cold resistance %",
          },
          lightning_resist: {
            type: "number",
            description: "Explicit lightning resistance %",
          },
          chaos_resist: {
            type: "number",
            description: "Explicit chaos resistance %",
          },
          armor: {
            type: "number",
            description: "Enemy armor value",
          },
          evasion: {
            type: "number",
            description: "Enemy evasion value",
          },
        },
      },
    },
    {
      name: "save_config_preset",
      description: "Save the selected config with game provenance. PoE2 presets contain explicit XML input overrides and do not copy initialized defaults.",
      inputSchema: {
        type: "object",
        properties: {
          name: {
            type: "string",
            description: "Preset name (e.g. 'bossing', 'mapping', 'full-charges')",
          },
        },
        required: ["name"],
      },
    },
    {
      name: "load_config_preset",
      description: "Apply a saved preset for the current game as an explicit input patch. Unlisted inputs remain unchanged; cross-game presets are rejected.",
      inputSchema: {
        type: "object",
        properties: {
          name: {
            type: "string",
            description: "Preset name to load",
          },
        },
        required: ["name"],
      },
    },
    {
      name: "list_config_presets",
      description: "List saved presets belonging to the current game.",
      inputSchema: {
        type: "object",
        properties: {},
      },
    },
  ];
}

/**
 * Get build validation tool schemas (Phase 7)
 */
export function getValidationToolSchemas(): any[] {
  return [
    {
      name: "validate_build",
      description: "Comprehensive build validation: resistances, life pool, defensive layers (avoidance/mitigation/recovery), mana sustain, accuracy, flask immunities, damage scaling. Provides prioritized critical/warning/info recommendations. PREFER this over get_build_issues + analyze_defenses — it covers both in one call. Do not call all three.",
      inputSchema: {
        type: "object",
        properties: {
          build_name: {
            type: "string",
            description: "Build to validate. If omitted and Lua bridge is active, validates currently loaded build.",
          },
        },
      },
    },
  ];
}

/**
 * Get skill gem analysis tool schemas (Phase 11)
 */
export function getSkillGemToolSchemas(): any[] {
  return [
    {
      name: "analyze_skill_links",
      description: "Analyze skill gem setup and evaluate support gem choices. Detects build archetype, rates each support gem, and identifies issues with current setup.",
      inputSchema: {
        type: "object",
        properties: {
          build_name: {
            type: "string",
            description: "Build to analyze",
          },
          skill_index: {
            type: "number",
            description: "Which skill to analyze (0 = main skill, default: 0)",
          },
        },
        required: ["build_name"],
      },
    },
    {
      name: "suggest_support_gems",
      description: "Get intelligent support gem recommendations based on build archetype. Provides ranked suggestions with DPS estimates, cost, and reasoning.",
      inputSchema: {
        type: "object",
        properties: {
          build_name: {
            type: "string",
            description: "Build to analyze",
          },
          skill_index: {
            type: "number",
            description: "Which skill to optimize (0 = main skill, default: 0)",
          },
          count: {
            type: "number",
            description: "Number of suggestions to return (default: 5)",
          },
          include_exceptional: {
            type: "boolean",
            description: "Include Exceptional gem recommendations (default: true)",
          },
          budget: {
            type: "string",
            description: "Budget tier: 'league_start', 'mid_league', or 'endgame' (default: 'endgame')",
          },
        },
        required: ["build_name"],
      },
    },
    {
      name: "compare_gem_setups",
      description: "Compare multiple gem configurations side-by-side to evaluate different options. NOTE: Full DPS comparison requires Lua bridge integration (future enhancement).",
      inputSchema: {
        type: "object",
        properties: {
          build_name: {
            type: "string",
            description: "Build to test",
          },
          skill_index: {
            type: "number",
            description: "Which skill to test (default: 0)",
          },
          setups: {
            type: "array",
            items: {
              type: "object",
              properties: {
                name: { type: "string" },
                gems: {
                  type: "array",
                  items: { type: "string" },
                },
              },
              required: ["name", "gems"],
            },
            description: "Array of gem setups to compare (minimum 2)",
          },
        },
        required: ["build_name", "setups"],
      },
    },
    {
      name: "validate_gem_quality",
      description: "Check all gems for quality and level improvements. Identifies missing quality, Exceptional upgrade opportunities, and corruption targets.",
      inputSchema: {
        type: "object",
        properties: {
          build_name: {
            type: "string",
            description: "Build to validate",
          },
          include_corrupted: {
            type: "boolean",
            description: "Include corruption recommendations for 21/23 gems (default: true)",
          },
        },
        required: ["build_name"],
      },
    },
    {
      name: "find_optimal_links",
      description: "Auto-generate the best support gem combination for a skill based on budget and optimization goal. Provides step-by-step upgrade path.",
      inputSchema: {
        type: "object",
        properties: {
          build_name: {
            type: "string",
            description: "Build to optimize",
          },
          skill_index: {
            type: "number",
            description: "Which skill to optimize (default: 0)",
          },
          link_count: {
            type: "number",
            description: "Number of links (4, 5, or 6)",
          },
          budget: {
            type: "string",
            description: "Budget tier: 'league_start', 'mid_league', or 'endgame' (default: 'endgame')",
          },
          optimize_for: {
            type: "string",
            description: "Optimization target: 'dps', 'clear_speed', 'bossing', or 'defense' (default: 'dps')",
          },
        },
        required: ["build_name", "link_count"],
      },
    },
    {
      name: "gem_upgrade_path",
      description: "Generate a prioritized gem upgrade shopping list showing which gems to level, quality, and upgrade to Exceptional versions, ordered by impact and budget",
      inputSchema: {
        type: "object",
        properties: {
          build_name: {
            type: "string",
            description: "Build file (optional if loaded in Lua bridge)",
          },
          budget: {
            type: "string",
            description: "Budget tier: 'league_start', 'mid_league', 'endgame' (default: endgame)",
          },
        },
      },
    },
  ];
}

/**
 * Get export and persistence tool schemas (Phase 8)
 */
export function getExportToolSchemas(): any[] {
  return [
    {
      name: "export_build",
      description: "Export a copy of a build to an XML file. Creates a variant/copy from an existing build file. NOTE: This does NOT export from Lua bridge - use save_tree to apply Lua bridge modifications back to files.",
      inputSchema: {
        type: "object",
        properties: {
          build_name: {
            type: "string",
            description: "Source build filename (e.g., 'MyBuild.xml')",
          },
          output_name: {
            type: "string",
            description: "Output filename (without .xml extension)",
          },
          output_directory: {
            type: "string",
            description: "Target directory (optional, defaults to POB_DIRECTORY/.pob-mcp/exports)",
          },
          overwrite: {
            type: "boolean",
            description: "Allow overwriting existing file (default: false)",
          },
          notes: {
            type: "string",
            description: "Additional notes to append to build notes",
          },
        },
        required: ["build_name", "output_name"],
      },
    },
    {
      name: "save_tree",
      description: "Update only the passive tree in an existing build file. Use this to apply tree optimizations or Lua bridge modifications back to the original build.",
      inputSchema: {
        type: "object",
        properties: {
          build_name: {
            type: "string",
            description: "Target build filename to update",
          },
          nodes: {
            type: "array",
            items: { type: "string" },
            description: "Array of node IDs to allocate",
          },
          mastery_effects: {
            type: "object",
            description: "Mastery selections as object mapping node ID to effect ID (optional)",
          },
          backup: {
            type: "boolean",
            description: "Create backup before modifying (default: true)",
          },
        },
        required: ["build_name", "nodes"],
      },
    },
    {
      name: "snapshot_build",
      description: "Create a versioned snapshot of a build for easy rollback. Snapshots are stored separately with metadata tracking stats and changes.",
      inputSchema: {
        type: "object",
        properties: {
          build_name: {
            type: "string",
            description: "Build to snapshot",
          },
          description: {
            type: "string",
            description: "Description of this snapshot (optional)",
          },
          tag: {
            type: "string",
            description: "User-friendly tag (e.g., 'before-respec', 'league-start') (optional)",
          },
        },
        required: ["build_name"],
      },
    },
    {
      name: "list_snapshots",
      description: "List all snapshots for a build with metadata and stats",
      inputSchema: {
        type: "object",
        properties: {
          build_name: {
            type: "string",
            description: "Build to list snapshots for",
          },
          limit: {
            type: "number",
            description: "Maximum number of snapshots to return (optional)",
          },
          tag_filter: {
            type: "string",
            description: "Filter by tag (optional)",
          },
        },
        required: ["build_name"],
      },
    },
    {
      name: "restore_snapshot",
      description: "Restore a build from a snapshot. Optionally creates a backup of current state before restoring.",
      inputSchema: {
        type: "object",
        properties: {
          build_name: {
            type: "string",
            description: "Build to restore",
          },
          snapshot_id: {
            type: "string",
            description: "Snapshot ID (timestamp) or tag to restore from",
          },
          backup_current: {
            type: "boolean",
            description: "Create snapshot of current state before restore (default: true)",
          },
        },
        required: ["build_name", "snapshot_id"],
      },
    },
    {
      name: "export_build_summary",
      description: "Generate a clean markdown summary of the loaded build suitable for sharing on Reddit, Discord, or as build documentation",
      inputSchema: {
        type: "object",
        properties: {},
      },
    },
  ];
}

/**
 * Get Trade API tool schemas (require POE_TRADE_ENABLED=true)
 */
export function getTradeToolSchemas(): any[] {
  return [
    {
      name: "search_trade_items",
      description: "⚠️ GGG TOS (confirm once per session): hits pathofexile.com/api/trade — GGG's ToS section 7c restricts automated API access; account bans are possible. Warn user and get explicit confirmation the first time this is called in a session. Search the Path of Exile trade site for items with filters. Returns a clickable trade URL and total listing count — does NOT fetch listing details (ExileExchange pattern, per legal_considerations.md TOS section). User opens the URL to browse results. REQUIRES: POE_TRADE_ENABLED environment variable set to true.",
      inputSchema: {
        type: "object",
        properties: {
          league: {
            type: "string",
            description: "EXACT league name as specified by user (e.g., 'Standard', 'Settlers', 'Keepers', 'Hardcore'). Use get_leagues to see available leagues. Do not substitute or change the league name.",
          },
          item_name: {
            type: "string",
            description: "Specific item name to search for (e.g., 'Headhunter', 'Taste of Hate')",
          },
          item_type: {
            type: "string",
            description: "Base item type (e.g., 'Corsair Sword', 'Astral Plate')",
          },
          min_price: {
            type: "number",
            description: "Minimum price in the specified currency",
          },
          max_price: {
            type: "number",
            description: "Maximum price in the specified currency",
          },
          price_currency: {
            type: "string",
            description: "Currency for price filter (default: 'chaos'). Options: 'chaos', 'divine', 'exalted'",
          },
          item_rarity: {
            type: "string",
            description: "Item rarity filter: 'unique', 'rare', 'magic', 'normal'",
          },
          min_links: {
            type: "number",
            description: "Minimum number of links (for weapons/armor)",
          },
          corrupted: {
            type: "boolean",
            description: "Filter by corruption status (true/false/undefined for any)",
          },
          identified: {
            type: "boolean",
            description: "Filter by identification status",
          },
          online_status: {
            type: "string",
            enum: ["available", "online", "onlineleague", "securable", "any"],
            description: "Online-status filter (default: 'available'). Use 'securable' to restrict to instant-buyout listings from currently-online sellers (i.e. a click-and-buy result).",
          },
          mods: {
            type: "array",
            items: {
              type: "object",
              properties: {
                stat_id: { type: "string" },
                min: { type: "number" },
                max: { type: "number" },
              },
              required: ["stat_id"],
            },
            description: "List of stat filters with min/max values",
          },
          limit: {
            type: "number",
            description: "Maximum results (default: 5, max: 10)",
          },
        },
        required: ["league"],
      },
    },
    {
      name: "find_weighted_trade_items",
      description: "⚠️ GGG TOS (confirm once per session): hits pathofexile.com/api/trade. Warn user and get explicit confirmation the first time this is called in a session. Find best-in-slot trade items for the LOADED PoB build using PoB's TradeQueryGenerator weighted-search engine. Returns a clickable trade URL and total count — does NOT fetch listing details (ExileExchange pattern, per legal_considerations.md TOS section). User opens URL to browse results. Requires a build to be loaded first. REQUIRES: POE_TRADE_ENABLED=true and POB_LUA_ENABLED=true.",
      inputSchema: {
        type: "object",
        properties: {
          league: {
            type: "string",
            description: "EXACT league name as specified by user (e.g., 'Standard', 'Settlers'). Use get_leagues to see available leagues.",
          },
          slot: {
            type: "string",
            description: "Equipment slot to search BIS for. Examples: 'Belt', 'Helmet', 'Body Armour', 'Gloves', 'Boots', 'Amulet', 'Ring 1', 'Ring 2', 'Weapon 1', 'Weapon 2', 'Helmet Abyssal Socket #1'. Must match PoB's slot naming.",
          },
          options: {
            type: "object",
            description: "Pass-through options forwarded to PoB's TradeQueryGenerator:StartQuery. Optional fields: statWeights (overrides build's default sort list), influence1/influence2 (1=None), jewelType ('Any'|'Base'|'Abyss'), includeMirrored, includeCorrupted, includeScourge, includeEldritch, includeSynthesis, maxPrice, maxPriceType, maxLevel, sockets, links, special{itemName} (e.g. 'Megalomaniac'). When omitted, uses the loaded build's defaults.",
          },
          limit: {
            type: "number",
            description: "Maximum results to fetch full details for (default: 5, max: 10). Total search match count is always returned.",
          },
        },
        required: ["league", "slot"],
      },
    },
    {
      name: "get_item_price",
      description: "Quick price check for a specific item by name. Returns current market price and recent sales. REQUIRES: POE_TRADE_ENABLED environment variable set to true. IMPORTANT: Use the EXACT league name the user specifies.",
      inputSchema: {
        type: "object",
        properties: {
          item_name: {
            type: "string",
            description: "Name of the item to price check",
          },
          league: {
            type: "string",
            description: "EXACT league name as specified by user",
          },
          item_type: {
            type: "string",
            description: "Item base type for more accurate results (optional)",
          },
          rarity: {
            type: "string",
            description: "Item rarity: 'unique', 'rare', 'magic', 'normal' (optional)",
            enum: ["unique", "rare", "magic", "normal"],
          },
        },
        required: ["item_name"],
      },
    },
    {
      name: "get_leagues",
      description: "Get list of currently active Path of Exile leagues. Use this to find the correct league name before searching trade or prices. REQUIRES: POE_TRADE_ENABLED environment variable set to true.",
      inputSchema: {
        type: "object",
        properties: {},
      },
    },
    {
      name: "get_active_leagues",
      description: "Status snapshot of PoE leagues from the suite's perspective. Calls the trade-leagues API, then cross-references against the POE_LEAGUE env var (the suite's default league for trade/ninja queries when no explicit league is given). Reports: current temp/challenge leagues with their parent-league mapping (where characters move when the league ends), the current set of permanent leagues, and a warning if POE_LEAGUE points to a league that's no longer active (signal that a league ended and the env var is stale). Pairs with `playbooks/league-transition.md` for the migration checklist. REQUIRES: POE_TRADE_ENABLED=true.",
      inputSchema: {
        type: "object",
        properties: {},
      },
    },
    {
      name: "search_stats",
      description: "Search for item stat/mod IDs to use in trade searches. Use this to find the correct stat_id values for mods you want to filter by. REQUIRES: POE_TRADE_ENABLED environment variable set to true.",
      inputSchema: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description: "Search query for stat names (e.g., 'life', 'fire resistance')",
          },
          limit: {
            type: "number",
            description: "Maximum results to return (default: 10)",
          },
        },
        required: ["query"],
      },
    },
    {
      name: "compare_trade_items",
      description: "Compare two trade items side by side with DPS/defense calculations. REQUIRES: POE_TRADE_ENABLED environment variable set to true.",
      inputSchema: {
        type: "object",
        properties: {
          item1_name: {
            type: "string",
            description: "First item name to compare",
          },
          item2_name: {
            type: "string",
            description: "Second item name to compare",
          },
          league: {
            type: "string",
            description: "EXACT league name as specified by user",
          },
          slot: {
            type: "string",
            description: "Gear slot for context-aware comparison",
          },
        },
        required: ["item1_name", "item2_name", "league"],
      },
    },
    {
      name: "search_cluster_jewels",
      description: "Search for cluster jewels with specific enchants and notables. REQUIRES: POE_TRADE_ENABLED environment variable set to true.",
      inputSchema: {
        type: "object",
        properties: {
          league: {
            type: "string",
            description: "EXACT league name as specified by user",
          },
          jewel_size: {
            type: "string",
            description: "Cluster jewel size: 'large', 'medium', or 'small'",
            enum: ["large", "medium", "small"],
          },
          enchant: {
            type: "string",
            description: "Enchant modifier name (e.g., 'Added Small Passive Skills grant: 10% increased Fire Damage')",
          },
          notables: {
            type: "array",
            items: { type: "string" },
            description: "Notable passives to search for (e.g., ['Doryani\\'s Lesson', 'Prismatic Heart'])",
          },
          max_price: {
            type: "number",
            description: "Maximum price in Chaos Orbs",
          },
          limit: {
            type: "number",
            description: "Maximum results to return (default: 5)",
          },
        },
        required: ["league", "jewel_size"],
      },
    },
    {
      name: "generate_shopping_list",
      description: "Generate a prioritized shopping list of items to upgrade for a build within a budget. REQUIRES: POE_TRADE_ENABLED environment variable set to true.",
      inputSchema: {
        type: "object",
        properties: {
          build_name: {
            type: "string",
            description: "Build to generate shopping list for",
          },
          league: {
            type: "string",
            description: "EXACT league name as specified by user",
          },
          budget: {
            type: "number",
            description: "Total budget in Chaos Orbs",
          },
          budget_tier: {
            type: "string",
            description: "Budget tier for recommendations (default: 'medium')",
            enum: ["budget", "medium", "endgame"],
          },
        },
        required: ["build_name", "league"],
      },
    },
  ];
}

/**
 * Get build goals/diagnostics tool schemas (require Lua bridge, no Trade API dependency)
 */
export function getBuildGoalsToolSchemas(): any[] {
  return [
    {
      name: "get_build_issues",
      description: "Quick PoE2 issue scan using the live build XML and selected native outputs: configured resistance deficits, actual skill resource costs, Spirit reservation, attribute requirements and passive spending. Includes Life, ES, Mana, Spirit and Ward. Missing data and unassessed gear/socket completeness stay unknown; this is not a full viability assessment. Already included by lua_load_build. Explicit POE_GAME=poe1 retains the legacy scan.",
      inputSchema: {
        type: "object",
        properties: {},
      },
    },
    {
      name: "get_passive_upgrades",
      description: "Find the best unallocated notable passives to pick up next, ranked by their actual stat impact. Uses calcWith to simulate each candidate and scores by relative DPS/EHP gain.",
      inputSchema: {
        type: "object",
        properties: {
          focus: {
            type: "string",
            description: "What to optimize for (default: 'both')",
            enum: ["dps", "defence", "both"],
          },
          max_results: {
            type: "number",
            description: "Maximum number of upgrade suggestions to return (default: 10)",
          },
        },
      },
    },
    {
      name: "find_best_anointment",
      description: "Rank the best anointable notables for the loaded build by simulating the impact of each anoint via PoB's MiscCalculator (non-destructive, same engine the GUI uses to sort anoints in the item picker). Iterates ALL anointable notables across the tree (~400) — not a keyword-filtered subset. Requires an anointable item equipped in the target slot: any Amulet, or a Cord Belt for the Belt slot.",
      inputSchema: {
        type: "object",
        properties: {
          slot: {
            type: "string",
            description: "Slot of the anointable item: 'Amulet' or 'Belt' (Belt only works if a Cord Belt is equipped).",
          },
          focus: {
            type: "string",
            description: "What to optimize for (default: 'both'). 'dps' = pure DPS impact, 'defence' = pure EHP impact, 'both' = combined (DPS weight 1.0, EHP weight 0.5 — matches PoB's TradeQueryGenerator defaults).",
            enum: ["dps", "defence", "both"],
          },
          max_results: {
            type: "number",
            description: "Maximum number of anoint candidates to return (default: 10).",
          },
        },
        required: ["slot"],
      },
    },
    {
      name: "analyze_build_cluster_jewels",
      description: "Analyze the cluster jewels currently equipped in the build, evaluate which notables synergize with the build archetype, and flag wasted notables",
      inputSchema: {
        type: "object",
        properties: {},
      },
    },
    {
      name: "suggest_watchers_eye",
      description: "Recommend valuable Watcher's Eye jewel mods based on the build's active auras, ranked by tier (S/A/B) with best combo suggestions",
      inputSchema: {
        type: "object",
        properties: {},
      },
    },
    {
      name: "check_boss_readiness",
      description: "Check if the loaded build meets the recommended thresholds for a specific endgame boss (Shaper, Elder, Sirus, Maven, Uber Elder, Eater of Worlds, Searing Exarch)",
      inputSchema: {
        type: "object",
        properties: {
          boss: {
            type: "string",
            description: "Boss name: 'shaper', 'elder', 'sirus', 'maven', 'uber_elder', 'eater', 'exarch', or 'pinnacle' for generic endgame",
          },
        },
        required: ["boss"],
      },
    },
    {
      name: "suggest_crafting",
      description: "Recommend the best crafting method for an item. Provide a gear slot and optionally a base type and desired mods. If a build is loaded, auto-detects the equipped base and build gaps.",
      inputSchema: {
        type: "object",
        properties: {
          slot: {
            type: "string",
            description: "Gear slot: helmet, chest, gloves, boots, weapon, offhand, ring, amulet, belt",
            enum: ["helmet", "chest", "gloves", "boots", "weapon", "offhand", "ring", "amulet", "belt"],
          },
          base: {
            type: "string",
            description: "Base item type (e.g. 'Hubris Circlet'). Auto-detected from equipped item if a build is loaded.",
          },
          desired_mods: {
            type: "array",
            items: { type: "string" },
            description: "List of desired mod descriptions (e.g. ['maximum life', 'cold resistance', 'spell damage'])",
          },
          budget: {
            type: "string",
            enum: ["low", "medium", "high"],
            description: "Crafting budget: low (<50c), medium (50-500c), high (500c+)",
          },
          ilvl: {
            type: "number",
            description: "Item level — determines which mod tiers are reachable. 84+ for top tiers on most bases.",
          },
          league: {
            type: "string",
            description: "League name for currency prices (default: Standard)",
          },
        },
        required: ["slot"],
      },
    },
  ];
}

/**
 * Get poe.ninja API tool schemas
 */
export function getPoeNinjaToolSchemas(): any[] {
  return [
    {
      name: "get_currency_rates",
      description: "Get current currency exchange rates from poe.ninja. Returns real-time market prices for all currencies in Chaos Orb equivalent. Updated every 5 minutes from live trading data. IMPORTANT: Use the EXACT league name the user specifies - do not substitute or guess.",
      inputSchema: {
        type: "object",
        properties: {
          league: {
            type: "string",
            description: "EXACT league name as specified by user (e.g., 'Standard', 'Settlers', 'Keepers', 'Hardcore'). Do not substitute or change this value.",
          },
        },
        required: ["league"],
      },
    },
    {
      name: "find_arbitrage",
      description: "Find currency arbitrage opportunities - profitable trading loops where you can trade currencies in a circle and end up with more than you started. Uses real-time poe.ninja rates to identify market inefficiencies. Perfect for making passive income through currency trading. IMPORTANT: Use the EXACT league name the user specifies - do not substitute or guess.",
      inputSchema: {
        type: "object",
        properties: {
          league: {
            type: "string",
            description: "EXACT league name as specified by user (e.g., 'Standard', 'Settlers', 'Keepers', 'Hardcore'). Do not substitute or change this value.",
          },
          min_profit_percent: {
            type: "number",
            description: "Minimum profit percentage to show (default: 1.0). Lower values find more opportunities but with smaller profits.",
          },
        },
        required: ["league"],
      },
    },
    {
      name: "calculate_trading_profit",
      description: "Calculate the profit/loss from a specific trading chain. Useful for testing your own trading strategies or validating arbitrage opportunities before executing them. Shows step-by-step conversion rates. IMPORTANT: Use the EXACT league name the user specifies - do not substitute or guess.",
      inputSchema: {
        type: "object",
        properties: {
          league: {
            type: "string",
            description: "EXACT league name as specified by user (e.g., 'Standard', 'Settlers', 'Keepers', 'Hardcore'). Do not substitute or change this value.",
          },
          currency_chain: {
            type: "array",
            description: "Array of currency names in trading order (e.g., ['Divine Orb', 'Chaos Orb', 'Exalted Orb', 'Divine Orb'])",
            items: {
              type: "string",
            },
          },
          start_amount: {
            type: "number",
            description: "Amount of first currency to start with (default: 1)",
          },
        },
        required: ["league", "currency_chain"],
      },
    },
  ];
}
