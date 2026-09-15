import type { AnyLuaClient } from "../pobLuaBridge.js";
import type { BuildIssue, PoBBuild, ValidationIssue } from "../types.js";
import { BuildService } from "../services/buildService.js";
import { ValidationService } from "../services/validationService.js";
import { activeValidationSpec, poe2PassiveBudget, validationStat } from "../services/passiveBudget.js";
import { getPobTreeData } from "../services/pobTreeDataLoader.js";
import { wrapHandler } from "../utils/errorHandling.js";

export interface BuildGoalsHandlerContext {
  getLuaClient: () => AnyLuaClient | null;
  ensureLuaClient: () => Promise<void>;
}

const ISSUES_FIELDS = [
  'Life', 'LifeUnreserved', 'EnergyShield', 'Mana', 'ManaUnreserved',
  'FireResist', 'ColdResist', 'LightningResist', 'ChaosResist',
  'FireResistOverCap', 'ColdResistOverCap', 'LightningResistOverCap',
  'SpellSuppressionChance', 'EffectiveSpellSuppressionChance',
  // DPS fields needed by handleGetPassiveUpgrades for baseDPS scoring
  'TotalDPS', 'CombinedDPS', 'MinionTotalDPS',
  // EHP field needed by handleGetPassiveUpgrades for baseEHP scoring
  'TotalEHP',
];

