// Lossless chunkable snapshots. UTF-16 string payloads avoid JSON's 6x expansion
// for control characters and preserve even lone surrogate code units verbatim.
// This is an internal versioned codec, never a format accepted from callers.
type Node =
  | number
  | boolean
  | null
  | { n: "nan" | "inf" | "-inf" | "-0" }
  | { s: [number, number] }
  | { a: Node[] }
  | { o: Record<string, Node> };
const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });
export const SNAPSHOT_CHUNK_BYTES = 128 * 1024;
export const MAX_SNAPSHOT_BYTES = 3 * 1024 * 1024;
export function encodeSnapshot(snapshot: Record<string, unknown>): Uint8Array {
  const texts: string[] = [];
  let units = 0;
  function visit(value: unknown): Node {
    if (typeof value === "string") {
      const node: Node = { s: [units, value.length] };
      texts.push(value);
      units += value.length;
      return node;
    }
    if (value === null || typeof value === "boolean") return value;
    if (typeof value === "number") {
      if (Number.isNaN(value)) return { n: "nan" };
      if (value === Infinity) return { n: "inf" };
      if (value === -Infinity) return { n: "-inf" };
      if (Object.is(value, -0)) return { n: "-0" };
      return value;
    }
    if (Array.isArray(value)) return { a: value.map(visit) };
    if (value && typeof value === "object") {
      const fields: Record<string, Node> = Object.create(null);
      // Enumerate canonical numeric keys the same way JSON.stringify does.
      const ordered = Object.fromEntries(Object.entries(value).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
      for (const [key, item] of Object.entries(ordered)) if (item !== undefined) fields[key] = visit(item);
      return { o: fields };
    }
    throw new Error("Unsupported content snapshot value");
  }
  const metadata = encoder.encode(JSON.stringify(visit(snapshot)));
  const size = 4 + metadata.length + units * 2;
  if (size > MAX_SNAPSHOT_BYTES) throw new Error("Content snapshot exceeds the supported storage limit");
  const bytes = new Uint8Array(size);
  new DataView(bytes.buffer).setUint32(0, metadata.length, true);
  bytes.set(metadata, 4);
  let pos = 4 + metadata.length;
  for (const text of texts)
    for (let i = 0; i < text.length; i++) {
      const unit = text.charCodeAt(i);
      bytes[pos++] = unit & 255;
      bytes[pos++] = unit >>> 8;
    }
  return bytes;
}
export function decodeSnapshot(bytes: Uint8Array): Record<string, unknown> {
  if (bytes.length < 4 || bytes.length > MAX_SNAPSHOT_BYTES) throw new Error("Invalid stored snapshot");
  const size = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(0, true);
  if (size > bytes.length - 4) throw new Error("Invalid stored snapshot");
  const start = 4 + size;
  const root: unknown = JSON.parse(decoder.decode(bytes.subarray(4, start)));
  let cursor = 0;
  function visit(node: unknown, depth = 0): unknown {
    if (depth > 64) throw new Error("Invalid stored snapshot");
    if (node === null || typeof node === "boolean") return node;
    if (typeof node === "number" && Number.isFinite(node)) return node;
    if (!node || typeof node !== "object" || Array.isArray(node) || Object.keys(node).length !== 1)
      throw new Error("Invalid stored snapshot");
    if ("n" in node) {
      if (node.n === "nan") return NaN;
      if (node.n === "inf") return Infinity;
      if (node.n === "-inf") return -Infinity;
      if (node.n === "-0") return -0;
      throw new Error("Invalid stored snapshot");
    }
    if ("s" in node) {
      if (!Array.isArray(node.s) || node.s.length !== 2) throw new Error("Invalid stored snapshot");
      const [offset, length] = node.s as number[];
      if (
        !Number.isSafeInteger(offset) ||
        !Number.isSafeInteger(length) ||
        offset !== cursor ||
        length! < 0 ||
        start + 2 * (offset! + length!) > bytes.length
      )
        throw new Error("Invalid stored snapshot");
      cursor += length!;
      const pieces: string[] = [];
      for (let i = 0; i < length!; i += 8192) {
        const units: number[] = [];
        for (let j = i; j < Math.min(i + 8192, length!); j++) {
          const pos = start + 2 * (offset! + j);
          units.push(bytes[pos]! | (bytes[pos + 1]! << 8));
        }
        pieces.push(String.fromCharCode(...units));
      }
      return pieces.join("");
    }
    if ("a" in node) {
      if (!Array.isArray(node.a)) throw new Error("Invalid stored snapshot");
      return node.a.map((item) => visit(item, depth + 1));
    }
    if (!("o" in node) || !node.o || typeof node.o !== "object" || Array.isArray(node.o))
      throw new Error("Invalid stored snapshot");
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(node.o))
      Object.defineProperty(out, key, { value: visit(item, depth + 1), enumerable: true });
    return out;
  }
  if (!root || typeof root !== "object" || !("o" in root)) throw new Error("Invalid stored snapshot root");
  const result = visit(root) as Record<string, unknown>;
  if (start + cursor * 2 !== bytes.length) throw new Error("Invalid stored snapshot length");
  return result;
}
