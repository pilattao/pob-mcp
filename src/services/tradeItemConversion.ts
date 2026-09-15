/** Converts complete observed trade fields using the installed PoB2 raw-item grammar.
 * Native parsing/printed-property checks remain the final validation boundary.
 */
import { createHash } from 'crypto';
import type { NativeItemExpected } from '../types/nativeItemTypes.js';

export interface TradeItemConversion {
  complete: boolean; identity: string; text?: string; expected: NativeItemExpected; errors: string[];
}
const markup = (s: string) => s.replace(/<[^>]+>\{([^}]+)\}/g, '$1').replace(/\[([^|\]]+)\]/g, '$1').replace(/\[[^|]+\|([^|\]]+)\]/g, '$1');
const stable = (v: any): any => Array.isArray(v) ? v.map(stable) : v && typeof v === 'object'
  ? Object.fromEntries(Object.keys(v).sort().map(key => [key, stable(v[key])])) : v;
const integer = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v >= 0;
const modFields: Record<string, string> = { enchantMods: '{enchant}', runeMods: '{enchant}{rune}', implicitMods: '',
  explicitMods: '', fracturedMods: '{fractured}', craftedMods: '{crafted}', desecratedMods: '{desecrated}',
  mutatedMods: '{mutated}', utilityMods: '' };

