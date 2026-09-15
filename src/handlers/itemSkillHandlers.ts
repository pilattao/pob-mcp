import type { AnyLuaClient } from "../pobLuaBridge.js";
import { wrapHandler } from "../utils/errorHandling.js";
import { parseItemRawMods } from "../utils/itemRawParser.js";
import { parseItemSockets } from "../utils/itemSocketParser.js";

export interface ItemSkillHandlerContext {
  getLuaClient: () => AnyLuaClient | null;
  ensureLuaClient: () => Promise<void>;
}

export async function handleAddItem(
  context: ItemSkillHandlerContext,
  itemText: string,
  slotName?: string,
  noAutoEquip?: boolean
) {
  return wrapHandler('add item', async () => {
    await context.ensureLuaClient();

    const luaClient = context.getLuaClient();
    if (!luaClient) {
      throw new Error('Lua client not initialized. Use lua_start first.');
    }

    if (!itemText || itemText.trim().length === 0) {
      throw new Error('item_text cannot be empty');
    }

    const result = await luaClient.addItem(itemText, slotName, noAutoEquip);

    const text = `✅ Item added: ${result.name || 'Unknown'} → ${result.slot || 'Not equipped'}`;

    return {
      content: [
        {
          type: "text" as const,
          text,
        },
      ],
    };
  });
}

export async function handleClearItemSlot(
  context: ItemSkillHandlerContext,
  slotName: string
) {
  return wrapHandler('clear item slot', async () => {
    await context.ensureLuaClient();

    const luaClient = context.getLuaClient();
    if (!luaClient) {
      throw new Error('Lua client not initialized. Use lua_start first.');
    }

    if (!slotName || slotName.trim().length === 0) {
      throw new Error('slot_name cannot be empty');
    }

    const result = await luaClient.clearItemSlot(slotName);

    const text = `Item slot ${result.slot} cleared.`;

    return {
      content: [
        {
          type: 'text' as const,
          text,
        },
      ],
    };
  });
}

export async function handleGetEquippedItems(context: ItemSkillHandlerContext) {
  return wrapHandler('get equipped items', async () => {
    await context.ensureLuaClient();

    const luaClient = context.getLuaClient();
    if (!luaClient) {
      throw new Error('Lua client not initialized. Use lua_start first.');
    }

    const items = await luaClient.getItems();

    let text = "=== Equipped Items ===\n\n";

    if (!items || items.length === 0) {
      text += "No items equipped.\n";
    } else {
      const equipped = items.filter((item: any) => item.id !== 0 && item.name);
      if (equipped.length === 0) {
        text += "No items equipped.\n";
      } else {
        for (const item of equipped) {
          text += `**${item.slot}**\n`;
          text += `  ${item.name}`;
          if (item.baseName && item.baseName !== item.name) {
            text += ` (${item.baseName})`;
          }
          text += `\n`;
          if (item.rarity) {
            text += `  Rarity: ${item.rarity}\n`;
          }
          if (item.active !== undefined && /^(Flask|Charm) \d+$/.test(item.slot)) {
            text += `  Active: ${item.active ? 'Yes' : 'No'}\n`;
          }
          const mods = parseItemRawMods(item.raw);
          if (mods.length > 0) {
            const enchants = mods.filter(m => m.type === 'enchant');
            const implicits = mods.filter(m => m.type === 'implicit');
            const explicits = mods.filter(m => !['enchant', 'implicit'].includes(m.type));
            if (enchants.length > 0) {
              text += `  Enchant: ${enchants.map(m => m.line).join(' | ')}\n`;
            }
            if (implicits.length > 0) {
              text += `  Implicit: ${implicits.map(m => m.line).join(' | ')}\n`;
            }
            if (explicits.length > 0) {
              text += `  Mods:\n`;
              for (const m of explicits) {
                const tag = m.type !== 'explicit' ? ` [${m.type}]` : '';
                text += `    - ${m.line}${tag}\n`;
              }
            }
          }
          text += "\n";
        }
      }
    }

    return {
      content: [
        {
          type: "text" as const,
          text,
        },
      ],
    };
  });
}