export async function handleGetBuildIssues(context: BuildGoalsHandlerContext) {
  return wrapHandler('get build issues', async () => {
    const game = (process.env.POE_GAME ?? 'poe2').trim().toLowerCase();
    if (game !== 'poe2' && game !== 'poe1') throw new Error('POE_GAME must be poe2 or poe1');
    await context.ensureLuaClient();
    const luaClient = context.getLuaClient();
    if (!luaClient) throw new Error('Lua bridge not active. Use lua_start and lua_load_build first.');

    if (game === 'poe2') return getPoe2BuildIssues(luaClient);

    const stats = await luaClient.getStats(ISSUES_FIELDS);
    const issues: BuildIssue[] = [];

    // Elemental resistances
    for (const r of ['Fire', 'Cold', 'Lightning'] as const) {
      const val = (stats[`${r}Resist`] as number) ?? 0;
      if (val < 0) {
        issues.push({ severity: 'error', category: 'resistance', message: `${r} resist is ${val}% (negative)` });
      } else if (val < 75) {
        issues.push({ severity: 'warning', category: 'resistance', message: `${r} resist ${val}% — ${75 - val}% short of cap` });
      }
      const over = (stats[`${r}ResistOverCap`] as number) ?? 0;
      if (over > 0) {
        issues.push({ severity: 'info', category: 'resistance', message: `${r} resist ${over}% over max cap (wasted)` });
      }
    }

    const chaos = (stats.ChaosResist as number) ?? 0;
    // Get build level for tiered severity
    let buildLevel = 1;
    try {
      const buildInfo = await luaClient.getBuildInfo();
      buildLevel = buildInfo?.level ?? 1;
    } catch { /* ignore - default to level 1 */ }

    if (buildLevel >= 80 && chaos < -20) {
      issues.push({ severity: 'error', category: 'resistance', message: `Chaos resist is ${chaos}% at level ${buildLevel} — critically low for endgame. Aim for at least 0%, ideally 20%+.` });
    } else if (buildLevel >= 70 && chaos < -30) {
      issues.push({ severity: 'error', category: 'resistance', message: `Chaos resist is ${chaos}% at level ${buildLevel} — dangerously low for maps. Aim for at least -20%.` });
    } else if (chaos < 0) {
      issues.push({ severity: 'warning', category: 'resistance', message: `Chaos resist is ${chaos}%` });
    }

    // Health pools
    const life = (stats.Life as number) ?? 0;
    const es = (stats.EnergyShield as number) ?? 0;
    if (life < 500 && es < 500) {
      issues.push({ severity: 'warning', category: 'survivability', message: `Low health pool — Life: ${life}, ES: ${es}` });
    }

    // Reservation checks
    const lifeUnreserved = (stats.LifeUnreserved as number) ?? life;
    if (lifeUnreserved <= 0) {
      issues.push({ severity: 'error', category: 'reservation', message: 'Unreserved life is 0 or negative' });
    }

    const manaUnreserved = (stats.ManaUnreserved as number) ?? 0;
    if (manaUnreserved < 0) {
      issues.push({ severity: 'error', category: 'reservation', message: `Mana over-reserved by ${Math.abs(manaUnreserved)}` });
    }

    // Spell suppression (only flag if build has any invested; use effective value for cap check)
    const supp = (stats.EffectiveSpellSuppressionChance as number) ?? (stats.SpellSuppressionChance as number) ?? 0;
    if (supp > 0 && supp < 100) {
      issues.push({ severity: 'info', category: 'defence', message: `Spell suppression ${supp}% — not capped at 100%` });
    }

    // Zero DPS check
    const totalDPS = (stats.TotalDPS as number) ?? 0;
    const combinedDPS = (stats.CombinedDPS as number) ?? 0;
    const minionDPS = (stats.MinionTotalDPS as number) ?? 0;
    if (totalDPS === 0 && combinedDPS === 0 && minionDPS === 0) {
      issues.push({ severity: 'error', category: 'gems', message: 'Build does 0 DPS — no main skill selected, gems not linked, or skill not dealing damage. Check skill setup.' });
    }

    // Unspent passive points check
    try {
      const tree = await luaClient.getTree();
      if (tree?.nodes && buildLevel > 1) {
        const totalAllocated = (tree.nodes as any[]).length;
        const ascNodes = tree.ascendancyPointsUsed ?? 0;
        // Subtract: 1 class start + ascendancy start (if ascendancy allocated) + ascendancy nodes
        const regularNodes = totalAllocated - 1 - (ascNodes > 0 ? 1 : 0) - ascNodes;
        // Expected passive points: (level - 1) from leveling + quest rewards
        // Quest rewards: ~24 total by end of Act 10 (level ~68+), scale roughly before that
        const questPoints = buildLevel >= 68 ? 24 : Math.min(24, Math.floor(buildLevel / 3));
        const expectedPoints = (buildLevel - 1) + questPoints;
        const unspent = expectedPoints - regularNodes;
        if (unspent >= 15) {
          issues.push({ severity: 'error', category: 'defence', message: `~${unspent} passive points appear unspent (${regularNodes} regular nodes allocated, ~${expectedPoints} expected at level ${buildLevel}). Allocate remaining points.` });
        } else if (unspent >= 5) {
          issues.push({ severity: 'warning', category: 'defence', message: `~${unspent} passive points appear unspent (${regularNodes} regular nodes allocated, ~${expectedPoints} expected at level ${buildLevel}).` });
        }
      }
    } catch { /* tree check is best-effort */ }

    // Unequipped items & jewels check
    try {
      const items = await luaClient.getItems();
      if (Array.isArray(items)) {
        // Find jewel slots that are empty (id === 0)
        const jewelSlots = items.filter((it: any) => it.slot && /jewel/i.test(it.slot));
        const emptyJewelSlots = jewelSlots.filter((it: any) => !it.id || it.id === 0);
        if (emptyJewelSlots.length > 0) {
          issues.push({
            severity: 'warning',
            category: 'items',
            message: `${emptyJewelSlots.length} jewel socket(s) empty: ${emptyJewelSlots.map((j: any) => j.slot).join(', ')}. Jewels provide significant stats.`,
          });
        }

        // Check for unequipped gear slots
        const gearSlots = ['Weapon 1', 'Body Armour', 'Helmet', 'Gloves', 'Boots', 'Belt', 'Ring 1', 'Ring 2', 'Amulet'];
        for (const slotName of gearSlots) {
          const slot = items.find((it: any) => it.slot === slotName);
          if (slot && (!slot.id || slot.id === 0)) {
            issues.push({
              severity: 'warning',
              category: 'items',
              message: `${slotName} slot is empty — equip an item for more stats.`,
            });
          }
        }

        // Check for empty flask slots
        const flaskSlots = items.filter((it: any) => it.slot && /flask/i.test(it.slot));
        const emptyFlasks = flaskSlots.filter((it: any) => !it.id || it.id === 0);
        if (emptyFlasks.length > 0) {
          issues.push({
            severity: emptyFlasks.length >= 3 ? 'error' : 'warning',
            category: 'items',
            message: `${emptyFlasks.length}/5 flask slot(s) empty. Flasks are a major source of defense and offense.`,
          });
        }
      }
    } catch { /* items check is best-effort */ }

    // Gem coherence check - detect mixed damage scaling
    try {
      const skillsData = await luaClient.getSkills();
      if (skillsData?.groups) {
        for (const group of skillsData.groups as any[]) {
          if (!group.enabled || !group.gems || group.gems.length < 2) continue;
          const gems = (group.gems as any[]).filter((g: any) => g.enabled);
          const supports = gems.filter((g: any) => g.isSupport);
          if (supports.length < 2) continue;

          const supportNames = supports.map((g: any) => (g.name || '').toLowerCase());

          // Check for Brutality + elemental/chaos supports (direct conflict)
          const hasBrutality = supportNames.some((n: string) => n.includes('brutality'));
          if (hasBrutality) {
            const eleOrChaos = supportNames.filter((n: string) =>
              n.includes('elemental') || n.includes('fire') || n.includes('cold') ||
              n.includes('lightning') || n.includes('chaos') || n.includes('void manipulation') ||
              n.includes('added fire') || n.includes('added cold') || n.includes('added lightning')
            );
            if (eleOrChaos.length > 0) {
              issues.push({
                severity: 'error',
                category: 'gems',
                message: `Skill group "${group.label || `#${group.index}`}": Brutality prevents all elemental/chaos damage, but has ${eleOrChaos.join(', ')} — these supports do nothing.`,
              });
            }
          }

          // Check for Elemental Damage with Attacks + Melee Physical Damage (mixed scaling, not a hard conflict but suboptimal)
          const hasEleDmgAtk = supportNames.some((n: string) => n.includes('elemental damage with attacks'));
          const hasMeleePhys = supportNames.some((n: string) => n.includes('melee physical'));
          if (hasEleDmgAtk && hasMeleePhys) {
            issues.push({
              severity: 'info',
              category: 'gems',
              message: `Skill group "${group.label || `#${group.index}`}": Has both "Elemental Damage with Attacks" and "Melee Physical Damage" — these scale different damage types. Consider focusing on one scaling direction.`,
            });
          }
        }
      }
    } catch { /* gem check is best-effort */ }

    return { issues, stats };
  });
}

