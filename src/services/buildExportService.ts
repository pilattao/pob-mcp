import { XMLBuilder, XMLValidator } from 'fast-xml-parser';
import { createHash, randomUUID } from 'crypto';
import fs from 'fs/promises';
import path from 'path';
import type { PoBBuild, SnapshotMetadata } from '../types.js';
import { sanitizeBuildName, resolveBuildPath } from '../utils/pathSanitizer.js';
import { buildXmlDocument } from '../utils/buildXml.js';
import { BuildService } from './buildService.js';

export interface ExportOptions { outputName: string; outputDirectory?: string; overwrite?: boolean; notes?: string }
export interface SaveTreeOptions { buildName: string; nodes: string[]; masteryEffects?: Record<string, number>; backup?: boolean }
export interface SnapshotOptions { buildName: string; description?: string; tag?: string }
export interface RestoreOptions { buildName: string; snapshotId: string; backupCurrent?: boolean }
interface FileSnapshotMetadata extends SnapshotMetadata { game?: string; sha256?: string; statsSource?: string }
interface SnapshotList {
  snapshots: Array<{ id: string; metadata: FileSnapshotMetadata; filePath: string }>;
  total: number;
  diskSpace: number;
  warnings?: string[];
}

export class BuildExportService {
  private readonly pobDirectory: string;
  private readonly snapshotDirectory: string;
  private readonly exportDirectory: string;
  private readonly reader: BuildService;
  private sequence = 0;
  private readonly xmlBuilder = new XMLBuilder({ ignoreAttributes: false, attributeNamePrefix: '@_',
    format: true, indentBy: '  ', suppressEmptyNode: false, suppressBooleanAttributes: false });

  constructor(pobDirectory: string) {
    this.pobDirectory = path.resolve(pobDirectory);
    this.snapshotDirectory = path.join(this.pobDirectory, '.pob-mcp', 'snapshots');
    this.exportDirectory = path.join(this.pobDirectory, '.pob-mcp', 'exports');
    this.reader = new BuildService(this.pobDirectory);
  }

  async exportBuild(buildData: PoBBuild, options: ExportOptions): Promise<{ filePath: string; message: string }> {
    const build = structuredClone(buildData);
    if (options.notes !== undefined) {
      if (typeof options.notes !== 'string') throw new Error('Export notes must be a string');
      if (options.notes) build.Notes = (build.Notes ?? '') + (build.Notes ? '\n\n---\n\n' : '') + options.notes;
    }
    if (!build.Build || !build.Tree) throw new Error('Invalid build: Missing Build or Tree section');
    const xml = this.buildToXML(build);
    const target = options.outputDirectory || this.exportDirectory;
    const filePath = resolveBuildPath(options.outputName, target);
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await this.safeWrite(filePath, xml, options.overwrite === true);
    return { filePath, message: `Build exported successfully to: ${filePath}` };
  }

