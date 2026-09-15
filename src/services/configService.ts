/** Native PoB2 configuration reads and explicit patches. No local defaults or cache. */
import fs from 'node:fs/promises';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {XMLParser, XMLValidator} from 'fast-xml-parser';
import type {AnyLuaClient} from '../pobLuaBridge.js';
import {sanitizeBuildName} from '../utils/pathSanitizer.js';

export type ConfigValue = boolean | number | string;
export type ConfigInput = Record<string, ConfigValue>;
export type ConfigGame = 'poe1' | 'poe2';
const META = new Set(['activeConfigSetId', 'effectiveEnemyLevel']);
const POE1_ONLY = new Set(['bandit', 'pantheonMajorGod', 'pantheonMinorGod']);
const errorText = (error: unknown) => error instanceof Error ? error.message : String(error);
const isObject = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const isScalar = (value: unknown): value is ConfigValue => typeof value === 'boolean' || typeof value === 'string' || (typeof value === 'number' && Number.isFinite(value));

export function validateConfigPatch(value: unknown, game: ConfigGame = 'poe2', allowEmpty = false): ConfigInput {
  if (!isObject(value) || (!allowEmpty && Object.keys(value).length === 0)) throw new Error('config must be a nonempty flat input patch');
  for (const [key, setting] of Object.entries(value)) {
    if (!key.trim() || META.has(key)) throw new Error(`Config metadata is not writable: ${key}`);
    if (game === 'poe2' && POE1_ONLY.has(key)) throw new Error(`PoE1-only config option is not writable in PoE2: ${key}`);
    if (!isScalar(setting)) throw new Error(`Config input ${key} must be a finite number, boolean or string`);
  }
  return {...value} as ConfigInput;
}

export interface NativeConfigSnapshot {
  game: 'poe2';
  source: 'native PoB2 get_config';
  activeConfigSetId: number;
  effectiveEnemyLevel?: number;
  input: ConfigInput;
}

function snapshot(raw: unknown): NativeConfigSnapshot {
  if (!isObject(raw) || !Number.isInteger(raw.activeConfigSetId) || (raw.activeConfigSetId as number) < 1) {
    throw new Error('Native config is unavailable or lacks a valid activeConfigSetId');
  }
  if (raw.effectiveEnemyLevel !== undefined && (typeof raw.effectiveEnemyLevel !== 'number' || !Number.isFinite(raw.effectiveEnemyLevel))) {
    throw new Error('Native config has an invalid effectiveEnemyLevel');
  }
  const input: ConfigInput = {};
  for (const [key,value] of Object.entries(raw)) {
    if (META.has(key)) continue;
    if (!isScalar(value)) throw new Error(`Invalid native config input: ${key}`);
    Object.defineProperty(input,key,{value,enumerable:true,writable:true,configurable:true});
  }
  return {game:'poe2',source:'native PoB2 get_config',activeConfigSetId:raw.activeConfigSetId as number,
    effectiveEnemyLevel:raw.effectiveEnemyLevel as number | undefined,input};
}

// Match only conversions that the native ConfigOptions validator actually permits.
function storedMatches(requested: ConfigValue, stored: ConfigValue | undefined): boolean {
  if (requested === stored) return true;
  if (typeof stored === 'boolean') {
    if (requested === 'true' || requested === 1) return stored === true;
    if (requested === 'false' || requested === 0) return stored === false;
  }
  return typeof stored === 'number' && typeof requested === 'string' && requested.trim() !== '' && Number(requested) === stored;
}

export class ConfigService {
  constructor(private readonly client: Pick<AnyLuaClient, 'getConfig' | 'setConfig' | 'exportBuildXml'>) {}

  async read(): Promise<NativeConfigSnapshot> {
    return snapshot(await this.client.getConfig());
  }

  async apply(value: unknown): Promise<{before: NativeConfigSnapshot; after: NativeConfigSnapshot; patch: ConfigInput}> {
    const patch = validateConfigPatch(value);
    const before = await this.read();
    // Native set_config validates the ENTIRE registry batch before any mutation.
    await this.client.setConfig(patch);
    let after: NativeConfigSnapshot;
    try { after = await this.read(); }
    catch (error) { throw new Error(`Native config write was accepted, but readback failed; state unconfirmed: ${errorText(error)}`); }
    if (before.activeConfigSetId !== after.activeConfigSetId) throw new Error('Native config set changed during write; the target set is unconfirmed');
    for (const [key,requested] of Object.entries(patch)) {
      if (!storedMatches(requested,after.input[key])) throw new Error(`Native config write could not be verified: ${key} was not stored as requested`);
    }
    return {before,after,patch};
  }