export async function handleGetSocketColors(context: ItemSkillHandlerContext) {
  return wrapHandler('get socket colors', async () => {
    await context.ensureLuaClient();

    const luaClient = context.getLuaClient();
    if (!luaClient) {
      throw new Error('Lua client not initialized. Use lua_start first.');
    }

    const items = await luaClient.getItems();
    const equipped = (items || []).filter((it: any) => it.id !== 0 && it.name);
    const socketed = equipped
      .map((it: any) => ({ it, sockets: parseItemSockets(it.raw) }))
      .filter((e: any) => e.sockets);

    let text = "=== Socket Colours ===\n\n";

    if (socketed.length === 0) {
      text += "No socketed items on the loaded build.\n";
    } else {
      const ORDER = ['R', 'G', 'B', 'W', 'A'] as const;
      for (const { it, sockets } of socketed) {
        if (!sockets) continue;
        // Dash = linked, double-space = separate group (mirrors PoB's own layout).
        const layout = sockets.groups.map((g: string[]) => g.join('-')).join('  ');
        const counts = ORDER
          .filter((c) => sockets.colorCounts[c] > 0)
          .map((c) => `${sockets.colorCounts[c]}${c}`)
          .join(' ');
        const groupSizes = sockets.groups.map((g: string[]) => g.length);
        const linkNote = groupSizes.length === 1
          ? (sockets.maxLink >= 2 ? `${sockets.maxLink}-link` : `${sockets.total} socket${sockets.total === 1 ? '' : 's'}`)
          : `groups ${groupSizes.join('/')} (max ${sockets.maxLink}-link)`;

        text += `**${it.slot}** — ${it.name}\n`;
        text += `  Layout:  ${layout}\n`;
        text += `  ${sockets.total} socket${sockets.total === 1 ? '' : 's'}, ${linkNote}\n`;
        text += `  Colours: ${counts}`;
        if (sockets.abyssal > 0) text += ` (${sockets.abyssal} abyssal)`;
        text += "\n\n";
      }
    }

    return {
      content: [
        {
          type: "text" as const,
          text,
        },
      ],
    };
  });
}

export async function handleToggleFlask(
  context: ItemSkillHandlerContext,
  flaskNumber: number | undefined,
  active: boolean,
  slotName?: string
) {
  return wrapHandler('toggle flask', async () => {
    const poe2 = process.env.POE_GAME === 'poe2';
    if (typeof active !== 'boolean') throw new Error('active must be a boolean');
    if ((flaskNumber !== undefined) === (slotName !== undefined)) {
      throw new Error('Provide exactly one of flask_number or slotName');
    }
    if (slotName !== undefined) {
      if (!poe2 || typeof slotName !== 'string' || !/^(Flask [12]|Charm [123])$/.test(slotName)) {
        throw new Error('slotName must be a PoE2 Flask 1/2 or Charm 1/2/3 slot');
      }
    } else if (!Number.isInteger(flaskNumber) || flaskNumber! < 1 || flaskNumber! > (poe2 ? 2 : 5)) {
      throw new Error(`flask_number must be an integer between 1 and ${poe2 ? 2 : 5}`);
    }
    await context.ensureLuaClient();

    const luaClient = context.getLuaClient();
    if (!luaClient) {
      throw new Error('Lua client not initialized. Use lua_start first.');
    }

    await luaClient.setFlaskActive(flaskNumber, active, slotName);

    let text = `✅ ${slotName ?? `Flask ${flaskNumber}`} ${active ? 'activated' : 'deactivated'}.`;

    // Return updated key defensive stats so the effect is visible immediately
    try {
      const stats = await luaClient.getStats([
        'Life', 'Armour', 'Evasion', 'EnergyShield',
        'FireResist', 'ColdResist', 'LightningResist', 'ChaosResist',
        'PhysicalDamageReduction', 'ManaUnreserved',
      ]);
      const fmt = (v: any) => v != null ? String(v) : '-';
      text += `\n\nUpdated stats:\n`;
      text += `  Life: ${fmt(stats.Life)}  |  Armour: ${fmt(stats.Armour)}  |  Evasion: ${fmt(stats.Evasion)}\n`;
      text += `  Fire: ${fmt(stats.FireResist)}%  Cold: ${fmt(stats.ColdResist)}%  Lightning: ${fmt(stats.LightningResist)}%  Chaos: ${fmt(stats.ChaosResist)}%\n`;
      if (stats.PhysicalDamageReduction != null) {
        text += `  PDR: ${fmt(stats.PhysicalDamageReduction)}%\n`;
      }
    } catch {}

    return {
      content: [
        {
          type: "text" as const,
          text,
        },
      ],
    };
  });
}