  async saveTree(buildService: BuildService, options: SaveTreeOptions): Promise<{ message: string; backupPath?: string }> {
    if (!Array.isArray(options.nodes) || options.nodes.some(node => typeof node !== 'string' || !/^\d+$/.test(node) || !Number.isSafeInteger(Number(node)))) {
      throw new Error('Tree nodes must be an array of numeric node IDs');
    }
    const buildPath = resolveBuildPath(options.buildName, this.pobDirectory);
    const content = await fs.readFile(buildPath, 'utf8');
    const build = this.parseDocument(content);
    const spec = buildService.getActiveSpec(build);
    if (!spec) throw new Error('No active spec found in build');
    if (options.masteryEffects && Object.keys(options.masteryEffects).length && build.__xmlRoot === 'PathOfBuilding2') {
      throw new Error('PoE1 mastery effects cannot be written into a PoE2 tree');
    }
    const oldNodes: string[] = spec.nodes?.split(',').filter(Boolean) ?? [];
    const nodes = [...new Set(options.nodes)];
    spec.nodes = nodes.join(',');
    if (options.masteryEffects && build.__xmlRoot !== 'PathOfBuilding2') {
      const effects = Object.entries(options.masteryEffects);
      if (effects.some(([node, effect]) => !/^\d+$/.test(node) || !Number.isSafeInteger(effect) || effect < 0)) throw new Error('Invalid mastery effect');
      delete spec.MasteryEffect;
      if (effects.length) spec.MasteryEffect = effects.map(([node, effect]) => ({ node, effect: String(effect) }));
    }
    const xml = this.buildToXML(build);
    const backup = options.backup !== false ? await this.writeSnapshot(content, { buildName: options.buildName, tag: 'backup', description: 'Before save_tree' }) : undefined;
    await this.safeWrite(buildPath, xml, true);
    buildService.invalidateBuild(options.buildName);
    return { message: `Tree updated successfully. Nodes added: ${nodes.filter(node => !oldNodes.includes(node)).length}, removed: ${oldNodes.filter(node => !nodes.includes(node)).length}`,
      backupPath: backup?.snapshotPath };
  }

  async snapshotBuild(_buildService: BuildService, options: SnapshotOptions): Promise<{ snapshotId: string; snapshotPath: string }> {
    const content = await fs.readFile(resolveBuildPath(options.buildName, this.pobDirectory), 'utf8');
    return this.writeSnapshot(content, options);
  }

  private async writeSnapshot(content: string, options: SnapshotOptions, allowUnparsed = false): Promise<{ snapshotId: string; snapshotPath: string }> {
    let build: PoBBuild | undefined;
    let parseWarning = '';
    try { build = this.parseDocument(content); }
    catch (error) {
      if (!allowUnparsed) throw error;
      parseWarning = ' (Unparsed current file retained byte-for-byte)';
    }
    const directory = resolveBuildPath(options.buildName, this.snapshotDirectory);
    const timestamp = new Date().toISOString();
    // UUID protects simultaneous service instances; the sequence orders same-ms snapshots in this instance.
    const snapshotId = `${timestamp.replace(/[:.]/g, '-')}-${String(++this.sequence).padStart(6, '0')}-${randomUUID()}`;
    const tag = options.tag || 'snapshot';
    if (typeof tag !== 'string' || (options.description !== undefined && typeof options.description !== 'string')) throw new Error('Snapshot tag and description must be strings');
    const snapshotPath = sanitizeBuildName(`${snapshotId}_${this.sanitizeFileName(tag)}.xml`, directory);
    const metadata: FileSnapshotMetadata = {
      timestamp, originalBuild: options.buildName, description: (options.description ?? '') + parseWarning, tag,
      game: build ? build.__xmlRoot === 'PathOfBuilding2' ? 'poe2' : 'poe1' : undefined,
      sha256: this.hash(content), statsSource: build ? 'saved-xml' : 'unparsed-saved-xml',
      statsSnapshot: build ? { life: this.extractStat(build, 'Life'), dps: this.extractStat(build, 'TotalDPS'),
        allocatedNodes: this.reader.parseAllocatedNodes(build).length } : {},
    };
    await fs.mkdir(directory, { recursive: true });
    await this.safeWrite(snapshotPath, content, false);
    try { await this.safeWrite(path.join(directory, `${snapshotId}_metadata.json`), JSON.stringify(metadata, null, 2), false); }
    catch (error) { await fs.unlink(snapshotPath).catch(() => {}); throw error; }
    return { snapshotId, snapshotPath };
  }

