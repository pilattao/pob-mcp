import type { AnyLuaClient } from "../pobLuaBridge.js";
import { wrapHandler } from "../utils/errorHandling.js";
import { ConfigService, validateConfigPatch, writeConfigPreset, readConfigPreset, listConfigPresets,
  type ConfigInput, type ConfigGame, type NativeConfigSnapshot } from "../services/configService.js";

export interface ConfigHandlerContext {
  getLuaClient: () => AnyLuaClient | null;
  ensureLuaClient: () => Promise<void>;
}

export interface ConfigPresetContext {
  getLuaClient: () => AnyLuaClient | null;
  ensureLuaClient: () => Promise<void>;
  pobDirectory: string;
}

const configGame = (): ConfigGame => process.env.POE_GAME === 'poe2' ? 'poe2' : 'poe1';
const errorText = (error: unknown) => error instanceof Error ? error.message : String(error);

async function nativeClient(context: ConfigHandlerContext): Promise<AnyLuaClient> {
  await context.ensureLuaClient();
  const client = context.getLuaClient();
  if (!client) throw new Error('Lua bridge not active. Use lua_start and lua_load_build first.');
  return client;
}

export async function handleSaveConfigPreset(context: ConfigPresetContext, name: string) {
  return wrapHandler('save config preset',async()=>{
    const client=await nativeClient(context);
    const game=configGame();
    let input: ConfigInput;
    let source: {kind:string;activeConfigSetId?:number};
    if (game === 'poe2') {
      const captured=await new ConfigService(client).explicitOverrides();
      input=captured.input;source={kind:'native PoB2 ConfigSet XML Input overrides',activeConfigSetId:captured.snapshot.activeConfigSetId};
    } else {
      input=validateConfigPatch(await client.getConfig(),'poe1',true);
      source={kind:'native PoE1 config input'};
    }
    const file=await writeConfigPreset(context.pobDirectory,name,{schemaVersion:1,game,scope:game==='poe2'?'explicit-input-overrides':'native-input',source,input});
    return {content:[{type:'text' as const,text:`Config preset "${name}" saved for ${game}: ${Object.keys(input).length} ${game==='poe2'?'explicit input overrides':'settings'}.\nPath: ${file}`} ]};
  });
}

export async function handleLoadConfigPreset(context: ConfigPresetContext, name: string) {
  return wrapHandler('load config preset',async()=>{
    const game=configGame();
    const preset=await readConfigPreset(context.pobDirectory,name,game);
    const client=await nativeClient(context);
    const count=Object.keys(preset.input).length;
    let detail='';
    if (count && game==='poe2') {
      const result=await new ConfigService(client).apply(preset.input);
      detail=` Applied and verified in native config set ${result.after.activeConfigSetId}.`;
    } else if (count) await client.setConfig(preset.input);
    return {content:[{type:'text' as const,text:`Config preset "${name}" (${game}): ${count} input overrides in this patch.${detail} Unlisted inputs remain unchanged.`}]};
  });
}

export async function handleListConfigPresets(context: ConfigPresetContext) {
  return wrapHandler('list config presets',async()=>{
    const game=configGame();
    const presets=await listConfigPresets(context.pobDirectory,game);
    return {content:[{type:'text' as const,text:presets.length
      ? `Config presets for ${game}:\n${presets.map((p,i)=>`${i+1}. ${p.name}${p.legacy?' (legacy PoE1)':''}`).join('\n')}`
      : `No config presets saved for ${game}.`}]};
  });
}

function formatNativeConfig(config: NativeConfigSnapshot): string {
  return `=== Native PoE2 Configuration ===\n\nSource: ${config.source}\nActive config set: ${config.activeConfigSetId}\n` +
    `Effective enemy level: ${config.effectiveEnemyLevel ?? 'unavailable'}\n` +
    `Enemy level override: ${config.input.enemyLevel === undefined ? 'not set (automatic)' : config.input.enemyLevel}\n\n` +
    `Raw native inputs (include initialized defaults; flags do not establish applicability to the build):\n` + JSON.stringify(config.input,null,2);
}

