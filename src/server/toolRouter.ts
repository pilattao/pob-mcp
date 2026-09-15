/**
 * Tool Routing Module
 *
 * Routes MCP tool calls to their corresponding handlers with proper context.
 */

import type { OptimizationConstraints } from "../types/optimization.js";
import { getToolSchemas, getLuaToolSchemas, getOptimizationToolSchemas } from "./toolSchemas.js";
import type { ToolGate } from "./toolGate.js";
import type { ContextBuilder } from "../utils/contextBuilder.js";
import type { TradeApiClient } from "../services/tradeClient.js";
import type { StatMapper } from "../services/statMapper.js";
import type { ItemRecommendationEngine } from "../services/itemRecommendationEngine.js";
import type { PoeNinjaClient } from "../services/poeNinjaClient.js";

// Import handlers
import { handleListBuilds, handleAnalyzeBuild, handleCompareBuilds, handleGetBuildStats, handleGetBuildNotes, handleSetBuildNotes } from "../handlers/buildHandlers.js";
import { handleStartWatching, handleStopWatching, handleGetRecentChanges, handleWatchStatus, handleRefreshTreeData } from "../handlers/watchHandlers.js";
import { handleCompareTrees, handleGetNearbyNodes, handleFindPath, handlePlanTreePaths, handleGetPassiveUpgrades, handleSuggestMasteries, handleGetNodePower } from "../handlers/treeHandlers.js";
import { handleFindBestAnointment } from "../handlers/anointHandlers.js";
import { handleGetBuildIssues, formatIssuesResponse } from "../handlers/buildGoalsHandlers.js";
import { handleLuaStart, handleLuaStop, handleLuaCloseBuild, handleLuaNewBuild, handleLuaSaveBuild, handleLuaLoadBuild, handleLuaGetStats, handleLuaGetTree, handleLuaSetTree, handleSearchTreeNodes, handleLuaGetBuildInfo, handleGetGemDetail, handleLuaReloadBuild, handleUpdateTreeDelta, handleCreateSpec, handleListSpecs, handleSelectSpec, handleDeleteSpec, handleRenameSpec, handleListItemSets, handleSelectItemSet, handleCreateItemSet } from "../handlers/luaHandlers.js";
import { handleListCharacters, handleImportCharacter, handleImportPobb, handleSharePobb } from "../handlers/importHandlers.js";
import { handleGetContextUsage } from "../handlers/contextHandlers.js";
import { handleComputeConstraintMargins, handleSyncCharacterCache } from "../handlers/characterDataHandlers.js";
import { handleComputeStatWeights } from "../handlers/statWeightsHandler.js";
import { handleMinionDpsBreakdown } from "../handlers/minionDpsBreakdownHandler.js";
import { handleAddItem, handleClearItemSlot, handleGetEquippedItems, handleGetSocketColors, handleToggleFlask, handleGetSkillSetup, handleSetMainSkill, handleCreateSocketGroup, handleAddGem, handleSetGemLevel, handleSetGemQuality, handleRemoveSkill, handleRemoveGem, handleSetupSkillWithGems, handleAddMultipleItems, handleSetSocketGroupEnabled, handleSetGemEnabled, handleListSpectres, handleSetSpectres } from "../handlers/itemSkillHandlers.js";
import { handleAnalyzeDefenses, handleSuggestOptimalNodes, handleOptimizeTree } from "../handlers/optimizationHandlers.js";
import { handleAnalyzeItems, handleOptimizeSkillLinks, handleCreateBudgetBuild } from "../handlers/advancedOptimizationHandlers.js";
import { handleGetConfig, handleSetConfig, handleSetPobView, handleSetEnemyStats, handleSaveConfigPreset, handleLoadConfigPreset, handleListConfigPresets } from "../handlers/configHandlers.js";
import { PoBLuaTcpClient } from "../pobLuaBridge.js";
import { handleValidateBuild } from "../handlers/validationHandlers.js";
import { handleExportBuild, handleSaveTree, handleSnapshotBuild, handleListSnapshots, handleRestoreSnapshot, handleExportBuildSummary } from "../handlers/exportHandlers.js";
import { handleAnalyzeSkillLinks, handleSuggestSupportGems, handleCompareGemSetups, handleValidateGemQuality, handleFindOptimalLinks, handleGemUpgradePath } from "../handlers/skillGemHandlers.js";
import { handleSearchTradeItems, handleGetItemPrice, handleGetLeagues, handleSearchStats, handleFindItemUpgrades, handleFindResistanceGear, handleCompareTradeItems, handleFindWeightedTradeItems } from "../handlers/tradeHandlers.js";
import { handleGetCurrencyRates, handleFindArbitrage, handleCalculateTradingProfit } from "../handlers/poeNinjaHandlers.js";
import { handleSearchClusterJewels, handleAnalyzeClusterJewels, handleAnalyzeBuildClusterJewels } from "../handlers/clusterJewelHandlers.js";
import { handleGenerateShoppingList } from "../handlers/shoppingListHandlers.js";
import { handlePlanLeveling } from "../handlers/levelingHandlers.js";
import { handleCheckBossReadiness } from "../handlers/bossReadinessHandlers.js";
import { handleSuggestWatchersEye } from "../handlers/jewelAdvisorHandlers.js";
import { handleSuggestCrafting } from "../handlers/craftingAdvisorHandler.js";
import { handleFindItemUpgrades as handleFindItemUpgradesNew } from "../handlers/itemShoppingHandler.js";
import { handleGetTreeNode } from "../handlers/pobTreeDataHandlers.js";
import { handleReportTreeNodeDiscrepancy, handleListTreePatches, handleGetTreeNodePatch } from "../handlers/skilltreePatchesHandlers.js";
import { handleFindJewelAffectedNodes } from "../handlers/timelessJewelHandlers.js";
import { handleListClusterJewelNodes } from "../handlers/clusterJewelListHandler.js";
import { handleEvaluateThresholdJewels } from "../handlers/thresholdJewelHandler.js";
import { handleGetTreeNodeWithTimelessJewels } from "../handlers/transformedNodeHandler.js";
import { handleListRadiusEffectJewels } from "../handlers/radiusEffectJewelHandler.js";
import { handleGetAtlasNode, handleSearchAtlasNodes, handleFindAtlasPathToNode } from "../handlers/atlasTreeHandlers.js";
import { handleSearchCraftingMods } from "../handlers/craftingModSearchHandler.js";
import { handleListCraftableModsForBase } from "../handlers/listCraftableModsHandler.js";
import { resolveLeague } from "../services/leagueResolver.js";
import { handleGetActiveLeagues } from "../handlers/leagueStatusHandler.js";
import { handleAnalyzeItemMods } from "../handlers/analyzeItemModsHandler.js";
import { handleSearchMasterCrafts, handleGetEssenceDetail } from "../handlers/craftQueryHandlers.js";
import { handleGetStatBreakdown } from "../handlers/statBreakdownHandler.js";
import { handleGetCalcBreakdown } from "../handlers/calcBreakdownHandler.js";
import { handleCalculateModOdds } from "../handlers/calculateModOddsHandler.js";