export async function handleGetSkillSetup(context: ItemSkillHandlerContext, mainOnly: boolean = true) {
  return wrapHandler('get skill setup', async () => {
    await context.ensureLuaClient();

    const luaClient = context.getLuaClient();
    if (!luaClient) {
      throw new Error('Lua client not initialized. Use lua_start first.');
    }

    const skillData = await luaClient.getSkills();

    if (!skillData || typeof skillData !== 'object') {
      throw new Error('No build loaded. Use lua_load_build or lua_new_build first.');
    }

    let text = "=== Skill Setup ===\n\n";
    text += `Main Socket Group: ${skillData.mainSocketGroup || 'None'}\n\n`;

    if (!skillData.groups || skillData.groups.length === 0) {
      text += "No skill groups found.\n";
    } else {
      const totalGroups = skillData.groups.length;
      const groups = mainOnly
        ? skillData.groups.filter((g: any) => g.index === skillData.mainSocketGroup)
        : skillData.groups;

      if (mainOnly && totalGroups > 1) {
        text += `(Showing main skill group only. Use main_only=false to see all ${totalGroups} groups.)\n\n`;
      }

      for (const group of groups) {
        const isMain = group.index === skillData.mainSocketGroup;
        text += `**Group ${group.index}${isMain ? ' (MAIN)' : ''}**\n`;
        if (group.label) {
          text += `  Label: ${group.label}\n`;
        }
        if (group.slot) {
          text += `  Slot: ${group.slot}\n`;
        }
        text += `  Enabled: ${group.enabled ? 'Yes' : 'No'}\n`;
        text += `  Contributes to Full DPS: ${group.includeInFullDPS ? 'Yes' : 'No'}\n`;
        if (group.mainActiveSkill) {
          text += `  Main Active Skill Index: ${group.mainActiveSkill}\n`;
        }
        if (group.skills && group.skills.length > 0) {
          text += `  Active Skills: ${group.skills.join(', ')}\n`;
        }
        if (group.gems && group.gems.length > 0) {
          text += `  Gems (${group.gems.length}):\n`;
          for (const gem of group.gems) {
            const lvlQual = `${gem.level}/${gem.quality}`;
            const typeTag = gem.is_support ? ' [support]' : '';
            const disabledTag = gem.enabled === false ? ' [disabled]' : '';
            text += `    ${gem.index}. ${gem.name} (${lvlQual})${typeTag}${disabledTag}\n`;
          }
        }
        text += "\n";
      }
    }

    return {
      content: [
        {
          type: "text" as const,
          text,
        },
      ],
    };
  });
}

export async function handleSetMainSkill(
  context: ItemSkillHandlerContext,
  socketGroup: number,
  activeSkillIndex?: number,
  skillPart?: number,
  statSet?: number
) {
  return wrapHandler('set main skill', async () => {
    for (const [name, value] of [['group_index', socketGroup], ['active_skill_index', activeSkillIndex], ['skill_part', skillPart], ['stat_set', statSet]] as const) {
      if ((name === 'group_index' || value !== undefined) && (!Number.isInteger(value) || value! < 1)) {
        throw new Error(`${name} must be a positive integer`);
      }
    }
    if (statSet !== undefined && process.env.POE_GAME !== 'poe2') {
      throw new Error('stat_set requires PoE2 mode');
    }
    await context.ensureLuaClient();

    const luaClient = context.getLuaClient();
    if (!luaClient) {
      throw new Error('Lua client not initialized. Use lua_start first.');
    }

    await luaClient.setMainSelection({
      mainSocketGroup: socketGroup,
      mainActiveSkill: activeSkillIndex,
      skillPart,
      ...(statSet === undefined ? {} : { statSet }),
    });

    let text = `✅ Main skill set to group ${socketGroup}`;
    if (activeSkillIndex !== undefined) {
      text += `, skill ${activeSkillIndex}`;
    }
    if (skillPart !== undefined) {
      text += `, part ${skillPart}`;
    }
    if (statSet !== undefined) text += `, stat set ${statSet}`;
    text += `.`;

    return {
      content: [
        {
          type: "text" as const,
          text,
        },
      ],
    };
  });
}

export async function handleCreateSocketGroup(
  context: ItemSkillHandlerContext,
  label?: string,
  slot?: string,
  enabled?: boolean,
  includeInFullDPS?: boolean
) {
  return wrapHandler('create socket group', async () => {
    await context.ensureLuaClient();

    const luaClient = context.getLuaClient();
    if (!luaClient) {
      throw new Error('Lua client not initialized. Use lua_start first.');
    }

    const result = await luaClient.createSocketGroup({
      label,
      slot,
      enabled,
      includeInFullDPS,
    });

    let text = `✅ Socket group ${result.index} created`;
    if (label) {
      text += ` (${label})`;
    }
    text += `.`;

    return {
      content: [
        {
          type: "text" as const,
          text,
        },
      ],
    };
  });
}