  async listSnapshots(buildName: string, options: { limit?: number; tagFilter?: string } = {}): Promise<SnapshotList> {
    if (options.limit !== undefined && (!Number.isSafeInteger(options.limit) || options.limit < 0)) throw new Error('Snapshot limit must be a nonnegative integer');
    const directory = resolveBuildPath(buildName, this.snapshotDirectory);
    let entries;
    try { entries = await fs.readdir(directory, { withFileTypes: true }); }
    catch (error: any) { if (error.code === 'ENOENT') return { snapshots: [], total: 0, diskSpace: 0 }; throw error; }
    const snapshots: SnapshotList['snapshots'] = [], warnings: string[] = [];
    let diskSpace = 0;
    for (const entry of entries.filter(entry => entry.isFile() && entry.name.endsWith('_metadata.json'))) {
      try {
        const metadata: FileSnapshotMetadata = JSON.parse(await fs.readFile(path.join(directory, entry.name), 'utf8'));
        if (typeof metadata.tag !== 'string' || !Number.isFinite(Date.parse(metadata.timestamp))) throw new Error('Invalid metadata');
        if (options.tagFilter !== undefined && metadata.tag !== options.tagFilter) continue;
        const id = entry.name.replace(/_metadata\.json$/, '');
        const filePath = sanitizeBuildName(`${id}_${this.sanitizeFileName(metadata.tag)}.xml`, directory);
        const stat = await fs.stat(filePath);
        if (!stat.isFile()) throw new Error('Snapshot is not a file');
        diskSpace += stat.size;
        snapshots.push({ id, metadata, filePath });
      } catch (error) { warnings.push(`Skipped ${entry.name}: ${error instanceof Error ? error.message : String(error)}`); }
    }
    // Older save_tree/restore wrote these files without metadata. Keep their IDs
    // usable; disclose that their timestamps come from the filesystem.
    const metadataIds = new Set(entries.filter(e => e.name.endsWith('_metadata.json')).map(e => e.name.replace(/_metadata\.json$/, '')));
    for (const entry of entries.filter(entry => entry.isFile())) {
      const match = entry.name.match(/^(.+)_(backup|before-restore)\.xml$/i);
      if (!match || metadataIds.has(match[1]) || (options.tagFilter !== undefined && options.tagFilter !== match[2])) continue;
      const filePath = sanitizeBuildName(entry.name, directory);
      const stat = await fs.stat(filePath);
      diskSpace += stat.size;
      snapshots.push({ id: match[1], filePath, metadata: {
        timestamp: stat.mtime.toISOString(), originalBuild: buildName, tag: match[2], statsSnapshot: {},
        description: 'Legacy XML-only backup; timestamp is file modification time, saved stats unavailable.',
      } });
    }
    snapshots.sort((a, b) => Date.parse(b.metadata.timestamp) - Date.parse(a.metadata.timestamp) || b.id.localeCompare(a.id));
    return { snapshots: options.limit === undefined ? snapshots : snapshots.slice(0, options.limit), total: snapshots.length, diskSpace, warnings };
  }

  async restoreSnapshot(options: RestoreOptions): Promise<{ message: string; backupId?: string; restoredXml: string }> {
    if (typeof options.snapshotId !== 'string' || !options.snapshotId.trim()) throw new Error('Snapshot ID or tag is required');
    const { snapshots } = await this.listSnapshots(options.buildName);
    const snapshot = snapshots.find(snapshot => snapshot.id === options.snapshotId) ?? snapshots.find(snapshot => snapshot.metadata.tag === options.snapshotId);
    if (!snapshot) throw new Error(`Snapshot not found: ${options.snapshotId}. Available snapshots: ${snapshots.map(s => `${s.id} [${s.metadata.tag}]`).join(', ')}`);
    const content = await fs.readFile(snapshot.filePath, 'utf8');
    this.parseDocument(content);
    if (snapshot.metadata.sha256 && snapshot.metadata.sha256 !== this.hash(content)) throw new Error('Snapshot content does not match its recorded checksum');
    const buildPath = resolveBuildPath(options.buildName, this.pobDirectory);
    let backup: { snapshotId: string; snapshotPath: string } | undefined;
    let currentMissing = false;
    if (options.backupCurrent !== false) {
      let current: string | undefined;
      try { current = await fs.readFile(buildPath, 'utf8'); }
      catch (error: any) { if (error.code !== 'ENOENT') throw error; currentMissing = true; }
      if (current !== undefined) backup = await this.writeSnapshot(current, {
        buildName: options.buildName, tag: 'before-restore', description: `Before restoring ${snapshot.id}`,
      }, true);
    }
    await fs.mkdir(path.dirname(buildPath), { recursive: true });
    await this.safeWrite(buildPath, content, true);
    return { message: `Build file restored from snapshot: ${snapshot.metadata.tag} (${snapshot.id})` +
      (currentMissing ? '\nNo current file existed to back up.' : ''), backupId: backup?.snapshotId, restoredXml: content };
  }