export interface ToolRouterDependencies {
  toolGate: ToolGate;
  contextBuilder: ContextBuilder;
  tradeClient: TradeApiClient | null;
  statMapper: StatMapper | null;
  recommendationEngine: ItemRecommendationEngine | null;
  ninjaClient: PoeNinjaClient;
  getLuaClient: () => import("../pobLuaBridge.js").AnyLuaClient | null;
  ensureLuaClient: () => Promise<void>;
}

export type ToolResponse = Promise<{
  content: Array<{
    type: string;
    text: string;
  }>;
}>;

/**
 * Routes a tool call to its handler with appropriate context
 */
/**
 * Tools that mutate the build → the PoB tab to auto-switch to *before* running
 * them, so a human watching the GUI sees the change happen live (TCP only).
 * Cosmetic; extend freely.
 */
const AUTO_VIEW_BY_TOOL: Record<string, string> = {
  lua_import_character: "TREE",
  lua_set_tree: "TREE",
  update_tree_delta: "TREE",
  add_gem: "SKILLS",
  remove_gem: "SKILLS",
  set_gem_level: "SKILLS",
  set_gem_quality: "SKILLS",
  toggle_gem: "SKILLS",
  create_socket_group: "SKILLS",
  remove_skill: "SKILLS",
  setup_skill_with_gems: "SKILLS",
  set_main_skill: "SKILLS",
  add_item: "ITEMS",
  add_multiple_items: "ITEMS",
  clear_item_slot: "ITEMS",
};

/**
 * name -> { required, declared } from every schema source, built once on first use.
 * Used only for pre-dispatch argument validation below.
 */
let argSpecByTool: Map<string, { required: string[]; declared: Set<string> }> | null = null;
let argSpecGame: string | undefined;
function getArgSpecByTool() {
  if (!argSpecByTool || argSpecGame !== process.env.POE_GAME) {
    argSpecGame = process.env.POE_GAME;
    argSpecByTool = new Map();
    const all: any[] = [
      ...getToolSchemas(),
      ...getLuaToolSchemas(),
      ...getOptimizationToolSchemas(),
    ];
    for (const tool of all) {
      const schema = tool?.inputSchema;
      if (!schema) continue;
      argSpecByTool.set(tool.name, {
        required: Array.isArray(schema.required) ? schema.required : [],
        declared: new Set(Object.keys(schema.properties ?? {})),
      });
    }
  }
  return argSpecByTool;
}