export type SetConfigArgs = {config_name?: string; value?: boolean | number | string; config?: Record<string, unknown>};
function explicitConfigPatch(args: SetConfigArgs): ConfigInput {
  if (args.config !== undefined) {
    if (args.config_name !== undefined || args.value !== undefined) throw new Error('Provide either config batch or config_name/value, not both');
    return validateConfigPatch(args.config);
  }
  if (typeof args.config_name !== 'string' || !args.config_name.trim() || args.value === undefined) throw new Error('config_name and value, or a config batch, are required');
  return validateConfigPatch({[args.config_name]:args.value});
}

async function optionalStats(client: AnyLuaClient): Promise<{stats?: Record<string,unknown>;error?:string}> {
  try {
    const stats=await client.getStats(['CombinedDPS','TotalDPS','Life','EnergyShield']);
    if (!stats || typeof stats !== 'object') throw new Error('native stats unavailable');
    return {stats};
  } catch(error) {return {error:errorText(error)};}
}

function nativeWriteSummary(before: NativeConfigSnapshot, after: NativeConfigSnapshot, patch: ConfigInput): string {
  const value=(v: unknown)=>v===undefined?'not set':JSON.stringify(v);
  const lines=[`Configuration applied and verified in native PoB2 config set ${after.activeConfigSetId}.`];
  for(const key of Object.keys(patch)) lines.push(`${key}:\n  Old Value: ${value(before.input[key])}\n  Requested: ${value(patch[key])}\n  Stored: ${value(after.input[key])}`);
  lines.push(`Effective enemy level: ${before.effectiveEnemyLevel ?? 'unavailable'} → ${after.effectiveEnemyLevel ?? 'unavailable'}`);
  return lines.join('\n');
}

/**
 * Handle get_config tool call
 */
export async function handleGetConfig(context: ConfigHandlerContext) {
  return wrapHandler('get config', async () => {
  await context.ensureLuaClient();
  const luaClient = context.getLuaClient();
  if (!luaClient) {
    throw new Error("Lua bridge not active. Use lua_start and lua_load_build first.");
  }

  const formatted = configGame() === 'poe2'
    ? formatNativeConfig(await new ConfigService(luaClient).read())
    : formatConfigOutput(await luaClient.getConfig());

  return {
    content: [
      {
        type: "text" as const,
        text: formatted,
      },
    ],
  };
  });
}

/**
 * Handle set_config tool call
 */
