/**
 * Decodes imported bytes as UTF-8 source text.
 *
 * A leading byte-order mark is removed so that line numbers and evidence
 * snippets match what editors display. Binary or invalidly encoded content is
 * not source text and returns null.
 */
export type SourceText = { content: string; size: number };

export function decodeSourceText(bytes: Uint8Array): SourceText | null {
  if (bytes.includes(0)) return null;
  try {
    const content = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    const bom =
      bytes.length >= 3 &&
      bytes[0] === 0xef &&
      bytes[1] === 0xbb &&
      bytes[2] === 0xbf;
    return { content, size: bytes.length - (bom ? 3 : 0) };
  } catch {
    return null;
  }
}
