import { readPoe2BuildEvidence, type EvidenceContext } from './poe2BuildEvidence.js';
import { ValidationService } from './validationService.js';
import { parseItemRawMods } from '../utils/itemRawParser.js';
import { validationStat } from './passiveBudget.js';

const many = <T>(value: T | T[] | undefined): T[] => value == null ? [] : Array.isArray(value) ? value : [value];

/** PoE2 equipment evidence plus measured constraints. Upgrade rankings require native comparisons. */
export async function analyzePoe2Items(context: EvidenceContext, buildName?: string): Promise<string> {
  const evidence = await readPoe2BuildEvidence(context, buildName);
  const { build, stats } = evidence;
  const container = build.Items as any;
  const sets = many<any>(container?.ItemSet);
  const selected = String(container?.activeItemSet ?? '1');
  const set = sets.find(row => String(row.id) === selected);
  if (sets.length && !set) throw new Error(`Unknown active PoE2 item set ${selected}`);
  const rawItems = new Map(many<any>(container?.Item).map(item => [String(item.id), item['#text']]));
  const slots = many<any>((set ?? container)?.Slot);
  const equipped = slots.flatMap(slot => {
    const raw = typeof slot.Item === 'string' ? slot.Item : rawItems.get(String(slot.itemId));
    if (!raw || String(slot.itemId) === '0') return [];
    return [{ slot: slot.name, raw: String(raw) }];
  });
  const lines = ['=== PoE2 Item Analysis ===', evidence.note,
    `Class: ${build.Build?.className ?? 'unknown'}; ascendancy: ${build.Build?.ascendClassName ?? 'unknown'}; item set: ${selected}`];
  const resources = ['Life', 'EnergyShield', 'Mana', 'Spirit', 'Ward'];
  lines.push(resources.map(key => `${key}: ${validationStat(stats, key) ?? 'unknown'}`).join(' | '));
  lines.push(['Fire', 'Cold', 'Lightning', 'Chaos'].map(element => {
    const value = validationStat(stats, `${element}Resist`);
    return `${element} resistance: ${value === null ? 'unknown' : value + '%'}`;
  }).join(' | '));
  lines.push('', `Equipped entries: ${equipped.length}`);
  if (!equipped.length) lines.push('No equipped entries were present in the selected XML item set.');
  for (const item of equipped) {
    const text = item.raw.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
    const rarity = text[0]?.replace(/^Rarity:\s*/i, '') ?? 'unknown';
    const name = text[1] ?? 'unknown';
    const base = /^(RARE|UNIQUE)$/i.test(rarity) ? text[2] : undefined;
    lines.push('', `## ${item.slot}: ${name}${base ? ' — ' + base : ''} (${rarity})`);
    for (const mod of parseItemRawMods(item.raw)) lines.push(`- [${mod.type}] ${mod.line}`);
  }
  const validation = new ValidationService();
  lines.push('', validation.formatValidation(validation.validateBuild(build, null, stats)));
  lines.push('Prioritize measured resistance, resource and attribute shortfalls above. Rank candidate replacements using native item comparisons and current prices.');
  return lines.join('\n');
}
