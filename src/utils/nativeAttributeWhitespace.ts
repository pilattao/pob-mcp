/**
 * Shield literal attribute whitespace only while fast-xml-parser reads a native
 * PoB document. Its normal text trimming is still useful for element content,
 * but attribute trimming and document-wide CR normalization lose native values.
 *
 * Temporary, collision-free parser entities are decoded into ordinary
 * strings. XMLBuilder subsequently emits literal whitespace, as PoB's own XML
 * reader requires; these references must never be used as serialized output.
 */
export function protectNativeAttributeWhitespace(xml: string): { xml: string; entities: Record<string, string> } {
  let suffix = 0;
  while (xml.includes(`pobMcpAttributeWhitespace${suffix}_`)) suffix++;
  const prefix = `pobMcpAttributeWhitespace${suffix}_`;
  const entities: Record<string, string> = {};
  const chunks: string[] = [];
  let cursor = 0;
  while (cursor < xml.length) {
    const start = xml.indexOf('<', cursor);
    if (start < 0) break;
    chunks.push(xml.slice(cursor, start));
    const terminator = xml.startsWith('<!--', start) ? '-->'
      : xml.startsWith('<![CDATA[', start) ? ']]>'
      : xml.startsWith('<?', start) ? '?>' : undefined;
    let end: number;
    if (terminator) {
      const close = xml.indexOf(terminator, start + 2);
      if (close < 0) { cursor = start; break; }
      end = close + terminator.length;
    } else {
      // Respect quoted '>' and declaration subsets; never scan their text as tags.
      let quote = '', depth = 0, index = start + 1;
      const declaration = xml[index] === '!';
      for (; index < xml.length; index++) {
        const char = xml[index];
        if (quote) { if (char === quote) quote = ''; }
        else if (char === '"' || char === "'") quote = char;
        else if (declaration && char === '[') depth++;
        else if (declaration && char === ']') depth--;
        else if (char === '>' && depth === 0) break;
      }
      if (index === xml.length) { cursor = start; break; }
      end = index + 1;
    }
    let tag = xml.slice(start, end);
    if (!terminator && !/[!?/\s]/.test(xml[start + 1] ?? ' ')) {
      tag = tag.replace(/(\s+[^\s=<>"']+\s*=\s*)(["'])([\s\S]*?)\2/g,
        (_whole, name: string, quote: string, value: string) =>
          name + quote + value.replace(/\s/g, char => {
            const key = prefix + char.codePointAt(0);
            entities[key] = char;
            return `&${key};`;
          }) + quote);
    }
    chunks.push(tag);
    cursor = end;
  }
  chunks.push(xml.slice(cursor));
  return { xml: chunks.join(''), entities };
}