  /** ConfigTab:Save emits only Input entries differing from native defaults. */
  async explicitOverrides(): Promise<{snapshot: NativeConfigSnapshot; input: ConfigInput}> {
    const before = await this.read();
    const xml = await this.client.exportBuildXml();
    if (typeof xml !== 'string' || XMLValidator.validate(xml) !== true) throw new Error('Invalid native config XML export');
    const document = new XMLParser({ignoreAttributes:false,ignoreDeclaration:true,parseAttributeValue:false,trimValues:false}).parse(xml);
    const config = document?.PathOfBuilding2?.Config;
    if (!config || Number(config['@_activeConfigSet']) !== before.activeConfigSetId) throw new Error('Native config set changed or is missing in XML export');
    const sets = config.ConfigSet === undefined ? [] : Array.isArray(config.ConfigSet) ? config.ConfigSet : [config.ConfigSet];
    const selected = sets.filter((set:any) => Number(set['@_id']) === before.activeConfigSetId);
    if (selected.length !== 1) throw new Error('Selected native config set is missing or ambiguous in XML');
    const after = await this.read();
    const keys = Object.keys(before.input);
    if (before.activeConfigSetId !== after.activeConfigSetId || keys.length !== Object.keys(after.input).length || keys.some(key => before.input[key] !== after.input[key])) {
      throw new Error('Native config changed during preset capture; retry');
    }
    const entries = selected[0].Input === undefined ? [] : Array.isArray(selected[0].Input) ? selected[0].Input : [selected[0].Input];
    const input: ConfigInput = {};
    for (const entry of entries) {
      const key = entry['@_name'];
      if (typeof key !== 'string' || !Object.hasOwn(after.input,key) || Object.hasOwn(input,key)) throw new Error('Native config XML input does not match the selected set');
      // The live value preserves literal newlines/tabs that XML attributes normalize.
      Object.defineProperty(input,key,{value:after.input[key],enumerable:true,writable:true,configurable:true});
    }
    validateConfigPatch(input,'poe2',true);
    return {snapshot:after,input};
  }
}

export interface ConfigPreset {
  schemaVersion: 1;
  game: ConfigGame;
  scope: 'explicit-input-overrides' | 'native-input';
  source: {kind: string; activeConfigSetId?: number};
  input: ConfigInput;
}

const PRESET_DIR = '.pob-mcp-presets';
function presetPath(directory: string, game: ConfigGame | undefined, name: string): string {
  if (typeof name !== 'string' || !name.trim()) throw new Error('Preset name is required');
  return sanitizeBuildName(`${name}.json`,game ? path.join(directory,PRESET_DIR,game) : path.join(directory,PRESET_DIR));
}
function isMissing(error: unknown): boolean { return (error as NodeJS.ErrnoException)?.code === 'ENOENT'; }

export async function writeConfigPreset(directory: string, name: string, preset: ConfigPreset): Promise<string> {
  const file = presetPath(directory,preset.game,name);
  await fs.mkdir(path.dirname(file),{recursive:true});
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    await fs.writeFile(temporary,JSON.stringify(preset,null,2),{encoding:'utf8',flag:'wx'});
    await fs.rename(temporary,file);
  } finally {
    await fs.unlink(temporary).catch(error => {if (!isMissing(error)) throw error;});
  }
  return file;
}

export async function readConfigPreset(directory: string, name: string, game: ConfigGame): Promise<ConfigPreset> {
  let raw: string;
  let legacy = false;
  try { raw = await fs.readFile(presetPath(directory,game,name),'utf8'); }
  catch (error) {
    if (!isMissing(error)) throw error;
    if (game === 'poe2') throw new Error(`PoE2 preset "${name}" not found; legacy PoE1 presets are separate`);
    try { raw = await fs.readFile(presetPath(directory,undefined,name),'utf8'); legacy = true; }
    catch (fallbackError) { if (isMissing(fallbackError)) throw new Error(`Preset "${name}" not found`); throw fallbackError; }
  }
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { throw new Error(`Invalid JSON in config preset "${name}"`); }
  if (legacy) return {schemaVersion:1,game:'poe1',scope:'native-input',source:{kind:'legacy unversioned PoE1 preset'},input:validateConfigPatch(parsed,'poe1',true)};
  if (!isObject(parsed) || parsed.schemaVersion !== 1 || parsed.game !== game || !isObject(parsed.source) || typeof parsed.source.kind !== 'string') {
    throw new Error(`Invalid config preset game/provenance; expected ${game}`);
  }
  if (parsed.scope !== (game === 'poe2' ? 'explicit-input-overrides' : 'native-input')) throw new Error('Invalid config preset scope');
  return {...parsed,input:validateConfigPatch(parsed.input,game,true)} as unknown as ConfigPreset;
}

export async function listConfigPresets(directory: string, game: ConfigGame): Promise<Array<{name: string; legacy: boolean}>> {
  async function names(dir: string) {
    try { return (await fs.readdir(dir)).filter(file => file.endsWith('.json')).map(file => file.slice(0,-5)); }
    catch (error) { if (isMissing(error)) return []; throw error; }
  }
  const current = await names(path.join(directory,PRESET_DIR,game));
  const legacy = game === 'poe1' ? await names(path.join(directory,PRESET_DIR)) : [];
  return [...current.map(name=>({name,legacy:false})),...legacy.filter(name=>!current.includes(name)).map(name=>({name,legacy:true}))].sort((a,b)=>a.name.localeCompare(b.name));
}