export async function handleSetConfig(
  context: ConfigHandlerContext,
  args: SetConfigArgs
) {
  return wrapHandler('set config', async () => {
  if (configGame() === 'poe2') {
    const patch=explicitConfigPatch(args);
    const client=await nativeClient(context);
    const result=await new ConfigService(client).apply(patch);
    let text=nativeWriteSummary(result.before,result.after,result.patch);
    const metrics=await optionalStats(client);
    if(metrics.error) text+=`\nStats unavailable: ${metrics.error}`;
    else if(metrics.stats) {
      for(const key of ['CombinedDPS','TotalDPS','Life','EnergyShield']) {
        const value=metrics.stats[key];if(typeof value==='number' && Number.isFinite(value))text+=`\n${key}: ${value}`;
      }
    }
    return {content:[{type:'text' as const,text}]};
  }
  if (typeof args.config_name !== 'string' || args.value === undefined || args.config !== undefined) throw new Error('PoE1 requires config_name and value');
  await context.ensureLuaClient();
  const luaClient = context.getLuaClient();
  if (!luaClient) {
    throw new Error("Lua bridge not active. Use lua_start and lua_load_build first.");
  }

  // Get current config to show before/after
  const currentConfig = await luaClient.getConfig();
  const oldValue = currentConfig[args.config_name];

  // Set new value - build params object dynamically
  const params: Record<string, any> = {};
  params[args.config_name] = args.value;
  await luaClient.setConfig(params);

  // Read back and VERIFY the value actually landed. Reporting the requested value without
  // checking made unsupported options look like they applied while PoB silently ignored
  // them — sims then ran on stale config and nobody could tell.
  const afterConfig = await luaClient.getConfig();
  const storedValue = afterConfig?.[args.config_name];
  const matches =
    storedValue === args.value ||
    String(storedValue) === String(args.value) ||
    (typeof storedValue === "boolean" && storedValue === (args.value === true || args.value === "true"));

  // Get updated stats
  const newStats = await luaClient.getStats(['TotalDPS', 'CombinedDPS', 'Life', 'EnergyShield']);

  let output = matches ? `=== Configuration Updated ===\n\n` : `=== ⚠ Configuration NOT applied ===\n\n`;
  output += `${args.config_name}:\n`;
  output += `  Old Value: ${formatValue(oldValue)}\n`;
  output += `  Requested: ${formatValue(args.value)}\n`;
  output += `  Stored:    ${formatValue(storedValue)}\n`;
  if (!matches) {
    output += `\n⚠ PoB did not store the requested value — do NOT trust any simulation that assumes it applied.\n`;
    output += `  Check the option name against PoB's Config tab (it must match the internal var name).\n`;
  }
  output += `\n`;

  if (newStats.TotalDPS) {
    output += `=== Current Stats ===\n`;
    output += `Total DPS: ${formatNumber(newStats.TotalDPS)}\n`;
    if (newStats.Life) output += `Life: ${formatNumber(newStats.Life)}\n`;
    if (newStats.EnergyShield) output += `Energy Shield: ${formatNumber(newStats.EnergyShield)}\n`;
  }

  return {
    content: [
      {
        type: "text" as const,
        text: output,
      },
    ],
  };
  });
}

/**
 * Handle set_pob_view tool call — switch the visible PoB GUI tab.
 */
export async function handleSetPobView(
  context: ConfigHandlerContext,
  args: { mode: string }
) {
  return wrapHandler('set view', async () => {
    await context.ensureLuaClient();
    const luaClient = context.getLuaClient();
    if (!luaClient) {
      throw new Error("Lua bridge not active (TCP mode + PoB running required).");
    }
    const mode = await luaClient.setViewMode(args.mode);
    return {
      content: [{ type: "text" as const, text: `PoB view switched to the ${mode} tab.` }],
    };
  });
}

/**
 * Handle set_enemy_stats tool call
 */