export async function routeToolCall(
  name: string,
  args: Record<string, unknown> | undefined,
  deps: ToolRouterDependencies
): ToolResponse {
  // Check tool gate first
  deps.toolGate.checkGate(name);

  // Validate declared-required arguments BEFORE dispatch.
  //
  // Without this, a missing required argument arrives as `undefined`, the handler
  // runs regardless, and the tool reports SUCCESS while having done nothing — the
  // worst failure mode a tool can have, because the caller believes the result.
  // Observed twice: add_item (called with `slot`, which is not the parameter name —
  // the real one is `slot_name` — so nothing was equipped yet it answered
  // "✅ Item added → Gloves"), and lua_save_build (reported a config update with
  // every field `undefined`).
  //
  // A misspelled or renamed parameter is the usual cause, so surface any argument
  // the schema doesn't declare: that is the clue which turns a baffling no-op into
  // an obvious typo. Unknown args are only *reported*, never rejected — some
  // handlers legitimately read args the schema omits (e.g. add_item's
  // `no_auto_equip`), and rejecting those would break working calls.
  const spec = getArgSpecByTool().get(name);
  if (spec && spec.required.length > 0) {
    const missing = spec.required.filter((key) => args?.[key] === undefined);
    if (missing.length > 0) {
      const extras = Object.keys(args ?? {}).filter((key) => !spec.declared.has(key));
      throw new Error(
        `${name}: missing required argument${missing.length > 1 ? "s" : ""}: ${missing.join(", ")}.` +
          (extras.length > 0
            ? ` Also received undeclared argument${extras.length > 1 ? "s" : ""}: ${extras.join(", ")}` +
              ` — likely a name mismatch. Declared: ${[...spec.declared].join(", ")}.`
            : ""),
      );
    }
  }

  // Auto-switch the visible PoB tab BEFORE a mutating op, so a human watching the
  // GUI sees the change land in real time. TCP/GUI only; skipped in headless mode
  // or when no live client is connected. Purely cosmetic — never fatal.
  const autoView = AUTO_VIEW_BY_TOOL[name];
  if (autoView) {
    const liveClient = deps.getLuaClient();
    if (liveClient instanceof PoBLuaTcpClient) {
      try {
        await liveClient.setViewMode(autoView);
      } catch {
        /* view switch is cosmetic — ignore failures */
      }
    }
  }

  // Create handler contexts using contextBuilder
  const handlerContext = deps.contextBuilder.buildHandlerContext();
  const watchContext = deps.contextBuilder.buildWatchContext();
  const treeContext = deps.contextBuilder.buildTreeContext();
  const luaContext = deps.contextBuilder.buildLuaContext();
  const itemSkillContext = deps.contextBuilder.buildItemSkillContext();
  const optimizationContext = deps.contextBuilder.buildOptimizationContext();
  const exportContext = deps.contextBuilder.buildExportContext();
  const skillGemContext = deps.contextBuilder.buildSkillGemContext();

  switch (name) {
    case "list_builds":
      return await handleListBuilds(handlerContext);

    case "analyze_build":
      if (!args) throw new Error("Missing arguments");
      return await handleAnalyzeBuild(handlerContext, args.build_name as string);

    case "compare_builds":
      if (!args) throw new Error("Missing arguments");
      return await handleCompareBuilds(
        handlerContext,
        args.build1 as string,
        args.build2 as string
      );

    case "get_build_stats":
      if (!args) throw new Error("Missing arguments");
      return await handleGetBuildStats(handlerContext, args.build_name as string);

    case "start_watching":
      return handleStartWatching(watchContext);

    case "stop_watching":
      return await handleStopWatching(watchContext);

    case "get_recent_changes":
      return handleGetRecentChanges(watchContext, args?.limit as number | undefined);

    case "watch_status":
      return handleWatchStatus(watchContext);

    case "refresh_tree_data":
      return await handleRefreshTreeData(watchContext, args?.version as string | undefined);

    // Phase 3 tools
    case "compare_trees":
      if (!args) throw new Error("Missing arguments");
      return await handleCompareTrees(
        treeContext,
        args.build1 as string,
        args.build2 as string
      );

    case "get_nearby_nodes":
      return await handleGetNearbyNodes(
        treeContext,
        args?.build_name as string | undefined,
        args?.max_distance as number | undefined,
        args?.filter as string | undefined
      );

    case "plan_tree_paths":
      if (!args) throw new Error("Missing arguments");
      return await handlePlanTreePaths(
        treeContext,
        args.build_name as string | undefined,
        args.target_node_ids as string[],
      );

    case "find_path_to_node":
      if (!args) throw new Error("Missing arguments");
      return await handleFindPath(
        treeContext,
        args.build_name as string,
        args.target_node_id as string,
        args.show_alternatives as boolean | undefined,
        args.from_node_id as string | undefined
      );

    case "get_tree_node":
      if (!args) throw new Error("Missing arguments");
      return await handleGetTreeNode(
        args.node_id as string,
        args.tree_version as string | undefined,
        args.raw_json as boolean | undefined
      );

    case "report_tree_node_discrepancy":
      if (!args) throw new Error("Missing arguments");
      return await handleReportTreeNodeDiscrepancy(
        args.node_id as string,
        args.operation as string,
        args.value,
        args.verified_from as string,
        args.verified_by as string,
        args.note as string | undefined
      );

    case "list_tree_patches":
      return await handleListTreePatches(
        args?.filter_source as string | undefined,
        args?.min_age_days as number | undefined
      );

    case "get_tree_node_patch":
      if (!args) throw new Error("Missing arguments");
      return await handleGetTreeNodePatch(args.node_id as string);

    case "get_node_power":
      return await handleGetNodePower(
        treeContext,
        args?.mode as string | undefined,
        args?.filter as string | undefined,
        args?.max_depth as number | undefined,
        args?.limit as number | undefined,
        args?.recalculate as boolean | undefined,
      );

    case "find_jewel_affected_nodes":
      return await handleFindJewelAffectedNodes({
        getLuaClient: deps.getLuaClient,
        ensureLuaClient: deps.ensureLuaClient,
      });

    case "get_tree_node_with_timeless_jewels":
      if (!args) throw new Error("Missing arguments");
      return await handleGetTreeNodeWithTimelessJewels(
        {
          getLuaClient: deps.getLuaClient,
          ensureLuaClient: deps.ensureLuaClient,
        },
        args.node_id as string
      );

    case "list_cluster_jewel_nodes":
      return await handleListClusterJewelNodes({
        getLuaClient: deps.getLuaClient,
        ensureLuaClient: deps.ensureLuaClient,
      });

    case "list_radius_effect_jewels":
      return await handleListRadiusEffectJewels({
        getLuaClient: deps.getLuaClient,
        ensureLuaClient: deps.ensureLuaClient,
      });

    case "get_atlas_node":
      if (!args) throw new Error("Missing arguments");
      return await handleGetAtlasNode(
        args.node_id as string,
        (args.variant as "default" | "league" | "ruthless" | "ruthless-league") ?? "default",
        args.raw_json as boolean | undefined
      );

    case "search_atlas_nodes":
      if (!args) throw new Error("Missing arguments");
      return await handleSearchAtlasNodes(
        args.query as string,
        args.node_type as string | undefined,
        (args.limit as number) ?? 30,
        (args.variant as "default" | "league" | "ruthless" | "ruthless-league") ?? "default"
      );

    case "find_atlas_path_to_node":
      if (!args) throw new Error("Missing arguments");
      return await handleFindAtlasPathToNode(
        args.target_node_id as string,
        args.from_node_id as string,
        (args.variant as "default" | "league" | "ruthless" | "ruthless-league") ?? "default"
      );

    case "evaluate_threshold_jewels":
      return await handleEvaluateThresholdJewels({
        getLuaClient: deps.getLuaClient,
        ensureLuaClient: deps.ensureLuaClient,
      });

    case "search_crafting_mods":
      return await handleSearchCraftingMods({
        stat_contains: args?.stat_contains as string | undefined,
        item_tags: args?.item_tags as string[] | undefined,
        type: args?.type as string | undefined,
        min_level: args?.min_level as number | undefined,
        max_level: args?.max_level as number | undefined,
        group: args?.group as string | undefined,
        has_tags: args?.has_tags as string[] | undefined,
        affix_contains: args?.affix_contains as string | undefined,
        limit: args?.limit as number | undefined,
        raw_json: args?.raw_json as boolean | undefined,
      });

    case "list_craftable_mods_for_base":
      if (!args) throw new Error("Missing arguments");
      return await handleListCraftableModsForBase({
        base_name: args.base_name as string,
        ilvl: args.ilvl as number | undefined,
        type: args.type as string | undefined,
        tiers_per_group: args.tiers_per_group as number | undefined,
        hide_unrollable: args.hide_unrollable as boolean | undefined,
        stat_contains: args.stat_contains as string | undefined,
        raw_json: args.raw_json as boolean | undefined,
      });

    case "analyze_item_mods":
      if (!args) throw new Error("Missing arguments");
      return await handleAnalyzeItemMods(
        {
          mod_lines: args.mod_lines as string[] | undefined,
          item_slot: args.item_slot as string | undefined,
          base_name: args.base_name as string | undefined,
          ilvl: args.ilvl as number | undefined,
          raw_json: args.raw_json as boolean | undefined,
        },
        {
          getLuaClient: deps.getLuaClient,
          ensureLuaClient: deps.ensureLuaClient,
        }
      );

    case "search_master_crafts":
      return await handleSearchMasterCrafts({
        stat_contains: args?.stat_contains as string | undefined,
        item_type: args?.item_type as string | undefined,
        type: args?.type as string | undefined,
        has_tags: args?.has_tags as string[] | undefined,
        limit: args?.limit as number | undefined,
        raw_json: args?.raw_json as boolean | undefined,
      });

    case "get_essence_detail":
      return await handleGetEssenceDetail({
        essence_name: args?.essence_name as string | undefined,
        stat_contains: args?.stat_contains as string | undefined,
        item_type: args?.item_type as string | undefined,
        raw_json: args?.raw_json as boolean | undefined,
      });

    case "get_stat_breakdown":
      if (!args) throw new Error("Missing arguments");
      return await handleGetStatBreakdown(
        { getLuaClient: deps.getLuaClient, ensureLuaClient: deps.ensureLuaClient },
        {
          stat: args.stat as string,
          actor: args.actor as "player" | "minion" | undefined,
          use_skill_config: args.use_skill_config as boolean | undefined,
          raw_json: args.raw_json as boolean | undefined,
        }
      );

    case "get_calc_breakdown":
      return await handleGetCalcBreakdown(
        { getLuaClient: deps.getLuaClient, ensureLuaClient: deps.ensureLuaClient },
        {
          stat: args?.stat as string | undefined,
          actor: args?.actor as "player" | "minion" | undefined,
          raw_json: args?.raw_json as boolean | undefined,
        }
      );

    case "calculate_mod_odds":
      if (!args) throw new Error("Missing arguments");
      return await handleCalculateModOdds({
        base_name: args.base_name as string,
        ilvl: args.ilvl as number,
        targets: args.targets as Array<{ stat?: string; group?: string; min_tier?: number }>,
        method: args.method as "chaos" | "alt" | "essence" | "exalt" | "augment" | "regal" | undefined,
        item_rarity: args.item_rarity as "magic" | "rare" | undefined,
        existing_mod_ids: args.existing_mod_ids as string[] | undefined,
        essence_name: args.essence_name as string | undefined,
        prefix_count: args.prefix_count as number | undefined,
        suffix_count: args.suffix_count as number | undefined,
        raw_json: args.raw_json as boolean | undefined,
      });

    // Lua bridge tools
    case "lua_start":
      return await handleLuaStart(luaContext);

    case "lua_stop":
      return await handleLuaStop(luaContext);

    case "lua_close_build":
      return await handleLuaCloseBuild(luaContext);

    case "lua_new_build":
      return await handleLuaNewBuild(luaContext, args?.class_name as string | undefined, args?.ascendancy as string | undefined);

    case "lua_save_build":
      if (!args) throw new Error("Missing arguments");
      return await handleLuaSaveBuild(luaContext, args.build_name as string, args.overwrite as boolean | undefined);

    case "lua_load_build":
      if (!args) throw new Error("Missing arguments");
      return await handleLuaLoadBuild(
        luaContext,
        args.build_name as string | undefined,
        args.build_xml as string | undefined,
        args.name as string | undefined
      );

    case "lua_list_characters":
      return await handleListCharacters(
        luaContext,
        args?.account_name as string | undefined,
        args?.realm as string | undefined
      );

    case "lua_import_character":
      if (!args || (process.env.POE_GAME !== 'poe2' && !args.character_name)) throw new Error("Missing character_name");
      return await handleImportCharacter(
        luaContext,
        args.account_name as string | undefined,
        args.character_name as string,
        args.realm as string | undefined,
        {
          clearJewels: args.clear_jewels as boolean | undefined,
          clearItems: args.clear_items as boolean | undefined,
          clearSkills: args.clear_skills as boolean | undefined,
          ignoreWeaponSwap: args.ignore_weapon_swap as boolean | undefined,
          bandit: args.bandit as string | undefined,
          pobXml: args.pob_xml as string | undefined,
        }
      );

    case "lua_import_pobb":
      if (!args?.url_or_id) throw new Error("Missing url_or_id");
      return await handleImportPobb(luaContext, args.url_or_id as string);

    case "lua_share_pobb":
      return await handleSharePobb(luaContext, args?.platform as string | undefined ?? "pobb.in");

    case "get_context_usage":
      return await handleGetContextUsage({
        client: args?.client as 'codex' | 'claude' | undefined,
        transcript_path: args?.transcript_path as string | undefined,
        thread_id: args?.thread_id as string | undefined,
      });

    case "minion_dps_breakdown":
      return await handleMinionDpsBreakdown(luaContext);

    case "compute_stat_weights":
      return await handleComputeStatWeights(
        luaContext,
        args?.slot as string | undefined,
        args?.mods as string[] | undefined
      );

    case "compute_constraint_margins":
      if (!args?.profile_path) throw new Error("Missing profile_path");
      return await handleComputeConstraintMargins(
        luaContext,
        args.profile_path as string,
        (args.write_back as boolean | undefined) ?? false
      );

    case "sync_character_cache":
      if (!args?.character_dir) throw new Error("Missing character_dir");
      return await handleSyncCharacterCache(
        luaContext,
        args.character_dir as string,
        (args.targets as string[] | undefined) ?? ["meta", "inventory"],
        (args.dry_run as boolean | undefined) ?? false
      );

    case "set_character_level": {
      if (!args) throw new Error("Missing arguments");
      const level = args.level as number;
      if (!level || level < 1 || level > 100) throw new Error("level must be between 1 and 100");
      await deps.ensureLuaClient();
      const luaClient = deps.getLuaClient();
      if (!luaClient) throw new Error("Lua bridge not active. Use lua_start first.");
      await luaClient.setLevel(level);
      const stats = await luaClient.getStats(['Life', 'EnergyShield', 'Mana', 'ManaUnreserved']);
      return {
        content: [{
          type: "text" as const,
          text: `✅ Character level set to ${level}.\n\nUpdated stats:\n  Life: ${stats.Life ?? '-'}  |  ES: ${stats.EnergyShield ?? '-'}  |  Mana: ${stats.Mana ?? '-'}  |  Mana Unreserved: ${stats.ManaUnreserved ?? '-'}`,
        }],
      };
    }

    case "lua_get_stats":
      return await handleLuaGetStats(luaContext, args?.category as string | undefined);

    case "lua_get_tree":
      return await handleLuaGetTree(luaContext, args?.include_node_ids as boolean | undefined);

    case "lua_get_build_info":
      return await handleLuaGetBuildInfo(luaContext);

    case "get_gem_detail":
      if (!args?.gem_name) throw new Error("Missing gem_name");
      return await handleGetGemDetail(
        luaContext,
        args.gem_name as string,
        args.levels as number[] | undefined
      );

    case "lua_reload_build":
      return await handleLuaReloadBuild(luaContext, args?.build_name as string | undefined);

    case "update_tree_delta":
      if (!args) throw new Error("Missing arguments");
      return await handleUpdateTreeDelta(
        luaContext,
        args.add_nodes as string[] | undefined,
        args.remove_nodes as string[] | undefined
      );

    case "create_spec":
      return await handleCreateSpec(
        luaContext,
        args?.title as string | undefined,
        args?.copyFrom as number | undefined,
        args?.activate as boolean | undefined
      );

    case "list_specs":
      return await handleListSpecs(luaContext);

    case "select_spec":
      if (args?.index == null) throw new Error("Missing index");
      return await handleSelectSpec(luaContext, args.index as number);

    case "delete_spec":
      if (args?.index == null) throw new Error("Missing index");
      return await handleDeleteSpec(luaContext, args.index as number);

    case "rename_spec":
      if (!args?.index || !args?.title) throw new Error("Missing index or title");
      return await handleRenameSpec(luaContext, args.index as number, args.title as string);

    case "list_item_sets":
      return await handleListItemSets(luaContext);

    case "select_item_set":
      if (args?.id == null) throw new Error("Missing id");
      return await handleSelectItemSet(luaContext, args.id as number);

    case "create_item_set":
      return await handleCreateItemSet(
        luaContext,
        args?.title as string | undefined,
        args?.copyFrom as number | undefined,
        args?.activate as boolean | undefined,
      );

    // Phase 9: Configuration Tools
    case "get_config":
      const getConfigContext = {
        getLuaClient: deps.getLuaClient,
        ensureLuaClient: deps.ensureLuaClient,
      };
      return await handleGetConfig(getConfigContext);

    case "set_config":
      if (!args) throw new Error("Missing arguments");
      const setConfigContext = {
        getLuaClient: deps.getLuaClient,
        ensureLuaClient: deps.ensureLuaClient,
      };
      return await handleSetConfig(setConfigContext, {
        config_name: args.config_name as string,
        value: args.value as boolean | number | string,
        config: args.config as Record<string, unknown> | undefined,
      });

    case "set_pob_view":
      if (!args?.mode) throw new Error("Missing 'mode'");
      return await handleSetPobView(
        {
          getLuaClient: deps.getLuaClient,
          ensureLuaClient: deps.ensureLuaClient,
        },
        { mode: args.mode as string },
      );

    case "set_enemy_stats":
      const setEnemyContext = {
        getLuaClient: deps.getLuaClient,
        ensureLuaClient: deps.ensureLuaClient,
      };
      return await handleSetEnemyStats(setEnemyContext, {
        level: args?.level as number | undefined,
        fire_resist: args?.fire_resist as number | undefined,
        cold_resist: args?.cold_resist as number | undefined,
        lightning_resist: args?.lightning_resist as number | undefined,
        chaos_resist: args?.chaos_resist as number | undefined,
        armor: args?.armor as number | undefined,
        evasion: args?.evasion as number | undefined,
      });

    case "save_config_preset":
      if (!args?.name) throw new Error("Missing preset name");
      return await handleSaveConfigPreset(deps.contextBuilder.buildConfigPresetContext(), args.name as string);

    case "load_config_preset":
      if (!args?.name) throw new Error("Missing preset name");
      return await handleLoadConfigPreset(deps.contextBuilder.buildConfigPresetContext(), args.name as string);

    case "list_config_presets":
      return await handleListConfigPresets(deps.contextBuilder.buildConfigPresetContext());

    case "lua_set_tree":
      if (!args) throw new Error("Missing arguments");
      return await handleLuaSetTree(luaContext, args);

    case "search_tree_nodes": {
      if (!args) throw new Error("Missing arguments");
      // Support both 'query' (schema name) and 'keyword' (legacy name)
      const searchQuery = (args.query ?? args.keyword ?? args.q) as string | undefined;
      if (!searchQuery || String(searchQuery).trim().length === 0) {
        throw new Error(`search_tree_nodes requires a 'query' parameter (received args: ${JSON.stringify(Object.keys(args))})`);
      }
      const rawNodeType = args.node_type as string | undefined;
      const nodeTypeFilter = (rawNodeType && rawNodeType.toLowerCase() !== 'any') ? rawNodeType : undefined;
      return await handleSearchTreeNodes(
        luaContext,
        String(searchQuery).trim(),
        nodeTypeFilter,
        (args.limit || args.max_results) as number | undefined,
        args.include_allocated as boolean | undefined
      );
    }

    // Phase 4: Item & Skill tools
    case "add_item":
      if (!args) throw new Error("Missing arguments");
      return await handleAddItem(itemSkillContext, args.item_text as string, args.slot_name as string | undefined, args.no_auto_equip as boolean | undefined);

    case 'clear_item_slot':
      if (!args) throw new Error('Missing arguments');
      return await handleClearItemSlot(itemSkillContext, args.slot_name as string);

    case "get_equipped_items":
      return await handleGetEquippedItems(itemSkillContext);

    case "get_socket_colors":
      return await handleGetSocketColors(itemSkillContext);

    case "toggle_flask":
      if (!args) throw new Error("Missing arguments");
      return await handleToggleFlask(itemSkillContext, args.flask_number as number | undefined, args.active as boolean, args.slotName as string | undefined);

    case "get_skill_setup":
      return await handleGetSkillSetup(itemSkillContext, args?.main_only !== false);

    case "set_main_skill":
      if (!args) throw new Error("Missing arguments");
      return await handleSetMainSkill(itemSkillContext, args.group_index as number, (args.active_skill_index ?? args.gem_index) as number | undefined, args.skill_part as number | undefined, args.stat_set as number | undefined);

    case "create_socket_group":
      return await handleCreateSocketGroup(itemSkillContext, args?.label as string | undefined, args?.slot as string | undefined, args?.enabled as boolean | undefined, args?.include_in_full_dps as boolean | undefined);

    case "add_gem":
      if (!args) throw new Error("Missing arguments");
      return await handleAddGem(itemSkillContext, args.group_index as number, args.gem_name as string, args.level as number | undefined, args.quality as number | undefined, (args.quality_type ?? args.quality_id) as string | undefined, args.enabled as boolean | undefined);

    case "set_gem_level":
      if (!args) throw new Error("Missing arguments");
      return await handleSetGemLevel(itemSkillContext, args.group_index as number, args.gem_index as number, args.level as number);

    case "set_gem_quality":
      if (!args) throw new Error("Missing arguments");
      return await handleSetGemQuality(itemSkillContext, args.group_index as number, args.gem_index as number, args.quality as number, (args.quality_type ?? args.quality_id) as string | undefined);

    case "remove_skill":
      if (!args) throw new Error("Missing arguments");
      return await handleRemoveSkill(itemSkillContext, args.group_index as number);

    case "remove_gem":
      if (!args) throw new Error("Missing arguments");
      return await handleRemoveGem(itemSkillContext, args.group_index as number, args.gem_index as number);

    case "toggle_socket_group":
      if (!args) throw new Error("Missing arguments");
      return await handleSetSocketGroupEnabled(
        itemSkillContext,
        args.group_index as number,
        args.enabled as boolean,
        args.include_in_full_dps as boolean | undefined,
        args.count as number | undefined,
      );

    case "toggle_gem":
      if (!args) throw new Error("Missing arguments");
      return await handleSetGemEnabled(itemSkillContext, args.group_index as number, args.gem_index as number, args.enabled as boolean);

    case "list_spectres":
      return await handleListSpectres(itemSkillContext, args?.search as string | undefined);

    case "set_spectres":
      if (!args) throw new Error("Missing arguments");
      return await handleSetSpectres(
        itemSkillContext,
        args.spectres as string[],
        args.mode as "replace" | "add" | undefined,
        args.group_index as number | undefined,
        args.gem_index as number | undefined,
      );

    case "setup_skill_with_gems": {
      if (!args) throw new Error("Missing arguments");
      // Schema exposes active_gem (string) + support_gems (string[]), build the gems array here
      const activeGemName = args.active_gem as string | undefined;
      const supportGemNames = args.support_gems as string[] | undefined;
      if (!activeGemName) throw new Error("active_gem is required");
      const gemsArray: Array<{name: string}> = [
        { name: activeGemName },
        ...(supportGemNames || []).map((n: string) => ({ name: n })),
      ];
      return await handleSetupSkillWithGems(
        itemSkillContext,
        gemsArray,
        args.label as string | undefined,
        args.slot as string | undefined,
        args.enabled as boolean | undefined,
        args.include_in_full_dps as boolean | undefined
      );
    }

    case "add_multiple_items":
      if (!args) throw new Error("Missing arguments");
      return await handleAddMultipleItems(
        itemSkillContext,
        args.items as Array<{item_text: string; slot_name?: string}>
      );

    // Phase 6: Build Optimization tools
    case "analyze_defenses":
      return await handleAnalyzeDefenses(optimizationContext, args?.build_name as string | undefined);

    case "suggest_optimal_nodes":
      if (!args) throw new Error("Missing arguments");
      return await handleSuggestOptimalNodes(
        optimizationContext,
        args.build_name as string,
        args.goal as string,
        (args.points_available || args.max_points) as number | undefined
      );

    case "optimize_tree":
      if (!args) throw new Error("Missing arguments");
      return await handleOptimizeTree(
        optimizationContext,
        args.build_name as string,
        args.goal as string,
        args.max_points as number | undefined,
        args.max_iterations as number | undefined,
        args.constraints as OptimizationConstraints | undefined
      );

    case "analyze_items":
      const advancedOptContext = deps.contextBuilder.buildAdvancedOptimizationContext();
      return await handleAnalyzeItems(
        advancedOptContext,
        args?.build_name as string | undefined
      );

    case "optimize_skill_links":
      const skillLinkContext = deps.contextBuilder.buildAdvancedOptimizationContext();
      return await handleOptimizeSkillLinks(
        skillLinkContext,
        args?.build_name as string | undefined
      );

    case "create_budget_build": {
      const options = args ?? {};
      const budgetBuildContext = {
        ...deps.contextBuilder.buildAdvancedOptimizationContext(),
        tradeClient: deps.tradeClient ?? undefined,
        statMapper: deps.statMapper ?? undefined,
        ninjaClient: deps.ninjaClient,
        skillGemService: skillGemContext.skillGemService,
      };
      return await handleCreateBudgetBuild(budgetBuildContext, options.build_name as string,
        (options.budget_tier ?? 'league-start') as string, {
          budget: options.budget as number | undefined, currency: options.currency as string | undefined,
          league: options.league as string | undefined, slots: options.slots as string[] | undefined,
          itemRequirements: options.item_requirements as any, runeTargets: options.rune_targets as any,
          includeGems: options.include_gems as boolean | undefined, priority: options.priority as any,
          maxPricePerItem: options.max_price as number | undefined, limitPerSlot: options.limit as number | undefined,
          maxSearches: options.max_searches as number | undefined,
        });
    }

    // Phase 7: Build Validation
    case "validate_build":
      const validationContext = deps.contextBuilder.buildValidationContext();
      return await handleValidateBuild(validationContext, {
        build_name: args?.build_name as string | undefined,
      });

    // Phase 8: Export and Persistence Tools
    case "export_build":
      if (!args) throw new Error("Missing arguments");
      return await handleExportBuild(exportContext, {
        build_name: args.build_name as string,
        output_name: args.output_name as string,
        output_directory: args.output_directory as string | undefined,
        overwrite: args.overwrite as boolean | undefined,
        notes: args.notes as string | undefined,
      });

    case "save_tree":
      if (!args) throw new Error("Missing arguments");
      return await handleSaveTree(exportContext, {
        build_name: args.build_name as string,
        nodes: args.nodes as string[],
        mastery_effects: args.mastery_effects as Record<string, number> | undefined,
        backup: args.backup as boolean | undefined,
      });

    case "snapshot_build":
      if (!args) throw new Error("Missing arguments");
      return await handleSnapshotBuild(exportContext, {
        build_name: args.build_name as string,
        description: args.description as string | undefined,
        tag: args.tag as string | undefined,
      });

    case "list_snapshots":
      if (!args) throw new Error("Missing arguments");
      return await handleListSnapshots(exportContext, {
        build_name: args.build_name as string,
        limit: args.limit as number | undefined,
        tag_filter: args.tag_filter as string | undefined,
      });

    case "restore_snapshot":
      if (!args) throw new Error("Missing arguments");
      return await handleRestoreSnapshot(exportContext, {
        build_name: args.build_name as string,
        snapshot_id: args.snapshot_id as string,
        backup_current: args.backup_current as boolean | undefined,
      });

    case "export_build_summary":
      return await handleExportBuildSummary(deps.contextBuilder.buildExportContext());

    // Skill Gem Analysis Tools (Phase 11)
    case "analyze_skill_links":
      return await handleAnalyzeSkillLinks(skillGemContext, args);

    case "suggest_support_gems":
      return await handleSuggestSupportGems(skillGemContext, args);

    case "compare_gem_setups":
      if (!args) throw new Error("Missing arguments");
      return await handleCompareGemSetups(skillGemContext, {
        build_name: args.build_name as string,
        skill_index: args.skill_index as number | undefined,
        evaluation_skill_index: args.evaluation_skill_index as number | undefined,
        metric: args.metric as Parameters<typeof handleCompareGemSetups>[1]['metric'],
        setups: args.setups as Parameters<typeof handleCompareGemSetups>[1]['setups'],
      });

    case "validate_gem_quality":
      return await handleValidateGemQuality(skillGemContext, args);

    case "find_optimal_links":
      if (!args) throw new Error("Missing arguments");
      return await handleFindOptimalLinks(skillGemContext, {
        build_name: args.build_name as string,
        skill_index: args.skill_index as number | undefined,
        link_count: args.link_count as number,
        budget: args.budget as "league_start" | "mid_league" | "endgame" | undefined,
        optimize_for: args.optimize_for as "dps" | "clear_speed" | "bossing" | "defense" | undefined,
      });

    // ========================================
    // Trade API Tools
    // ========================================
    case "search_trade_items": {
      if (!deps.tradeClient) {
        throw new Error("Trade API is not enabled. Set POE_TRADE_ENABLED=true to enable.");
      }
      if (!args) throw new Error("Missing arguments");
      const tradeContext = {
        tradeClient: deps.tradeClient,
        statMapper: deps.statMapper || undefined,
        ninjaClient: deps.ninjaClient
      };
      const merged = { ...args, league: resolveLeague(args.league as string | undefined) };
      return await handleSearchTradeItems(tradeContext, merged as any);
    }

    case "find_weighted_trade_items": {
      if (!deps.tradeClient) {
        throw new Error("Trade API is not enabled. Set POE_TRADE_ENABLED=true to enable.");
      }
      if (!args || !args.slot) {
        throw new Error("Missing required argument: slot");
      }
      const tradeContext = {
        tradeClient: deps.tradeClient,
        statMapper: deps.statMapper || undefined,
        ninjaClient: deps.ninjaClient,
        getLuaClient: deps.getLuaClient,
        ensureLuaClient: deps.ensureLuaClient,
      };
      const merged = { ...args, league: resolveLeague(args.league as string | undefined) };
      return await handleFindWeightedTradeItems(tradeContext, merged as any);
    }

    case "get_item_price": {
      if (!deps.tradeClient) {
        throw new Error("Trade API is not enabled. Set POE_TRADE_ENABLED=true to enable.");
      }
      const tradeContext = {
        tradeClient: deps.tradeClient,
        statMapper: deps.statMapper || undefined,
        ninjaClient: deps.ninjaClient
      };
      if (!args) throw new Error("Missing arguments");
      return await handleGetItemPrice(tradeContext, {
        item_name: args.item_name as string,
        league: args.league as string | undefined,
        item_type: args.item_type as string | undefined,
        rarity: args.rarity as "unique" | "rare" | "magic" | "normal" | undefined,
        variant: args.variant as string | undefined,
        corrupted: args.corrupted as boolean | undefined,
        stats: args.stats as Array<{id:string;min?:number;max?:number}> | undefined,
      });
    }

    case "get_leagues": {
      if (!deps.tradeClient) {
        throw new Error("Trade API is not enabled. Set POE_TRADE_ENABLED=true to enable.");
      }
      const tradeContext = {
        tradeClient: deps.tradeClient,
        statMapper: deps.statMapper || undefined,
        ninjaClient: deps.ninjaClient
      };
      return await handleGetLeagues(tradeContext);
    }

    case "get_active_leagues":
      return await handleGetActiveLeagues({ tradeClient: deps.tradeClient ?? null });

    case "search_stats": {
      if (!deps.tradeClient || !deps.statMapper) {
        throw new Error("Trade API is not enabled. Set POE_TRADE_ENABLED=true to enable.");
      }
      if (!args) throw new Error("Missing arguments");
      const tradeContext = {
        tradeClient: deps.tradeClient,
        statMapper: deps.statMapper,
        ninjaClient: deps.ninjaClient
      };
      return await handleSearchStats(tradeContext, {
        query: args.query as string,
        limit: args.limit as number | undefined,
      });
    }

    case "find_item_upgrades": {
      if (!args) throw new Error("Missing arguments");
      return await handleFindItemUpgradesNew(
        {
          buildService: handlerContext.buildService,
          getLuaClient: deps.getLuaClient,
          ensureLuaClient: deps.ensureLuaClient,
          tradeClient: deps.tradeClient ?? undefined,
          statMapper: deps.statMapper ?? undefined,
          ninjaClient: deps.ninjaClient,
          recommendationEngine: deps.recommendationEngine ?? undefined,
          skillGemService: skillGemContext.skillGemService,
        },
        args as any
      );
    }

    case "find_resistance_gear": {
      if (!deps.tradeClient || !deps.recommendationEngine) {
        throw new Error("Trade API is not enabled. Set POE_TRADE_ENABLED=true to enable.");
      }
      if (!args) throw new Error("Missing arguments");
      const tradeContext = {
        tradeClient: deps.tradeClient,
        statMapper: deps.statMapper || undefined,
        recommendationEngine: deps.recommendationEngine,
        ninjaClient: deps.ninjaClient
      };
      return await handleFindResistanceGear(tradeContext, args as any);
    }

    case "compare_trade_items": {
      if (!deps.tradeClient) {
        throw new Error("Trade API is not enabled. Set POE_TRADE_ENABLED=true to enable.");
      }
      if (!args) throw new Error("Missing arguments");
      const tradeContext = {
        tradeClient: deps.tradeClient,
        statMapper: deps.statMapper || undefined,
        recommendationEngine: deps.recommendationEngine || undefined,
        ninjaClient: deps.ninjaClient
      };
      return await handleCompareTradeItems(tradeContext, args as any);
    }

    case "search_cluster_jewels": {
      if (!deps.tradeClient) {
        throw new Error("Trade API is not enabled. Set POE_TRADE_ENABLED=true to enable.");
      }
      if (!args) throw new Error("Missing arguments");
      const tradeContext = {
        tradeClient: deps.tradeClient,
        statMapper: deps.statMapper || undefined,
        ninjaClient: deps.ninjaClient
      };
      return await handleSearchClusterJewels(tradeContext, args as any);
    }

    case "analyze_cluster_jewels": {
      if (!args) throw new Error("Missing arguments");
      const buildContext = {
        buildService: deps.contextBuilder.buildHandlerContext().buildService
      };
      return await handleAnalyzeClusterJewels(buildContext, {
        build_name: args.build_name as string
      });
    }

    case "generate_shopping_list": {
      const shoppingContext = {
        buildService: handlerContext.buildService,
        getLuaClient: deps.getLuaClient,
        ensureLuaClient: deps.ensureLuaClient,
        tradeClient: deps.tradeClient ?? undefined,
        statMapper: deps.statMapper || undefined,
        ninjaClient: deps.ninjaClient,
        recommendationEngine: deps.recommendationEngine ?? undefined,
        skillGemService: skillGemContext.skillGemService,
      };
      return await handleGenerateShoppingList(shoppingContext, {
        ...args,
        league: args?.league !== undefined || process.env.POE_LEAGUE
          ? resolveLeague(args?.league as string | undefined) : '',
      } as any);
    }

    // ========================================
    // poe.ninja API Tools
    // ========================================
    case "get_currency_rates": {
      const ninjaContext = {
        ninjaClient: deps.ninjaClient
      };
      const merged = { ...(args ?? {}), league: resolveLeague(args?.league as string | undefined) };
      return await handleGetCurrencyRates(ninjaContext, merged as any);
    }

    case "find_arbitrage": {
      const ninjaContext = {
        ninjaClient: deps.ninjaClient
      };
      const merged = { ...(args ?? {}), league: resolveLeague(args?.league as string | undefined) };
      return await handleFindArbitrage(ninjaContext, merged as any);
    }

    case "calculate_trading_profit": {
      if (!args) throw new Error("Missing arguments");
      const ninjaContext = {
        ninjaClient: deps.ninjaClient
      };
      const merged = { ...args, league: resolveLeague(args.league as string | undefined) };
      return await handleCalculateTradingProfit(ninjaContext, merged as any);
    }

    // Build Goals Tools
    case "get_build_issues": {
      const goalsContext = {
        getLuaClient: deps.getLuaClient,
        ensureLuaClient: deps.ensureLuaClient,
      };
      const { issues, stats } = await handleGetBuildIssues(goalsContext);
      return formatIssuesResponse(issues, stats);
    }

    case "get_passive_upgrades": {
      const upgradesContext = {
        getLuaClient: deps.getLuaClient,
        ensureLuaClient: deps.ensureLuaClient,
      };
      const focus = (args?.focus as 'dps' | 'defence' | 'both') || 'both';
      const maxResults = (args?.max_results as number) || 10;
      return await handleGetPassiveUpgrades(upgradesContext, focus, maxResults);
    }

    case "find_best_anointment": {
      if (!args || typeof args.slot !== 'string') {
        throw new Error('find_best_anointment requires a "slot" argument');
      }
      const anointContext = {
        getLuaClient: deps.getLuaClient,
        ensureLuaClient: deps.ensureLuaClient,
      };
      return await handleFindBestAnointment(anointContext, {
        slot: args.slot as string,
        focus: args.focus as 'dps' | 'defence' | 'both' | undefined,
        max_results: args.max_results as number | undefined,
      });
    }

    case "analyze_build_cluster_jewels":
      return await handleAnalyzeBuildClusterJewels({
        getLuaClient: deps.getLuaClient,
        ensureLuaClient: deps.ensureLuaClient,
      });

    case "suggest_watchers_eye":
      return await handleSuggestWatchersEye({
        getLuaClient: deps.getLuaClient,
        ensureLuaClient: deps.ensureLuaClient,
      });

    case "check_boss_readiness":
      if (!args?.boss) throw new Error("Missing boss name");
      return await handleCheckBossReadiness(
        { getLuaClient: deps.getLuaClient, ensureLuaClient: deps.ensureLuaClient },
        args.boss as string
      );

    case "plan_leveling":
      return await handlePlanLeveling(
        { buildService: handlerContext.buildService, getLuaClient: deps.getLuaClient, ensureLuaClient: deps.ensureLuaClient },
        args || {}
      );

    case "suggest_masteries":
      return await handleSuggestMasteries({
        getLuaClient: deps.getLuaClient,
        ensureLuaClient: deps.ensureLuaClient,
      });

    case "get_build_notes":
      if (!args?.build_name) throw new Error("Missing build_name");
      return await handleGetBuildNotes(deps.contextBuilder.buildHandlerContext(), args.build_name as string);

    case "set_build_notes":
      if (!args?.build_name) throw new Error("Missing build_name");
      if (args?.notes == null) throw new Error("Missing notes");
      return await handleSetBuildNotes(deps.contextBuilder.buildHandlerContext(), args.build_name as string, args.notes as string);

    case "gem_upgrade_path":
      return await handleGemUpgradePath(
        deps.contextBuilder.buildSkillGemContext(),
        args || {}
      );

    case "suggest_crafting": {
      const craftingContext = {
        buildService: handlerContext.buildService,
        ensureLuaClient: deps.ensureLuaClient,
        getLuaClient: deps.getLuaClient,
        ninjaClient: deps.ninjaClient,
      };
      return await handleSuggestCrafting(craftingContext, args as any);
    }

    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}
