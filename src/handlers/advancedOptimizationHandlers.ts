import { createBudgetBuildPlan, formatBudgetBuildPlan, type BudgetBuildContext, type BudgetBuildOptions } from "../services/budgetBuildService.js";
import { analyzePoe2Items } from "../services/poe2ItemAnalysis.js";
import type { AnyLuaClient } from "../pobLuaBridge.js";
import type { BuildService } from "../services/buildService.js";
import {
  analyzeEquippedItems,
  formatItemAnalysis,
  inferBuildArchetype,
  type BuildStats,
} from "../itemAnalyzer.js";
import {
  analyzeSkillSetup,
  formatSkillOptimization,
  type SkillGroup,
} from "../skillLinkOptimizer.js";
import { sanitizeBuildName } from "../utils/pathSanitizer.js";

export interface AdvancedOptimizationContext {
  buildService: BuildService;
  pobDirectory: string;
  getLuaClient: () => AnyLuaClient | null;
  ensureLuaClient: () => Promise<void>;
}

/**
 * Analyze equipped items and suggest upgrades
 */
export async function handleAnalyzeItems(
  context: AdvancedOptimizationContext,
  buildName?: string
) {
  try {
    if (process.env.POE_GAME === 'poe2') {
      return {content:[{type:'text' as const,text:await analyzePoe2Items(context,buildName)}]};
    }
    let items: Array<{ slot: string; name?: string; baseName?: string; rarity?: string }> = [];
    let className: string | undefined;
    let ascendClassName: string | undefined;
    let stats: BuildStats | undefined;

    // Try to use Lua client for accurate data if available
    const luaClient = context.getLuaClient();

    if (luaClient) {
      // Load build into Lua only if a different build (or no build) is currently loaded.
      // Preserves any select_spec / select_item_set changes made in the current session.
      if (buildName) {
        const fs = await import('fs/promises');
        const path = await import('path');
        let needsLoad = true;
        try {
          const info = await luaClient.getBuildInfo();
          const loaded = (info?.name ?? '').replace(/\.xml$/i, '');
          const requested = buildName.replace(/\.xml$/i, '');
          if (loaded && (loaded === requested || loaded.split(/[/\\]/).pop() === requested.split(/[/\\]/).pop())) {
            needsLoad = false;
          }
        } catch { /* no build loaded yet */ }
        if (needsLoad) {
          const buildPath = sanitizeBuildName(buildName, context.pobDirectory);
          const xml = await fs.readFile(buildPath, 'utf-8');
          await luaClient.loadBuildXml(xml, buildName);
        }
      }

      try {
        const luaItems = await luaClient.getItems();
        items = luaItems.map((item) => ({
          slot: item.slot,
          name: item.name,
          baseName: item.baseName,
          rarity: item.rarity,
        }));

        // Get stats from Lua
        const luaStats = await luaClient.getStats();
        stats = {
          life: luaStats.Life,
          energyShield: luaStats.EnergyShield,
          evasion: luaStats.Evasion,
          armour: luaStats.Armour,
          dps: luaStats.TotalDPS,
          fireRes: luaStats['FireResist'],
          coldRes: luaStats['ColdResist'],
          lightningRes: luaStats['LightningResist'],
          chaosRes: luaStats['ChaosResist'],
        };

        // Get class info from tree
        const tree = await luaClient.getTree();
        const classNames = ['Scion', 'Marauder', 'Ranger', 'Witch', 'Duelist', 'Templar', 'Shadow'];
        className = classNames[tree.classId] || 'Unknown';
      } catch (error) {
        if (!buildName) {
          throw new Error(
            'No build loaded in Lua client and no build_name provided. Load a build first or provide build_name.'
          );
        }
        // Fall through to XML parsing below
      }
    }

    // Fall back to XML if no Lua data
    if (items.length === 0 && buildName) {
      const build = await context.buildService.readBuild(buildName);

      className = className || build.Build?.className;
      ascendClassName = build.Build?.ascendClassName;

      // Extract items from XML
      if (build.Items?.ItemSet?.Slot) {
        const slots = Array.isArray(build.Items.ItemSet.Slot)
          ? build.Items.ItemSet.Slot
          : [build.Items.ItemSet.Slot];

        items = slots.map((slot) => {
          const itemText = slot.Item || '';
          const lines = itemText.split('\n');
          const rarity = lines[0]?.includes('Rarity:') ? lines[0].split(':')[1]?.trim() : undefined;
          const name = lines[1] || '(empty)';

          return {
            slot: slot.name || 'Unknown',
            name,
            rarity,
          };
        });
      }

      // Extract stats from XML
      if (!stats && build.Build?.PlayerStat) {
        const statsArray = Array.isArray(build.Build.PlayerStat)
          ? build.Build.PlayerStat
          : [build.Build.PlayerStat];

        stats = {};
        for (const stat of statsArray) {
          const key = stat.stat.replace(/\s+/g, '');
          stats[key] = parseFloat(stat.value) || 0;
        }
      }
    }

    // Analyze items
    const analysis = analyzeEquippedItems(items, className, ascendClassName, stats);
    const formatted = formatItemAnalysis(analysis);

    return {
      content: [
        {
          type: "text" as const,
          text: formatted,
        },
      ],
    };
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to analyze items: ${errorMsg}`);
  }
}

/**
 * Analyze skill links and suggest optimizations
 */
export async function handleOptimizeSkillLinks(
  context: AdvancedOptimizationContext,
  buildName?: string
) {
  try {
    const { analyzePoe2SkillGroupsForBuild } = await import('./skillGemHandlers.js');
    return await analyzePoe2SkillGroupsForBuild(context, buildName);
  } catch (error) {
    throw new Error(`Failed to optimize skill links: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/** Build a read-only, evidence-backed PoE2 budget adaptation of the selected loadout. */
export async function handleCreateBudgetBuild(
  context: AdvancedOptimizationContext & BudgetBuildContext,
  buildName?: string,
  budgetTier: string = 'league-start',
  options: BudgetBuildOptions = {}
) {
  try {
    const plan = await createBudgetBuildPlan(context, buildName, {
      ...options, budgetTier, league: options.league ?? process.env.POE_LEAGUE,
    });
    return {
      content: [{ type: 'text' as const, text: formatBudgetBuildPlan(plan) }],
      structuredContent: plan,
    };
  } catch (error) {
    throw new Error(`Failed to create budget build plan: ${error instanceof Error ? error.message : String(error)}`);
  }
}
