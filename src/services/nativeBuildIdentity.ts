import path from 'path';
import type { BuildService } from './buildService.js';

/** Windows native paths and their WSL mount spelling identify the same file. */
export function nativeFileIdentity(value: string): string {
  let normalized=value.replace(/\\/g,'/').replace(/^\/\/\?\/UNC\//i,'//').replace(/^\/\/\?\//,'');
  normalized=normalized.replace(/^\/mnt\/([a-z])\//i,(_,drive)=>drive+':/');
  const windows=/^[a-z]:\//i.test(normalized)||normalized.startsWith('//');
  const unc=normalized.startsWith('//');
  normalized=path.posix.normalize(normalized);
  if (unc && !normalized.startsWith('//')) normalized='/'+normalized;
  return windows?normalized.toLowerCase():normalized;
}
export function nativeBuildMatches(requested: string|undefined,info: any,service: BuildService): boolean {
  if (!requested) return true;
  if (typeof info?.fileName==='string' && info.fileName) {
    return nativeFileIdentity(info.fileName)===nativeFileIdentity(service.getBuildFilePath(requested));
  }
  // Imported/unsaved builds and older APIs have only their explicit title.
  const title=(value:string)=>value.replace(/\\/g,'/').replace(/\.xml$/i,'').toLowerCase();
  return typeof info?.name==='string' && title(info.name)===title(requested);
}