export async function handleSetEnemyStats(
  context: ConfigHandlerContext,
  args: {
    level?: number;
    fire_resist?: number;
    cold_resist?: number;
    lightning_resist?: number;
    chaos_resist?: number;
    armor?: number;
    evasion?: number;
  }
) {
  return wrapHandler('set enemy stats', async () => {
  if (configGame() === 'poe2') {
    // Verified against ConfigOptions: these are the native count/countAllowZero keys.
    const names: Record<string,string>={level:'enemyLevel',fire_resist:'enemyFireResist',cold_resist:'enemyColdResist',
      lightning_resist:'enemyLightningResist',chaos_resist:'enemyChaosResist',armor:'enemyArmour',evasion:'enemyEvasion'};
    const patch:ConfigInput={};
    for(const [key,value] of Object.entries(args)) {
      if(!names[key])throw new Error(`Unknown enemy parameter: ${key}`);
      if(value===undefined)continue;
      if(typeof value!=='number' || !Number.isInteger(value) || value<0)throw new Error(`${key} must be a nonnegative integer`);
      patch[names[key]]=value;
    }
    validateConfigPatch(patch);
    const client=await nativeClient(context);
    const previous=await optionalStats(client);
    const result=await new ConfigService(client).apply(patch);
    const current=await optionalStats(client);
    let text=nativeWriteSummary(result.before,result.after,result.patch);
    const metric=['CombinedDPS','TotalDPS'].find(key=>typeof previous.stats?.[key]==='number' && Number.isFinite(previous.stats[key]) && typeof current.stats?.[key]==='number' && Number.isFinite(current.stats[key]));
    if(metric)text+=`\n${metric}: ${previous.stats![metric]} → ${current.stats![metric]}`;
    else text+='\nDPS comparison unavailable.';
    if(previous.error)text+=`\nPrevious stats unavailable: ${previous.error}`;
    if(current.error)text+=`\nCurrent stats unavailable: ${current.error}`;
    return {content:[{type:'text' as const,text}]};
  }
  await context.ensureLuaClient();
  const luaClient = context.getLuaClient();
  if (!luaClient) {
    throw new Error("Lua bridge not active. Use lua_start and lua_load_build first.");
  }

  // Get current DPS before changes
  const oldStats = await luaClient.getStats(['TotalDPS', 'CombinedDPS', 'Life', 'EnergyShield']);

  // Build config update params
  const params: Record<string, any> = {};
  const changesSummary: Array<{key: string; old: any; new: any}> = [];

  if (args.level !== undefined) {
    changesSummary.push({ key: "Enemy Level", old: 84, new: args.level });
    params.enemyLevel = args.level;
  }
  if (args.fire_resist !== undefined) {
    changesSummary.push({ key: "Fire Resist", old: 40, new: args.fire_resist });
    params.enemyFireResist = args.fire_resist;
  }
  if (args.cold_resist !== undefined) {
    changesSummary.push({ key: "Cold Resist", old: 40, new: args.cold_resist });
    params.enemyColdResist = args.cold_resist;
  }
  if (args.lightning_resist !== undefined) {
    changesSummary.push({ key: "Lightning Resist", old: 40, new: args.lightning_resist });
    params.enemyLightningResist = args.lightning_resist;
  }
  if (args.chaos_resist !== undefined) {
    changesSummary.push({ key: "Chaos Resist", old: 20, new: args.chaos_resist });
    params.enemyChaosResist = args.chaos_resist;
  }
  if (args.armor !== undefined) {
    changesSummary.push({ key: "Armor", old: 0, new: args.armor });
    params.enemyArmour = args.armor;
  }
  if (args.evasion !== undefined) {
    changesSummary.push({ key: "Evasion", old: 0, new: args.evasion });
    params.enemyEvasion = args.evasion;
  }

  // Apply changes
  await luaClient.setConfig(params);

  // Get updated stats
  const newStats = await luaClient.getStats(['TotalDPS', 'CombinedDPS', 'Life', 'EnergyShield']);

  // Format output
  let output = `=== Enemy Configuration Updated ===\n\n`;

  for (const change of changesSummary) {
    const suffix = change.key.includes("Resist") ? "%" : "";
    output += `${change.key}: ${change.old}${suffix} → ${change.new}${suffix}\n`;
  }

  output += `\n=== DPS Update ===\n`;
  const oldDPS = oldStats.TotalDPS || 0;
  const newDPS = newStats.TotalDPS || 0;
  const percentChange = oldDPS > 0 ? ((newDPS - oldDPS) / oldDPS * 100) : 0;

  output += `Previous DPS: ${formatNumber(oldDPS)}\n`;
  output += `New DPS: ${formatNumber(newDPS)}`;

  if (percentChange !== 0) {
    const sign = percentChange > 0 ? "+" : "";
    output += ` (${sign}${percentChange.toFixed(1)}%)\n`;
  } else {
    output += "\n";
  }

  // Add interpretation
  if (percentChange < -10) {
    output += `\n💡 Enemy configuration significantly reduced DPS. Consider:\n`;
    output += `   - Increasing penetration\n`;
    output += `   - Using exposure/curse\n`;
    output += `   - Checking resistance reduction effects\n`;
  } else if (percentChange > 10) {
    output += `\nDPS increased against this enemy configuration.\n`;
  }

  return {
    content: [
      {
        type: "text" as const,
        text: output,
      },
    ],
  };
  });
}

/**
 * Format configuration output
 */
