import type { PoBBuild } from '../types.js';
import { XMLParser } from 'fast-xml-parser';

export type BuildXmlRoot = 'PathOfBuilding' | 'PathOfBuilding2';

/** Keep the format with the normalized DTO, without creating an XML field. */
export function unwrapBuildXml(document: Record<string, unknown>, source?: string): PoBBuild {
  const roots = ['PathOfBuilding', 'PathOfBuilding2'].filter(k => Object.prototype.hasOwnProperty.call(document, k));
  if (roots.length !== 1) throw new Error('Invalid or ambiguous Path of Building XML root');
  const root = roots[0] as BuildXmlRoot;
  const build = document[root];
  if (!build || typeof build !== 'object' || Array.isArray(build)) {
    throw new Error('Invalid Path of Building document format');
  }
  const elements = new Set<string>();
  if (source) {
    const original = new XMLParser({ ignoreAttributes: false }).parse(source)[root];
    const collect = (node: unknown, parent = '') => {
      if (Array.isArray(node)) { node.forEach(n => collect(n, parent)); return; }
      if (!node || typeof node !== 'object') return;
      for (const [key, value] of Object.entries(node)) {
        if (key.startsWith('@_') || key === '#text') continue;
        const name = parent ? `${parent}.${key}` : key;
        elements.add(name);
        collect(value, name);
      }
    };
    collect(original);
  }
  // Enumerable provenance deliberately survives JSON cloning used by simulations.
  Object.assign(build, { __xmlRoot: root, __xmlElements: [...elements] });
  return build as PoBBuild;
}

/** XMLParser's attributeNamePrefix="" DTO must not be fed directly to XMLBuilder. */
export function buildXmlDocument(build: PoBBuild): Record<string, unknown> {
  const root: BuildXmlRoot = build.__xmlRoot ?? 'PathOfBuilding';
  const elements = new Set(build.__xmlElements ?? []);
  function element(value: unknown, top = false, parent = ''): unknown {
    if (Array.isArray(value)) return value.map(v => element(v, false, parent));
    if (value === null || typeof value !== 'object') return { '#text': value ?? '' };
    const out: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value)) {
      if (key === '__xmlRoot' || key === '__xmlElements') continue;
      const name = parent ? `${parent}.${key}` : key;
      if (key === '#text') out[key] = child;
      else if (child !== null && typeof child === 'object') out[key] = element(child, false, name);
      else if (top || elements.has(name) || key === 'URL' || key === 'Notes') out[key] = element(child, false, name);
      else out['@_' + key] = child;
    }
    return out;
  }
  return { [root]: element(build, true) };
}