// Keep the quick scan on selected native outputs. Missing fields stay absent;
// saved PlayerStats must not fill holes in a partial live response.
const POE2_ISSUE_FIELDS = [
  'Life', 'LifeUnreserved', 'EnergyShield', 'Mana', 'ManaUnreserved', 'Spirit', 'SpiritUnreserved', 'Ward',
  'LifeCost', 'ManaCost', 'NetManaRegen', 'Str', 'Dex', 'Int', 'ReqStr', 'ReqDex', 'ReqInt', 'HitChance',
  'FireResist', 'ColdResist', 'LightningResist', 'ChaosResist',
  'MissingFireResist', 'MissingColdResist', 'MissingLightningResist', 'MissingChaosResist',
  'TotalDPS', 'CombinedDPS', 'MinionTotalDPS', 'TotalEHP', 'ExtraPoints', 'PassivePointsToWeaponSetPoints',
  'PhysicalMaximumHitTaken', 'FireMaximumHitTaken', 'ColdMaximumHitTaken', 'LightningMaximumHitTaken', 'ChaosMaximumHitTaken',
  'EvadeChance', 'DeflectChance', 'EffectiveBlockChance', 'Armour', 'PhysicalDamageReduction',
  'LifeRegenRecovery', 'LifeLeechGainRate', 'EnergyShieldRegenRecovery', 'EnergyShieldLeechGainRate',
  'EnergyShieldRecharge', 'ManaRegenRecovery', 'FreezeAvoidChance', 'BleedAvoidChance', 'PoisonAvoidChance',
];