function formatConfigOutput(config: any): string {
  if (!config || typeof config !== 'object') {
    return "=== Configuration State ===\n\nNo configuration data available.\n";
  }

  let output = "=== Configuration State ===\n\n";

  // Build settings
  output += "=== Build Settings ===\n";
  output += `Bandit: ${config.bandit || 'None'}\n`;
  output += `Pantheon Major God: ${config.pantheonMajorGod || 'None'}\n`;
  output += `Pantheon Minor God: ${config.pantheonMinorGod || 'None'}\n`;

  // Enemy settings
  output += "\n=== Enemy Settings ===\n";
  output += `Enemy Level: ${config.enemyLevel ?? 84}\n`;
  if (config.enemyFireResist != null)      output += `Fire Resist: ${config.enemyFireResist}%\n`;
  if (config.enemyColdResist != null)      output += `Cold Resist: ${config.enemyColdResist}%\n`;
  if (config.enemyLightningResist != null) output += `Lightning Resist: ${config.enemyLightningResist}%\n`;
  if (config.enemyChaosResist != null)     output += `Chaos Resist: ${config.enemyChaosResist}%\n`;
  if (config.enemyArmour != null)          output += `Armour: ${config.enemyArmour}\n`;
  if (config.enemyIsBoss != null)          output += `Is Boss: ${config.enemyIsBoss}\n`;

  // Charges
  const chargeFields = [
    ['usePowerCharges', 'Power Charges'],
    ['useFrenzyCharges', 'Frenzy Charges'],
    ['useEnduranceCharges', 'Endurance Charges'],
    ['useSiphoningCharges', 'Siphoning Charges'],
  ] as const;
  const activeCharges = chargeFields.filter(([key]) => config[key]);
  if (activeCharges.length > 0) {
    output += "\n=== Active Charges ===\n";
    for (const [, label] of activeCharges) {
      output += `${label}: enabled\n`;
    }
  }

  // Active conditions
  const conditionFields = Object.entries(config).filter(
    ([key, val]) => key.startsWith('condition') && val === true
  );
  if (conditionFields.length > 0) {
    output += "\n=== Active Conditions ===\n";
    for (const [key] of conditionFields) {
      output += `${key.replace('condition', '')}: true\n`;
    }
  }

  // Active buffs
  const buffFields = Object.entries(config).filter(
    ([key, val]) => key.startsWith('buff') && val === true
  );
  if (buffFields.length > 0) {
    output += "\n=== Active Buffs ===\n";
    for (const [key] of buffFields) {
      output += `${key.replace('buff', '')}: true\n`;
    }
  }

  // Any remaining non-null, non-false keys not already shown
  const knownKeys = new Set([
    'bandit', 'pantheonMajorGod', 'pantheonMinorGod',
    'enemyLevel', 'enemyFireResist', 'enemyColdResist', 'enemyLightningResist',
    'enemyChaosResist', 'enemyArmour', 'enemyIsBoss',
    'usePowerCharges', 'useFrenzyCharges', 'useEnduranceCharges', 'useSiphoningCharges',
  ]);
  const extra = Object.entries(config).filter(
    ([key, val]) =>
      !knownKeys.has(key) &&
      !key.startsWith('condition') &&
      !key.startsWith('buff') &&
      val != null && val !== false
  );
  if (extra.length > 0) {
    output += "\n=== Other Settings ===\n";
    for (const [key, val] of extra) {
      output += `${key}: ${val}\n`;
    }
  }

  output += "\n💡 Use set_config to modify values  |  set_enemy_stats to adjust enemy parameters\n";

  return output;
}

/**
 * Format a value for display
 */
function formatValue(value: any): string {
  if (typeof value === 'boolean') {
    return value ? 'Yes' : 'No';
  }
  if (typeof value === 'number') {
    return formatNumber(value);
  }
  return String(value);
}

/**
 * Format a number with thousands separators
 */
function formatNumber(num: number): string {
  return Math.round(num).toLocaleString();
}