export async function handleAddGem(
  context: ItemSkillHandlerContext,
  groupIndex: number,
  gemName: string,
  level?: number,
  quality?: number,
  qualityId?: string,
  enabled?: boolean
) {
  return wrapHandler('add gem', async () => {
    await context.ensureLuaClient();

    const luaClient = context.getLuaClient();
    if (!luaClient) {
      throw new Error('Lua client not initialized. Use lua_start first.');
    }

    if (groupIndex < 1) {
      throw new Error('group_index must be >= 1');
    }

    if (!gemName || gemName.trim().length === 0) {
      throw new Error('gem_name cannot be empty');
    }

    const result = await luaClient.addGem({
      groupIndex,
      gemName,
      level,
      quality,
      qualityId,
      enabled,
    });

    let text = `✅ Added ${result.name} (L${level || 20}, Q${quality || 0}) to group ${groupIndex}.`;

    return {
      content: [
        {
          type: "text" as const,
          text,
        },
      ],
    };
  });
}

export async function handleSetGemLevel(
  context: ItemSkillHandlerContext,
  groupIndex: number,
  gemIndex: number,
  level: number
) {
  return wrapHandler('set gem level', async () => {
    await context.ensureLuaClient();

    const luaClient = context.getLuaClient();
    if (!luaClient) {
      throw new Error('Lua client not initialized. Use lua_start first.');
    }

    if (groupIndex < 1) {
      throw new Error('group_index must be >= 1');
    }

    if (gemIndex < 1) {
      throw new Error('gem_index must be >= 1');
    }

    if (level < 1 || level > 40) {
      throw new Error('level must be between 1 and 40');
    }

    await luaClient.setGemLevel({ groupIndex, gemIndex, level });

    let text = `✅ Set gem level to ${level} (group ${groupIndex}, gem ${gemIndex}).`;

    return {
      content: [
        {
          type: "text" as const,
          text,
        },
      ],
    };
  });
}

export async function handleSetGemQuality(
  context: ItemSkillHandlerContext,
  groupIndex: number,
  gemIndex: number,
  quality: number,
  qualityId?: string
) {
  return wrapHandler('set gem quality', async () => {
    await context.ensureLuaClient();

    const luaClient = context.getLuaClient();
    if (!luaClient) {
      throw new Error('Lua client not initialized. Use lua_start first.');
    }

    if (groupIndex < 1) {
      throw new Error('group_index must be >= 1');
    }

    if (gemIndex < 1) {
      throw new Error('gem_index must be >= 1');
    }

    if (quality < 0 || quality > 30) {
      throw new Error('quality must be between 0 and 30');
    }

    await luaClient.setGemQuality({ groupIndex, gemIndex, quality, qualityId });

    let text = `✅ Set gem quality to ${quality}${qualityId && qualityId !== 'Default' ? ` (${qualityId})` : ''} (group ${groupIndex}, gem ${gemIndex}).`;

    return {
      content: [
        {
          type: "text" as const,
          text,
        },
      ],
    };
  });
}

export async function handleRemoveSkill(
  context: ItemSkillHandlerContext,
  groupIndex: number
) {
  return wrapHandler('remove skill group', async () => {
    await context.ensureLuaClient();

    const luaClient = context.getLuaClient();
    if (!luaClient) {
      throw new Error('Lua client not initialized. Use lua_start first.');
    }

    if (groupIndex < 1) {
      throw new Error('group_index must be >= 1');
    }

    await luaClient.removeSkill({ groupIndex });

    let text = `✅ Removed socket group ${groupIndex}.`;

    return {
      content: [
        {
          type: "text" as const,
          text,
        },
      ],
    };
  });
}

export async function handleRemoveGem(
  context: ItemSkillHandlerContext,
  groupIndex: number,
  gemIndex: number
) {
  return wrapHandler('remove gem', async () => {
    await context.ensureLuaClient();

    const luaClient = context.getLuaClient();
    if (!luaClient) {
      throw new Error('Lua client not initialized. Use lua_start first.');
    }

    if (groupIndex < 1) {
      throw new Error('group_index must be >= 1');
    }

    if (gemIndex < 1) {
      throw new Error('gem_index must be >= 1');
    }

    await luaClient.removeGem({ groupIndex, gemIndex });

    let text = `✅ Removed gem ${gemIndex} from group ${groupIndex}.`;

    return {
      content: [
        {
          type: "text" as const,
          text,
        },
      ],
    };
  });
}

