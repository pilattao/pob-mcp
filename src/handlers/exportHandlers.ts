import type { BuildService } from "../services/buildService.js";
import type { BuildExportService } from "../services/buildExportService.js";
import type { AnyLuaClient } from "../pobLuaBridge.js";
import type { ExportContext } from "../utils/contextBuilder.js";
import { wrapHandler } from "../utils/errorHandling.js";

export interface ExportHandlerContext {
  buildService: BuildService;
  exportService: BuildExportService;
  luaClient?: AnyLuaClient;
}

export async function handleExportBuild(
  context: ExportHandlerContext,
  args: {
    build_name: string;
    output_name: string;
    output_directory?: string;
    overwrite?: boolean;
    notes?: string;
  }
) {
  return wrapHandler('export build', async () => {
  const { exportService, buildService } = context;

  // Read the source build
  buildService.invalidateBuild(args.build_name);
  const buildData = await buildService.readBuild(args.build_name);

  // Export the build
  const result = await exportService.exportBuild(buildData, {
    outputName: args.output_name,
    outputDirectory: args.output_directory,
    overwrite: args.overwrite,
    notes: args.notes,
  });

  // Generate brief summary (not full build details to keep response small)
  const className = buildData.Build?.className || "Unknown";
  const ascendancy = buildData.Build?.ascendClassName || "None";
  const level = buildData.Build?.level || "Unknown";

  return {
    content: [
      {
        type: "text" as const,
        text:
          `${result.message}\n\n` +
          `Exported: ${className} (${ascendancy}) - Level ${level}\n` +
          `Source: ${args.build_name}\n` +
          `Output: ${args.output_name}`,
      },
    ],
  };
  });
}

export async function handleSaveTree(
  context: ExportHandlerContext,
  args: {
    build_name: string;
    nodes: string[];
    mastery_effects?: Record<string, number>;
    backup?: boolean;
  }
) {
  return wrapHandler('save tree', async () => {
  const { exportService, buildService } = context;

  const result = await exportService.saveTree(buildService, {
    buildName: args.build_name,
    nodes: args.nodes,
    masteryEffects: args.mastery_effects,
    backup: args.backup,
  });

  let message = result.message;
  if (result.backupPath) {
    message += `\n\nBackup created: ${result.backupPath}`;
  }

  // Invalidate cache for this build
  buildService.invalidateBuild(args.build_name);

  return {
    content: [
      {
        type: "text" as const,
        text: message,
      },
    ],
  };
  });
}

export async function handleSnapshotBuild(
  context: ExportHandlerContext,
  args: {
    build_name: string;
    description?: string;
    tag?: string;
  }
) {
  return wrapHandler('snapshot build', async () => {
  const { exportService, buildService } = context;
  const fileName = args.build_name;

  const result = await exportService.snapshotBuild(buildService, {
    buildName: fileName,
    description: args.description,
    tag: args.tag,
  });

  return {
    content: [
      {
        type: "text" as const,
        text:
          `Snapshot created successfully!\n\n` +
          `Snapshot ID: ${result.snapshotId}\n` +
          `Tag: ${args.tag || 'snapshot'}\n` +
          `Location: ${result.snapshotPath}\n\n` +
          `You can restore this snapshot later using:\n` +
          `  restore_snapshot(build_name="${args.build_name}", snapshot_id="${result.snapshotId}")`,
      },
    ],
  };
  });
}

export async function handleListSnapshots(
  context: ExportHandlerContext,
  args: {
    build_name: string;
    limit?: number;
    tag_filter?: string;
  }
) {
  return wrapHandler('list snapshots', async () => {
  const { exportService } = context;
  const fileName = args.build_name;

  const result = await exportService.listSnapshots(fileName, {
    limit: args.limit,
    tagFilter: args.tag_filter,
  });

  const formatted = exportService.formatSnapshotList(result);

  return {
    content: [
      {
        type: "text" as const,
        text: `=== Snapshots for ${args.build_name} ===\n\n${formatted}`,
      },
    ],
  };
  });
}

export async function handleRestoreSnapshot(
  context: ExportHandlerContext,
  args: {
    build_name: string;
    snapshot_id: string;
    backup_current?: boolean;
    reload_live?: boolean;
  }
) {
  return wrapHandler('restore snapshot', async () => {
  const { exportService, buildService } = context;
  if (args.reload_live !== undefined && typeof args.reload_live !== 'boolean') throw new Error('reload_live must be a boolean');
  if (args.reload_live && !context.luaClient) throw new Error('Cannot reload live PoB: no active Lua client');

  // The service resolves extensions and both relative separator styles consistently.
  const fileName = args.build_name;

  const result = await exportService.restoreSnapshot({
    buildName: fileName,
    snapshotId: args.snapshot_id,
    backupCurrent: args.backup_current,
  });

  let message = result.message;
  if (result.backupId) {
    message += `\n\nCurrent build backed up with ID: ${result.backupId}`;
  }

  // Invalidate cache for this build
  buildService.invalidateBuild(args.build_name);

  // File restoration and loading a live build are separate actions. A connected
  // session may contain a different unsaved build; reload only when requested.
  const { luaClient } = context;
  if (luaClient && args.reload_live === true) {
    const name = args.build_name.replace(/\.xml$/i, '');
    try {
      await luaClient.loadBuildXml(result.restoredXml, name);
      message += `\n\n🔄 Live PoB session reloaded — in-memory build now matches the snapshot.`;
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      message +=
        `\n\nPartial restore: the build FILE was restored, but live reload could not be verified (${detail}).\n` +
        `Live PoB state is unknown: a queued open may already have changed it. ` +
        `Read the live build information and stats again before using native results.`;
      return {
        isError: true,
        structuredContent: {
          fileRestored: true,
          liveReloadVerified: false,
          liveState: 'unknown' as const,
          buildName: args.build_name,
          snapshotId: args.snapshot_id,
          ...(result.backupId ? { backupId: result.backupId } : {}),
          error: detail,
        },
        content: [{ type: 'text' as const, text: message }],
      };
    }
  } else {
    message += '\n\nOnly the saved build file was restored. Live PoB was not reloaded.';
  }

  return {
    content: [
      {
        type: "text" as const,
        text: message,
      },
    ],
  };
  });
}

