import path from "path";

/**
 * Sanitize a build name to prevent path traversal attacks.
 * Returns the resolved absolute path within baseDir.
 * Throws on any path that would escape baseDir.
 */
export function sanitizeBuildName(name: string, baseDir: string): string {
  if (name.includes('\0')) {
    throw new Error('Build name contains null bytes');
  }

  if (!name.trim() || path.isAbsolute(name) || path.win32.isAbsolute(name) || /^[a-z]:/i.test(name)) {
    throw new Error('Build name must be relative');
  }

  // Reject .. components (both Unix and Windows separators)
  const normalized = name.replace(/\\/g, '/');
  if (normalized.split('/').some(segment => segment === '..')) {
    throw new Error('Build name contains path traversal');
  }

  const resolved = path.resolve(baseDir, normalized);
  const resolvedBase = path.resolve(baseDir);

  if (!resolved.startsWith(resolvedBase + path.sep) && resolved !== resolvedBase) {
    throw new Error('Build name resolves outside base directory');
  }

  return resolved;
}

/** Resolve build files consistently, while the generic sanitizer still handles JSON and directories. */
export function resolveBuildPath(name: string, baseDir: string): string {
  sanitizeBuildName(name, baseDir);
  const filename = /\.xml$/i.test(name) ? name : `${name}.xml`;
  return sanitizeBuildName(filename, baseDir);
}