export async function handleSetSocketGroupEnabled(
  context: ItemSkillHandlerContext,
  groupIndex: number,
  enabled: boolean,
  includeInFullDPS?: boolean,
  count?: number
) {
  return wrapHandler('set socket group enabled', async () => {
    await context.ensureLuaClient();

    const luaClient = context.getLuaClient();
    if (!luaClient) {
      throw new Error('Lua client not initialized. Use lua_start first.');
    }

    if (groupIndex < 1) {
      throw new Error('group_index must be >= 1');
    }

    const result = await luaClient.setSocketGroupEnabled({ groupIndex, enabled, includeInFullDPS, count });

    const label = result?.label ? ` (${result.label})` : '';
    const state = enabled ? 'enabled' : 'disabled';
    // Report what PoB stored, not what was asked for — minion swarm DPS silently reads as 0
    // when the Full-DPS flag or Count didn't actually land.
    const extras: string[] = [];
    if (includeInFullDPS !== undefined) {
      extras.push(`Include in Full DPS: ${result?.includeInFullDPS ? 'on' : 'off'}`);
    }
    if (count !== undefined) {
      extras.push(`Count: ${result?.count ?? '(unset)'}`);
    }
    const text =
      `✅ Group ${groupIndex}${label} ${state}.` +
      (extras.length > 0 ? ` ${extras.join(' · ')}` : '');

    return {
      content: [{ type: "text" as const, text }],
    };
  });
}

export async function handleSetGemEnabled(
  context: ItemSkillHandlerContext,
  groupIndex: number,
  gemIndex: number,
  enabled: boolean
) {
  return wrapHandler('set gem enabled', async () => {
    await context.ensureLuaClient();

    const luaClient = context.getLuaClient();
    if (!luaClient) {
      throw new Error('Lua client not initialized. Use lua_start first.');
    }

    if (groupIndex < 1) throw new Error('group_index must be >= 1');
    if (gemIndex < 1) throw new Error('gem_index must be >= 1');

    await luaClient.setGemEnabled({ groupIndex, gemIndex, enabled });

    const state = enabled ? 'enabled' : 'disabled';
    const text = `✅ Gem ${gemIndex} in group ${groupIndex} ${state}.`;

    return {
      content: [{ type: "text" as const, text }],
    };
  });
}

export async function handleListSpectres(
  context: ItemSkillHandlerContext,
  search?: string
) {
  return wrapHandler('list spectres', async () => {
    await context.ensureLuaClient();

    const luaClient = context.getLuaClient();
    if (!luaClient) {
      throw new Error('Lua client not initialized. Use lua_start first.');
    }

    const result = await luaClient.listSpectres({ search });

    const poe2 = process.env.POE_GAME === 'poe2';
    const parts: string[] = [];
    if (result.active.length === 0) {
      parts.push(poe2 ? 'No spectre gem selections in the active skill set.' : 'No spectres set on this build (Raise Spectre simulates generic spectres until some are).');
    } else {
      parts.push(`${poe2 ? 'Spectre gem selections' : 'Active spectres'} (${result.active.length}):`);
      for (const s of result.active) {
        const selection = poe2 ? ` — group ${s.groupIndex}, gem ${s.gemIndex}${s.enabled === false ? ' (disabled)' : ''}` : '';
        parts.push(`  - ${s.name} (${s.id})${selection}`);
      }
    }
    if (result.search_results) {
      parts.push('');
      parts.push(`Library matches for "${search}" (${result.search_results.length}):`);
      for (const s of result.search_results.slice(0, 30)) parts.push(`  - ${s.name} (${s.id})`);
      if (result.search_results.length > 30) parts.push(`  ... ${result.search_results.length - 30} more`);
    }

    return {
      content: [{ type: "text" as const, text: parts.join('\n') }],
    };
  });
}