  private parseDocument(content: string): PoBBuild {
    if (XMLValidator.validate(content) !== true) throw new Error('Invalid build XML');
    const build = this.reader.parseBuildContent(content);
    if (!build.Build) throw new Error('Invalid build: Missing Build section');
    return build;
  }
  private buildToXML(build: PoBBuild): string {
    const xml = '<?xml version="1.0" encoding="UTF-8"?>\n' + this.xmlBuilder.build(buildXmlDocument(build));
    this.parseDocument(xml);
    return xml;
  }
  private hash(content: string): string { return createHash('sha256').update(content).digest('hex'); }
  private sanitizeFileName(name: string): string { return name.replace(/[^a-zA-Z0-9-_]/g, '-').replace(/-+/g, '-').toLowerCase(); }
  private extractStat(build: PoBBuild, name: string): number | undefined {
    const stats = build.Build?.PlayerStat;
    const value = (Array.isArray(stats) ? stats : stats ? [stats] : []).find(stat => stat.stat === name)?.value;
    if (value === undefined || value === '') return undefined;
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }

  /** Exclusive creation prevents overwrite races; replacement uses a complete sibling file. */
  private async safeWrite(filePath: string, content: string, overwrite: boolean): Promise<void> {
    const target = overwrite ? path.join(path.dirname(filePath), `.${path.basename(filePath)}.${randomUUID()}.tmp`) : filePath;
    let handle;
    try { handle = await fs.open(target, 'wx'); }
    catch (error: any) {
      if (error.code === 'EEXIST') throw new Error(`File already exists: ${filePath}. Set overwrite=true to replace the existing file.`);
      throw error;
    }
    try {
      await handle.writeFile(content, 'utf8');
      await handle.sync();
      await handle.close();
      if (overwrite) await fs.rename(target, filePath);
    } catch (error) {
      await handle.close().catch(() => {});
      await fs.unlink(target).catch(() => {});
      throw error;
    }
  }

  formatSnapshotList(result: SnapshotList): string {
    const lines = result.snapshots.length ? [`=== Snapshots (Showing ${result.snapshots.length} of ${result.total}) ===`, ''] : ['No matching snapshots to display.'];
    for (const [index, snapshot] of result.snapshots.entries()) {
      const { metadata, id } = snapshot;
      lines.push(`${index + 1}. ${new Date(metadata.timestamp).toLocaleString()} [${metadata.tag}]`);
      if (metadata.description) lines.push(`   Description: ${metadata.description}`);
      const stats = metadata.statsSnapshot;
      if (stats) lines.push(`   Saved XML stats: Life: ${stats.life?.toLocaleString() ?? 'N/A'} | DPS: ${stats.dps?.toLocaleString() ?? 'N/A'} | Nodes: ${stats.allocatedNodes ?? 'N/A'}`);
      lines.push(`   ID: ${id}`, '');
    }
    lines.push(`Total: ${result.total} snapshots | Disk space: ${(result.diskSpace / (1024 * 1024)).toFixed(2)} MB`, ...(result.warnings ?? []));
    return lines.join('\n');
  }
}