export function convertTradeItemForPob(value: unknown): TradeItemConversion {
  const errors: string[] = [], expected: NativeItemExpected = {};
  const item: any = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const identity = createHash('sha256').update(JSON.stringify(stable(item))).digest('hex');
  for (const key of ['properties', 'requirements', 'grantedSkills', 'socketedItems']) {
    if (item[key] !== undefined && !Array.isArray(item[key])) errors.push(`Invalid ${key} array`);
  }
  if (errors.length) return { complete: false, identity, expected, errors };
  const textField = (name: string, value: unknown) => {
    if (typeof value !== 'string' || !value.trim() || /[\r\n\x00-\x1f{}]/.test(value)) { errors.push(`${name} is missing or malformed`); return ''; }
    return markup(value.trim());
  };
  const amount = (name: string, value: unknown): number | undefined => {
    if (typeof value !== 'string' || !/^\+?\d+(?:\.\d+)?%?$/.test(value.trim())) { errors.push(`${name} is not a known numeric property`); return undefined; }
    const n = Number(value.trim().replace('%', '')); if (!Number.isFinite(n)) { errors.push(`${name} is non-finite`); return undefined; } return n;
  };
  if (item.identified !== true) errors.push('Identified item evidence is required');
  if (typeof item.id !== 'string' || !item.id) errors.push('Trade item ID is missing');
  const rarity = typeof item.rarity === 'string' ? item.rarity.toUpperCase() : ['NORMAL', 'MAGIC', 'RARE', 'UNIQUE'][item.frameType];
  if (!['NORMAL', 'MAGIC', 'RARE', 'UNIQUE', 'RELIC'].includes(rarity)) errors.push('Unknown equipment rarity');
  const base = textField('baseType', item.baseType);
  expected.baseType = base; expected.rarity = rarity;
  const lines = [`Rarity: ${rarity}`];
  if (['RARE', 'UNIQUE', 'RELIC'].includes(rarity)) lines.push(textField('name', item.name), base);
  else lines.push(textField('typeLine', item.typeLine));
  if (integer(item.ilvl)) { lines.push(`Item Level: ${item.ilvl}`); expected.itemLevel = item.ilvl; }
  else errors.push('Item level evidence is missing');
  const properties: Record<string, string> = { Quality: 'Quality', Armour: 'Armour', 'Evasion Rating': 'Evasion',
    'Energy Shield': 'Energy Shield', 'Runic Ward': 'Ward', Ward: 'Ward', Spirit: 'Spirit', 'Charm Slots': 'Charm Slots' };
  for (const p of item.properties ?? []) {
    const name = typeof p.name === 'string' ? markup(p.name).replace(/:$/, '') : '';
    if (properties[name]) {
      if (p.values?.length !== 1) { errors.push(`Ambiguous ${name} property`); continue; }
      const n = amount(name, p.values[0]?.[0]);
      if (n !== undefined) { lines.push(`${properties[name]}: ${n}`); if (name === 'Quality') expected.quality = n; }
    } else if (/^Quality \(/.test(name)) errors.push('Catalyst quality conversion requires explicit native catalyst metadata');
    else if (['Radius', 'Limited to'].includes(name)) lines.push(`${name}: ${textField(name, p.values?.[0]?.[0])}`);
    else if (['Attacks per Second', 'Critical Hit Chance'].includes(name)) {
      const n = amount(name, p.values?.[0]?.[0]);
      if (n !== undefined) (expected.weapon ??= {})[name === 'Attacks per Second' ? 'AttackRate' : 'CritChance'] = n;
    } else if (/^(Physical|Fire|Cold|Lightning|Chaos) Damage$/.test(name)) {
      const match = p.values?.[0]?.[0]?.match(/^(\d+)-(\d+)$/);
      if (!match) errors.push(`Unresolved ${name} range`);
      else { const type = name.split(' ')[0]; (expected.weapon ??= {})[`${type}Min`] = +match[1]; expected.weapon[`${type}Max`] = +match[2]; }
    }
  }
  for (const req of item.requirements ?? []) {
    const name = typeof req.name === 'string' ? markup(req.name).replace(/:$/, '') : '';
    if (name === 'Level') { const n = amount(name, req.values?.[0]?.[0]); if (n !== undefined) { lines.push(`LevelReq: ${n}`); expected.requiredLevel = n; } }
    else if (name === 'Class') lines.push(`Requires Class: ${textField('Class', req.values?.[0]?.[0])}`);
  }
  if (item.sockets !== undefined) {
    if (!Array.isArray(item.sockets) || item.sockets.length > 12) errors.push('Invalid socket array');
    else {
      if (item.sockets.some((s: any) => s.type !== 'rune' && s.sColour !== 'S')) errors.push('Unknown or nested jewel socket conversion');
      expected.socketCount = item.sockets.length;
      if (item.sockets.length) lines.push(`Sockets: ${item.sockets.map(() => 'S').join(' ')}`);
      const runes = item.sockets.map(() => 'None');
      const occupied = new Set<number>();
      for (const socketed of item.socketedItems ?? []) {
        if (!integer(socketed.socket) || socketed.socket >= runes.length || occupied.has(socketed.socket)) { errors.push('Invalid or duplicate socketed rune position'); continue; }
        occupied.add(socketed.socket); runes[socketed.socket] = textField('socketed rune identity', socketed.baseType);
      }
      if (item.runeMods?.length && !occupied.size) errors.push('Rune identities/positions are missing from the listing');
      for (const rune of runes) lines.push(`Rune: ${rune}`);
    }
  } else if (item.socketedItems?.length || item.runeMods?.length) errors.push('Socket capacity is missing for the observed runes');
  const groups: Record<string, string[]> = {};
  const flags = new Set(['fractured', 'crafted', 'desecrated', 'mutated', 'enchant', 'rune']);
  for (const key of Object.keys(item)) if (key.endsWith('Mods') && !modFields.hasOwnProperty(key) && key !== 'pseudoMods' && item[key]?.length) errors.push(`Unknown modifier field: ${key}`);
  if (!Object.keys(modFields).some(key => Array.isArray(item[key]))) errors.push('No modifier arrays were supplied');
  for (const [key, prefix] of Object.entries(modFields)) {
    groups[key] = [];
    if (item[key] !== undefined && !Array.isArray(item[key])) { errors.push(`Invalid ${key} array`); continue; }
    for (const mod of item[key] ?? []) {
      const description = typeof mod === 'string' ? mod : mod?.description;
      if (typeof description !== 'string') { errors.push(`Unknown ${key} modifier shape`); continue; }
      let tags = prefix;
      for (const [flag, enabled] of Object.entries(typeof mod === 'object' ? mod.flags ?? {} : {})) {
        if (!enabled) continue;
        if (!flags.has(flag)) errors.push(`Unknown modifier flag: ${flag}`);
        else if (!tags.includes(`{${flag}}`)) tags += `{${flag}}`;
      }
      for (const line of markup(description).split(/\r?\n/)) {
        if (!line.trim() || /[{}\x00-\x08]/.test(line)) { errors.push('Malformed modifier text'); continue; }
        groups[key].push(tags + line.trim());
      }
    }
  }
  for (const granted of item.grantedSkills ?? []) {
    const name = textField('granted skill', granted.name);
    const raw = granted.values?.[0]?.[0];
    // GGG's normal shape is {name:'Grants Skill', values:[['Level 18 Lightning Bolt',25]]}.
    // Preserve its exact identity; native PoB's parser resolves the installed skill definition.
    if (name === 'Grants Skill' && typeof raw === 'string' && /^Level [1-9]\d* .+/.test(raw)) {
      groups.implicitMods.push(`${name}: ${textField('granted skill description', raw)}`);
    } else {
      const n = amount('granted skill level', raw);
      if (n !== undefined) groups.implicitMods.push(`${name}: ${n}`);
    }
  }
  lines.push(`Implicits: ${groups.enchantMods.length + groups.runeMods.length + groups.implicitMods.length}`,
    ...groups.enchantMods, ...groups.runeMods, ...groups.implicitMods,
    ...groups.explicitMods, ...groups.fracturedMods, ...groups.craftedMods, ...groups.desecratedMods, ...groups.mutatedMods, ...groups.utilityMods);
  expected.corrupted = item.corrupted === true || item.doubleCorrupted === true;
  if (item.doubleCorrupted) lines.push('Twice Corrupted'); else if (item.corrupted) lines.push('Corrupted');
  if (item.mirrored || item.duplicated) lines.push('Mirrored');
  if (item.sanctified) lines.push('Sanctified');
  const text = lines.join('\n');
  if (text.length > 32768) errors.push('Converted item exceeds 32 KB');
  return { complete: errors.length === 0, identity, text: errors.length ? undefined : text, expected, errors };
}
