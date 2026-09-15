import chokidar from 'chokidar';
import fs from 'fs/promises';
import path from 'path';
import type { BuildService } from './buildService.js';

interface RecentChange { file: string; timestamp: number; type: string }

/** Watches saved build files; invalidates reads without loading or mutating live PoB. */
export class WatchService {
  private watcher: ReturnType<typeof chokidar.watch> | null = null;
  private readonly pobDirectory: string;
  private recentChanges: RecentChange[] = [];
  private watchEnabled = false;
  private debounceTimers = new Map<string, NodeJS.Timeout>();
  private starting: Promise<void> | null = null;
  private stopping: Promise<void> | null = null;
  private cancelStart?: () => void;
  private generation = 0;
  private lastError: string | null = null;

  constructor(pobDirectory: string, private readonly buildService: BuildService) {
    this.pobDirectory = path.resolve(pobDirectory);
  }

  async startWatching(): Promise<void> {
    if (this.stopping) await this.stopping;
    if (this.watchEnabled) return;
    if (this.starting) return this.starting;
    const generation = ++this.generation;
    this.lastError = null;
    const opening = this.openWatcher(generation);
    this.starting = opening;
    try { await opening; }
    catch (error) {
      if (generation === this.generation) {
        this.lastError = error instanceof Error ? error.message : String(error);
        await this.stopWatching();
      }
      throw error;
    } finally { if (this.starting === opening) this.starting = null; }
  }

  private async openWatcher(generation: number): Promise<void> {
    const directory = await fs.stat(this.pobDirectory);
    if (!directory.isDirectory()) throw new Error('PoB build path must be a directory');
    if (generation !== this.generation) throw new Error('Watcher startup cancelled');
    const watcher = chokidar.watch(this.pobDirectory, {
      ignored: (candidate: string) => path.relative(this.pobDirectory, candidate).split(path.sep)
        .some(segment => segment.startsWith('.') || segment.startsWith('~~temp~~')),
      persistent: true, ignoreInitial: true, followSymlinks: false,
      // DrvFS and UNC/network shares cannot reliably supply native file events.
      usePolling: /^\/mnt\/[a-z](?:\/|$)/i.test(this.pobDirectory) || this.pobDirectory.startsWith('\\\\'),
      awaitWriteFinish: { stabilityThreshold: 500, pollInterval: 100 },
    });
    this.watcher = watcher;
    watcher.on('add', file => this.handleFileChange(file, 'added'))
      .on('change', file => this.handleFileChange(file, 'modified'))
      .on('unlink', file => this.handleFileChange(file, 'deleted'));
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Watcher readiness timed out')), 15000);
      const cleanup = () => { clearTimeout(timeout); if (this.cancelStart === cancel) this.cancelStart = undefined; };
      const cancel = () => { cleanup(); reject(new Error('Watcher startup cancelled')); };
      this.cancelStart = cancel;
      watcher.once('ready', () => {
        cleanup();
        if (generation !== this.generation) { reject(new Error('Watcher startup cancelled')); return; }
        this.watchEnabled = true;
        resolve();
      });
      watcher.on('error', error => {
        cleanup();
        reject(error);
        if (generation === this.generation) {
          this.lastError = error instanceof Error ? error.message : String(error);
          void this.stopWatching().catch(closeError => { this.lastError = String(closeError); });
        }
      });
    });
  }

  async stopWatching(): Promise<void> {
    if (this.stopping) return this.stopping;
    ++this.generation;
    this.watchEnabled = false;
    this.cancelStart?.();
    for (const timer of this.debounceTimers.values()) clearTimeout(timer);
    this.debounceTimers.clear();
    const watcher = this.watcher;
    this.watcher = null;
    const opening = this.starting;
    const closing = (async () => {
      if (watcher) await watcher.close();
      if (opening) await opening.catch(() => {});
      if (this.starting === opening) this.starting = null;
    })();
    this.stopping = closing;
    try { await closing; } finally { if (this.stopping === closing) this.stopping = null; }
  }

  private handleFileChange(filePath: string, type: string): void {
    if (!this.watchEnabled || !/\.xml$/i.test(filePath)) return;
    const relative = path.relative(this.pobDirectory, filePath);
    if (!relative || path.isAbsolute(relative) || relative.split(path.sep).includes('..')) return;
    const file = relative.split(path.sep).join('/');
    const previous = this.debounceTimers.get(file);
    if (previous) clearTimeout(previous);
    const generation = this.generation;
    this.debounceTimers.set(file, setTimeout(() => {
      this.debounceTimers.delete(file);
      if (!this.watchEnabled || generation !== this.generation) return;
      this.buildService.invalidateBuild(file);
      this.recentChanges.push({ file, timestamp: Date.now(), type });
      this.recentChanges = this.recentChanges.slice(-50);
    }, 150));
  }

  isWatchEnabled(): boolean { return this.watchEnabled; }
  getDirectory(): string { return this.pobDirectory; }
  getRecentChangesCount(): number { return this.recentChanges.length; }
  getLastError(): string | null { return this.lastError; }
  getRecentChanges(limit = 10): RecentChange[] {
    if (!Number.isInteger(limit) || limit < 0 || limit > 50) throw new Error('limit must be an integer from 0 to 50');
    return limit === 0 ? [] : this.recentChanges.slice(-limit).reverse().map(change => ({ ...change }));
  }
}