function addPassiveEvidence(build: PoBBuild | undefined, stats: Record<string, number>, issues: BuildIssue[]) {
  try {
    if (!build?.Tree) throw new Error('exported tree is unavailable');
    const specs = build.Tree.Spec;
    if (Array.isArray(specs)) {
      const selected = Number(build.Tree.activeSpec ?? 1);
      if (!Number.isInteger(selected) || !specs[selected - 1]) throw new Error('selected tree spec is unavailable');
    }
    const spec = activeValidationSpec(build);
    if (!spec || !String(spec.treeVersion ?? '').startsWith('0_') || typeof spec.nodes !== 'string') {
      throw new Error('selected native PoE2 spec or allocation list is unavailable');
    }
    const ids = [...new Set<string>(spec.nodes.split(',').map((id: string) => id.trim()).filter(Boolean))];
    const tree = ids.length ? getPobTreeData(spec.treeVersion) : null;
    if (ids.some(id => !tree?.nodes[id])) throw new Error('allocated node definitions are missing from the installed tree');
    const budget = poe2PassiveBudget(build, ids.map(id => tree!.nodes[id]), stats);
    const available = budget.availablePoints ?? 'unknown';
    issues.push({ severity: 'info', category: 'defence', message:
      `PoE2 passive spending: weapon set 1 ${budget.perWeaponPoints[0]} / ${available}; weapon set 2 ${budget.perWeaponPoints[1]} / ${available}. ` +
      `Shared ${budget.sharedPoints}; weapon-specific ${budget.weaponSetPoints.join(' / ')}. ${budget.notes.join(' ')}` });
    for (const message of budget.warnings) issues.push({ severity: 'warning', category: 'defence', message });
  } catch (error) {
    issues.push({ severity: 'info', category: 'defence', message: `Unknown data: passive budget unknown (${error instanceof Error ? error.message : 'native data unavailable'}).` });
  }
}

async function getPoe2BuildIssues(luaClient: AnyLuaClient) {
  const issues: BuildIssue[] = [];
  let build: PoBBuild | undefined;
  try {
    // Parsing an in-memory export performs no build load, save or gear changes.
    build = new BuildService('').parseBuildContent(await luaClient.exportBuildXml());
  } catch {
    issues.push({ severity: 'info', category: 'items', message: 'Unknown data: live build XML unavailable; selected equipment, skill setup and tree allocation are unknown.' });
  }
  if (build && build.__xmlRoot !== 'PathOfBuilding2') {
    throw new Error('PoE2 quick scan received a PoE1 build export; native game selection must match.');
  }
  const stats: Record<string, number> = {};
  try {
    const native = await luaClient.getStats(POE2_ISSUE_FIELDS);
    for (const key of POE2_ISSUE_FIELDS) {
      const value = validationStat(native, key);
      if (value !== null) stats[key] = value;
    }
  } catch {
    issues.push({ severity: 'info', category: 'defence', message: 'Unknown data: selected native outputs are unknown because the stats read failed.' });
  }
  const required = ['Life', 'EnergyShield', 'Mana', 'Spirit', 'Ward',
    'FireResist', 'ColdResist', 'LightningResist', 'ChaosResist',
    'MissingFireResist', 'MissingColdResist', 'MissingLightningResist', 'MissingChaosResist',
    'LifeUnreserved', 'ManaUnreserved', 'SpiritUnreserved', 'LifeCost', 'ManaCost',
    'Str', 'Dex', 'Int', 'ReqStr', 'ReqDex', 'ReqInt'];
  const missing = required.filter(key => validationStat(stats, key) === null);
  if (missing.length) issues.push({ severity: 'info', category: 'defence', message: `Unknown data: native outputs unavailable for ${missing.join(', ')}.` });

  // An absent XML contains no assumed items. ValidationService labels charm
  // protection unknown, and receives only the live stats (never saved fallbacks).
  const validation = new ValidationService().validateBuild(build ?? { __xmlRoot: 'PathOfBuilding2' }, null, stats);
  const categories: Record<ValidationIssue['category'], BuildIssue['category']> = {
    resistances: 'resistance', defenses: 'defence', immunities: 'items', mana: 'reservation', accuracy: 'gems', general: 'items',
  };
  for (const issue of [...validation.criticalIssues, ...validation.warnings, ...validation.recommendations]) {
    issues.push({ severity: issue.severity === 'critical' ? 'error' : issue.severity,
      category: categories[issue.category], message: issue.description });
  }
  addPassiveEvidence(build, stats, issues);
  issues.push({ severity: 'info', category: 'defence', message: `Scan scope: ${validation.summary} Equipment completeness, socket usability and full damage coverage are not assessed by this quick scan.` });
  return { issues, stats };
}