export async function handleSetSpectres(
  context: ItemSkillHandlerContext,
  spectres: string[],
  mode?: "replace" | "add",
  groupIndex?: number,
  gemIndex?: number
) {
  return wrapHandler('set spectres', async () => {
    const poe2 = process.env.POE_GAME === 'poe2';
    if (!Array.isArray(spectres) || spectres.length === 0 || spectres.some(s => typeof s !== 'string' || !s.trim())) {
      throw new Error('spectres must be a non-empty array of names or metadata ids');
    }
    if (mode !== undefined && mode !== 'replace' && mode !== 'add') throw new Error('invalid spectre mode');
    if (poe2 && (spectres.length !== 1 || (mode !== undefined && mode !== 'replace') ||
        !Number.isInteger(groupIndex) || groupIndex! < 1 || !Number.isInteger(gemIndex) || gemIndex! < 1)) {
      throw new Error('PoE2 selects exactly one spectre per gem: positive group_index and gem_index, mode replace');
    }
    await context.ensureLuaClient();

    const luaClient = context.getLuaClient();
    if (!luaClient) {
      throw new Error('Lua client not initialized. Use lua_start first.');
    }

    const result = await luaClient.setSpectres({ spectres, ...(mode === undefined ? {} : { mode }), ...(poe2 ? { groupIndex, gemIndex } : {}) });

    const names = result.active.map((s) => s.name).join(', ');
    const text = poe2 ? `✅ Spectre selected for group ${groupIndex}, gem ${gemIndex}: ${names}.` :
      `✅ Spectre list ${mode === 'add' ? 'extended' : 'replaced'}. Active: ${names || '(none)'}.\n` +
      `Note: spectres persist across character imports (the PoE API never reports them) — ` +
      `re-run this only when the in-game zoo changes.`;

    return {
      content: [{ type: "text" as const, text }],
    };
  });
}

export async function handleSetupSkillWithGems(
  context: ItemSkillHandlerContext,
  gems: Array<{
    name: string;
    level?: number;
    quality?: number;
    quality_id?: string;
    enabled?: boolean;
  }>,
  label?: string,
  slot?: string,
  enabled?: boolean,
  includeInFullDPS?: boolean
) {
  return wrapHandler('setup skill with gems', async () => {
    await context.ensureLuaClient();

    const luaClient = context.getLuaClient();
    if (!luaClient) {
      throw new Error('Lua client not initialized. Use lua_start first.');
    }

    if (!gems || gems.length === 0) {
      throw new Error('gems array cannot be empty');
    }

    // Create socket group
    const groupResult = await luaClient.createSocketGroup({
      label,
      slot,
      enabled,
      includeInFullDPS,
    });

    // Add all gems to the group
    const addedGems: string[] = [];
    for (const gem of gems) {
      if (!gem.name || gem.name.trim().length === 0) {
        throw new Error('gem name cannot be empty');
      }

      const result = await luaClient.addGem({
        groupIndex: groupResult.index,
        gemName: gem.name,
        level: gem.level,
        quality: gem.quality,
        qualityId: gem.quality_id,
        enabled: gem.enabled,
      });

      addedGems.push(`${result.name} (L${gem.level || 20}, Q${gem.quality || 0})`);
    }

    let text = `✅ Created socket group ${groupResult.index}`;
    if (label) {
      text += ` "${label}"`;
    }
    text += ` with ${addedGems.length} gem${addedGems.length > 1 ? 's' : ''}:\n`;
    text += addedGems.map(g => `  - ${g}`).join('\n');

    return {
      content: [
        {
          type: "text" as const,
          text,
        },
      ],
    };
  });
}

export async function handleAddMultipleItems(
  context: ItemSkillHandlerContext,
  items: Array<{
    item_text: string;
    slot_name?: string;
  }>
) {
  return wrapHandler('add multiple items', async () => {
    await context.ensureLuaClient();

    const luaClient = context.getLuaClient();
    if (!luaClient) {
      throw new Error('Lua client not initialized. Use lua_start first.');
    }

    if (!items || items.length === 0) {
      throw new Error('items array cannot be empty');
    }

    const addedItems: string[] = [];
    for (const item of items) {
      if (!item.item_text || item.item_text.trim().length === 0) {
        throw new Error('item_text cannot be empty');
      }

      const result = await luaClient.addItem(item.item_text, item.slot_name);
      addedItems.push(`${result.name || 'Unknown'} → ${result.slot || 'Not equipped'}`);
    }

    let text = `✅ Added ${addedItems.length} item${addedItems.length > 1 ? 's' : ''}:\n`;
    text += addedItems.map(i => `  - ${i}`).join('\n');

    return {
      content: [
        {
          type: "text" as const,
          text,
        },
      ],
    };
  });
}