export async function handleExportBuildSummary(context: ExportContext) {
  return wrapHandler('export build summary', async () => {
  const luaClient = context.luaClient;
  if (!luaClient) throw new Error('Lua bridge not active. Use lua_load_build first.');

  // Lua bridge only supports one request at a time — must be sequential
  let info: any = null;
  let stats: Record<string, any> = {};
  let skills: any = null;
  let tree: any = null;
  const unavailable: string[] = [];

  try { info = await luaClient.getBuildInfo(); } catch { unavailable.push('build information'); }
  try {
    stats = await luaClient.getStats([
      'Life', 'EnergyShield', 'Mana', 'ManaUnreserved',
      'TotalDPS', 'CombinedDPS', 'MinionTotalDPS',
      'FireResist', 'ColdResist', 'LightningResist', 'ChaosResist',
      'Armour', 'Evasion', 'PhysicalDamageReduction', 'TotalEHP',
      'LifeRegen', 'SpellSuppressionChance', 'BlockChance',
    ]) ?? {};
  } catch { unavailable.push('calculated stats'); }
  try { skills = await luaClient.getSkills(); } catch { unavailable.push('skills'); }
  try { tree = await luaClient.getTree(); } catch { unavailable.push('tree'); }

  const classNames = ['Scion', 'Marauder', 'Ranger', 'Witch', 'Duelist', 'Templar', 'Shadow'];
  const poe1 = info?.game === 'poe1' || (info?.game !== 'poe2' && process.env.POE_GAME === 'poe1');
  const className = info?.className || info?.class || tree?.className ||
    (poe1 && tree?.classId != null ? classNames[tree.classId] : undefined) || 'Unknown';
  const buildName = info?.name || 'Unnamed Build';
  const level = info?.level || '?';
  const ascendancy = info?.ascendClassName || info?.ascendancy || '';

  const value = (name: string): number | undefined => {
    const raw = stats[name];
    if ((typeof raw !== 'number' && typeof raw !== 'string') || raw === '') return undefined;
    const parsed = Number(raw);
    return Number.isFinite(parsed) ? parsed : undefined;
  };
  const display = (number: number | undefined) => number === undefined ? 'Unknown' : number.toLocaleString();
  const dps = value('CombinedDPS') ?? value('TotalDPS') ?? value('MinionTotalDPS');
  const dpsLabel = value('CombinedDPS') === undefined && value('TotalDPS') === undefined && value('MinionTotalDPS') !== undefined ? 'Minion DPS' : 'DPS';

  let output = `# ${buildName}\n\n`;
  output += `**Class:** ${className}${ascendancy ? ` (${ascendancy})` : ''}  \n`;
  output += `**Level:** ${level}\n\n`;
  if (unavailable.length) output += `Unavailable reads: ${unavailable.join(', ')}. Missing values remain unknown.\n\n`;

  output += `## Key Stats\n\n`;
  output += `| Stat | Value |\n|------|-------|\n`;
  output += `| Life | ${display(value('Life'))} |\n`;
  if (value('EnergyShield') !== undefined) {
    output += `| Energy Shield | ${display(value('EnergyShield'))} |\n`;
  }
  output += `| ${dpsLabel} | ${display(dps === undefined ? undefined : Math.round(dps))} |\n`;
  output += `| Total EHP | ${display(value('TotalEHP'))} |\n`;
  output += `| Fire/Cold/Light Resist | ${stats.FireResist ?? '?'}% / ${stats.ColdResist ?? '?'}% / ${stats.LightningResist ?? '?'}% |\n`;
  output += `| Chaos Resist | ${stats.ChaosResist ?? '?'}% |\n`;
  if (Number(stats.Armour ?? 0) > 0) output += `| Armour | ${Number(stats.Armour).toLocaleString()} |\n`;
  if (Number(stats.Evasion ?? 0) > 0) output += `| Evasion | ${Number(stats.Evasion).toLocaleString()} |\n`;
  if (Number(stats.BlockChance ?? 0) > 0) output += `| Block | ${stats.BlockChance}% |\n`;
  if (Number(stats.SpellSuppressionChance ?? 0) > 0) output += `| Spell Suppression | ${stats.SpellSuppressionChance}% |\n`;
  output += '\n';

  // Main skill setup
  const mainGroup = skills?.groups?.find((g: any) => g.index === skills.mainSocketGroup && g.enabled !== false);
  if (mainGroup) {
    const gemNames = (mainGroup.gems || []).filter((g: any) => g.enabled !== false).map((g: any) => g.name || g).filter(Boolean);
    output += `## Main Skill\n\n`;
    output += `**${mainGroup.label || 'Main'}:** ${gemNames.join(' + ')}\n\n`;
  }

  // Keystone passives
  if (Array.isArray(tree?.keystones) && tree.keystones.length > 0) {
    output += `## Keystones\n\n`;
    output += tree.keystones.map((k: string) => `- ${k}`).join('\n') + '\n\n';
  }

  output += `---\n_Generated with pob-mcp-server_\n`;

  return { content: [{ type: 'text' as const, text: output }] };
  });
}