/** Shared by explicit scans and the automatic load summary. */
export function formatQuickStats(stats: Record<string, unknown>): string[] {
  const number = (key: string, suffix = '') => {
    const value = validationStat(stats, key);
    return value === null ? 'unknown' : value.toLocaleString('en-US', { maximumFractionDigits: 2 }) + suffix;
  };
  const dpsKey = validationStat(stats, 'CombinedDPS') !== null ? 'CombinedDPS' : 'TotalDPS';
  return [
    `Life: ${number('Life')} | ES: ${number('EnergyShield')} | Mana: ${number('Mana')} | Spirit: ${number('Spirit')} | Ward: ${number('Ward')}`,
    `Unreserved — Life: ${number('LifeUnreserved')} | Mana: ${number('ManaUnreserved')} | Spirit: ${number('SpiritUnreserved')}`,
    `Selected-skill DPS: ${number(dpsKey)} | Minion DPS: ${number('MinionTotalDPS')} | EHP: ${number('TotalEHP')}`,
    `Fire: ${number('FireResist', '%')} | Cold: ${number('ColdResist', '%')} | Lightning: ${number('LightningResist', '%')} | Chaos: ${number('ChaosResist', '%')}`,
  ];
}

export function formatIssuesResponse(issues: BuildIssue[], stats: Record<string, any>) {
  const errors = issues.filter(i => i.severity === 'error');
  const warnings = issues.filter(i => i.severity === 'warning');
  const infos = issues.filter(i => i.severity === 'info');

  let text = '=== Build Issues ===\n\n';

  if (issues.length === 0) {
    text += 'No issues established by this scan. Overall build viability remains unknown.\n';
  } else {
    if (errors.length > 0) {
      text += `**Errors (${errors.length}):**\n`;
      for (const issue of errors) {
        text += `  ❌ [${issue.category}] ${issue.message}\n`;
      }
      text += '\n';
    }
    if (warnings.length > 0) {
      text += `**Warnings (${warnings.length}):**\n`;
      for (const issue of warnings) {
        text += `  ⚠️  [${issue.category}] ${issue.message}\n`;
      }
      text += '\n';
    }
    if (infos.length > 0) {
      text += `**Info (${infos.length}):**\n`;
      for (const issue of infos) {
        text += `  ℹ️  [${issue.category}] ${issue.message}\n`;
      }
      text += '\n';
    }
  }

  text += '=== Current Stats ===\n' + formatQuickStats(stats).join('\n') + '\n';

  return {
    content: [{ type: 'text' as const, text }],
  };
}
