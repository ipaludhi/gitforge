// Pure git object model: SHA-1 ids, trees, commits, tags, packfiles and pkt-lines.
// No git binary, no dependencies: node:crypto and node:zlib only. Everything here is
// deterministic: server-made objects carry a fixed timestamp, so the same content always
// hashes to the same id in every trial.

import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';

export type ObjType = 'commit' | 'tree' | 'blob' | 'tag';
export const ZERO_OID = '0'.repeat(40);
export const PKT_LINE_MAX_PAYLOAD = 65516;

export interface GitObject {
  readonly type: ObjType;
  readonly data: Buffer;
}

export interface TreeEntry {
  readonly mode: string;
  readonly name: string;
  readonly oid: string;
}

export function hashObject(type: ObjType, data: Buffer): string {
  const hash = createHash('sha1');
  hash.update(`${type} ${data.length}\0`, 'utf8');
  hash.update(data);
  return hash.digest('hex');
}

export function isOid(value: string): boolean {
  return /^[0-9a-f]{40}$/.test(value);
}

// ---------------------------------------------------------------- pkt-lines

export function encodePktLine(payload: string | Buffer): Buffer {
  const data = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  if (data.length > PKT_LINE_MAX_PAYLOAD) throw new Error('pkt-line payload too long');
  const header = Buffer.allocUnsafe(4);
  header.write((data.length + 4).toString(16).padStart(4, '0'), 0, 4, 'ascii');
  return Buffer.concat([header, data]);
}

export const FLUSH = Buffer.from('0000', 'ascii');
export const DELIM = Buffer.from('0001', 'ascii');

export function encodePktLines(items: readonly (string | Buffer | 'flush' | 'delim')[]): Buffer {
  const parts: Buffer[] = [];
  for (const item of items) {
    if (item === 'flush') parts.push(FLUSH);
    else if (item === 'delim') parts.push(DELIM);
    else parts.push(encodePktLine(item));
  }
  return Buffer.concat(parts);
}

/**
 * Decode a whole pkt-line framed buffer into packets. Returns null on any malformed
 * framing (the caller treats the request as garbage and stays up).
 */
export type Packet =
  | { kind: 'data'; payload: Buffer }
  | { kind: 'flush' }
  | { kind: 'delim' }
  | { kind: 'response-end' };

export function decodePktLines(buf: Buffer): Packet[] | null {
  const out: Packet[] = [];
  let offset = 0;
  while (offset < buf.length) {
    if (offset + 4 > buf.length) return null;
    const head = buf.toString('ascii', offset, offset + 4);
    if (head === '0000') {
      out.push({ kind: 'flush' });
      offset += 4;
      continue;
    }
    if (head === '0001') {
      out.push({ kind: 'delim' });
      offset += 4;
      continue;
    }
    if (head === '0002') {
      out.push({ kind: 'response-end' });
      offset += 4;
      continue;
    }
    if (!/^[0-9a-fA-F]{4}$/.test(head)) return null;
    const len = parseInt(head, 16);
    if (len < 4 || offset + len > buf.length) return null;
    out.push({ kind: 'data', payload: buf.subarray(offset + 4, offset + len) });
    offset += len;
  }
  return out;
}

// ---------------------------------------------------------------- trees

export function parseTree(data: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let offset = 0;
  while (offset < data.length) {
    const space = data.indexOf(0x20, offset);
    if (space < 0) throw new Error('tree entry has no mode separator');
    const nul = data.indexOf(0x00, space + 1);
    if (nul < 0 || nul + 21 > data.length) throw new Error('tree entry truncated');
    entries.push({
      mode: data.toString('ascii', offset, space),
      name: data.toString('utf8', space + 1, nul),
      oid: data.toString('hex', nul + 1, nul + 21),
    });
    offset = nul + 21;
  }
  return entries;
}

function compareTreeNames(a: TreeEntry, b: TreeEntry): number {
  const left = Buffer.from(a.mode === '40000' ? `${a.name}/` : a.name, 'utf8');
  const right = Buffer.from(b.mode === '40000' ? `${b.name}/` : b.name, 'utf8');
  return Buffer.compare(left, right);
}

export function buildTree(entries: readonly TreeEntry[]): Buffer {
  const sorted = [...entries].sort(compareTreeNames);
  const parts: Buffer[] = [];
  for (const entry of sorted) {
    parts.push(Buffer.from(`${entry.mode} ${entry.name}\0`, 'utf8'));
    parts.push(Buffer.from(entry.oid, 'hex'));
  }
  return Buffer.concat(parts);
}

// ---------------------------------------------------------------- commits / tags

export interface CommitView {
  readonly tree: string;
  readonly parents: string[];
  readonly author: string;
  readonly committer: string;
  readonly message: string;
}

export function parseCommit(data: Buffer): CommitView {
  const blank = data.indexOf('\n\n');
  const headerEnd = blank < 0 ? data.length : blank;
  const headerText = data.toString('utf8', 0, headerEnd);
  const message = blank < 0 ? '' : data.toString('utf8', blank + 2);
  let tree = '';
  const parents: string[] = [];
  let author = '';
  let committer = '';
  for (const line of headerText.split('\n')) {
    if (!line) continue;
    const space = line.indexOf(' ');
    const key = space < 0 ? line : line.slice(0, space);
    const value = space < 0 ? '' : line.slice(space + 1);
    if (key === 'tree') tree = value;
    else if (key === 'parent') parents.push(value);
    else if (key === 'author') author = value;
    else if (key === 'committer') committer = value;
  }
  if (!isOid(tree)) throw new Error('commit has no valid tree header');
  return { tree, parents, author, committer, message };
}

/** The fixed identity and epoch every server-made commit carries (deterministic ids). */
export const FORGE_IDENTITY = 'Forge <forge@example.invalid>';
export const FORGE_EPOCH_SEC = 1735689600;

export function buildCommit(tree: string, parents: readonly string[], message: string): Buffer {
  const lines = [`tree ${tree}`];
  for (const parent of parents) lines.push(`parent ${parent}`);
  const who = `${FORGE_IDENTITY} ${FORGE_EPOCH_SEC} +0000`;
  lines.push(`author ${who}`, `committer ${who}`, '');
  return Buffer.from(`${lines.join('\n')}\n${message}`, 'utf8');
}

export function parseTag(data: Buffer): { object: string; type: ObjType; tag: string; message: string } {
  const blank = data.indexOf('\n\n');
  const headerEnd = blank < 0 ? data.length : blank;
  const headers = new Map<string, string>();
  for (const line of data.toString('utf8', 0, headerEnd).split('\n')) {
    if (!line) continue;
    const space = line.indexOf(' ');
    if (space < 0) continue;
    headers.set(line.slice(0, space), line.slice(space + 1));
  }
  const object = headers.get('object') ?? '';
  const type = (headers.get('type') ?? 'commit') as ObjType;
  return { object, type, tag: headers.get('tag') ?? '', message: blank < 0 ? '' : data.toString('utf8', blank + 2) };
}

// ---------------------------------------------------------------- packfiles

const TYPE_CODE: Record<ObjType, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };
const CODE_TYPE: Record<number, ObjType> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };

function writePackObjectHeader(type: ObjType, size: number): Buffer {
  const code = TYPE_CODE[type];
  const bytes: number[] = [];
  let remaining = size;
  let first = (code << 4) | (remaining & 0x0f);
  remaining = Math.floor(remaining / 16);
  while (remaining > 0) {
    bytes.push(first | 0x80);
    first = remaining & 0x7f;
    remaining = Math.floor(remaining / 128);
  }
  bytes.push(first);
  return Buffer.from(bytes);
}

/** Build a packfile v2 of plain objects (no deltas). Order is the caller's. */
export function writePack(objects: readonly GitObject[]): Buffer {
  const parts: Buffer[] = [];
  const header = Buffer.allocUnsafe(12);
  header.write('PACK', 0, 4, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(objects.length, 8);
  parts.push(header);
  for (const object of objects) {
    parts.push(writePackObjectHeader(object.type, object.data.length));
    parts.push(deflateSync(object.data));
  }
  const withoutTrailer = Buffer.concat(parts);
  const trailer = createHash('sha1').update(withoutTrailer).digest();
  return Buffer.concat([withoutTrailer, trailer]);
}

function readVarintSize(buffer: Buffer, start: number): { size: number; next: number; first: number } {
  let byte = buffer[start] as number;
  let size = byte & 0x0f;
  let shift = 4;
  let offset = start + 1;
  while ((byte & 0x80) !== 0) {
    byte = buffer[offset] as number;
    offset += 1;
    size |= (byte & 0x7f) << shift;
    shift += 7;
  }
  return { size, next: offset, first: buffer[start] as number };
}

/**
 * Apply a pack delta to its base object. The delta is: varint source size, varint target
 * size, then ops — copy (high bit set: offset/size bitfields) or literal insert.
 * Returns null on any malformed op or size mismatch.
 */
function applyDelta(base: Buffer, delta: Buffer): Buffer | null {
  let pos = 0;
  const readVarint = (): number | null => {
    let value = 0;
    let shift = 0;
    while (pos < delta.length) {
      const byte = delta[pos] as number;
      pos += 1;
      value += (byte & 0x7f) * 2 ** shift;
      shift += 7;
      if ((byte & 0x80) === 0) return value;
    }
    return null;
  };
  const sourceSize = readVarint();
  const targetSize = readVarint();
  if (sourceSize === null || targetSize === null || sourceSize !== base.length) return null;
  const out: Buffer[] = [];
  let total = 0;
  while (pos < delta.length) {
    const op = delta[pos] as number;
    pos += 1;
    if ((op & 0x80) !== 0) {
      let copyOffset = 0;
      let copySize = 0;
      for (let i = 0; i < 4; i += 1) {
        if ((op & (1 << i)) !== 0) {
          if (pos >= delta.length) return null;
          copyOffset += (delta[pos] as number) * 2 ** (i * 8);
          pos += 1;
        }
      }
      for (let i = 0; i < 3; i += 1) {
        if ((op & (0x10 << i)) !== 0) {
          if (pos >= delta.length) return null;
          copySize += (delta[pos] as number) * 2 ** (i * 8);
          pos += 1;
        }
      }
      if (copySize === 0) copySize = 0x10000;
      if (copyOffset + copySize > base.length) return null;
      out.push(base.subarray(copyOffset, copyOffset + copySize));
      total += copySize;
    } else if (op !== 0) {
      if (pos + op > delta.length) return null;
      out.push(delta.subarray(pos, pos + op));
      pos += op;
      total += op;
    } else {
      return null; // opcode 0 is reserved
    }
  }
  if (total !== targetSize) return null;
  return Buffer.concat(out);
}

interface PendingDelta {
  readonly baseOid: string | null;
  readonly baseOffset: number | null;
  readonly data: Buffer;
  readonly start: number;
}

/**
 * Read a packfile v2/v3, resolving OFS_DELTA and REF_DELTA entries. The suite's client
 * sends plain objects (which resolve trivially); real git delta-compresses its packs, so
 * a forge that cannot apply deltas cannot take a normal push. `lookup` resolves a
 * REF_DELTA base the pack does not carry (a thin pack's base lives in the store).
 */
export function readPack(pack: Buffer, lookup?: (oid: string) => GitObject | undefined): Map<string, GitObject> | null {
  try {
    if (pack.length < 32) return null;
    if (pack.toString('ascii', 0, 4) !== 'PACK') return null;
    const version = pack.readUInt32BE(4);
    if (version !== 2 && version !== 3) return null;
    const declaredCount = pack.readUInt32BE(8);
    const trailerStart = pack.length - 20;
    const trailer = pack.toString('hex', trailerStart);
    const computed = createHash('sha1').update(pack.subarray(0, trailerStart)).digest('hex');
    if (trailer !== computed) return null;
    const objects = new Map<string, GitObject>();
    const byOffset = new Map<number, GitObject>();
    const pending: PendingDelta[] = [];
    let offset = 12;
    for (let index = 0; index < declaredCount; index += 1) {
      const entryStart = offset;
      const header = readVarintSize(pack, offset);
      offset = header.next;
      const typeCode = (header.first >> 4) & 0x07;
      if (typeCode === 6 || typeCode === 7) {
        let baseOid: string | null = null;
        let baseOffset: number | null = null;
        if (typeCode === 7) {
          baseOid = pack.toString('hex', offset, offset + 20);
          offset += 20;
        } else {
          // OFS_DELTA: a negative offset from this entry's start, variable-length encoded.
          let byte = pack[offset] as number;
          offset += 1;
          let base = byte & 0x7f;
          while ((byte & 0x80) !== 0) {
            byte = pack[offset] as number;
            offset += 1;
            base = ((base + 1) << 7) | (byte & 0x7f);
          }
          baseOffset = entryStart - base;
        }
        const end = findStreamEnd(pack, offset, trailerStart, header.size);
        if (end < 0) return null;
        const data = inflateSync(pack.subarray(offset, end));
        if (data.length !== header.size) return null;
        pending.push({ baseOid, baseOffset, data, start: entryStart });
        offset = end;
        continue;
      }
      const type = CODE_TYPE[typeCode];
      if (type === undefined) return null;
      const end = findStreamEnd(pack, offset, trailerStart, header.size);
      if (end < 0) return null;
      const data = inflateSync(pack.subarray(offset, end));
      if (data.length !== header.size) return null;
      const object: GitObject = { type, data };
      objects.set(hashObject(type, data), object);
      byOffset.set(entryStart, object);
      offset = end;
    }
    if (offset !== trailerStart) return null;
    // Resolve deltas; a delta's base may itself be a delta, so retry until no progress.
    let remaining = pending;
    while (remaining.length > 0) {
      const next: PendingDelta[] = [];
      let progressed = false;
      for (const delta of remaining) {
        let base: GitObject | undefined;
        if (delta.baseOid !== null) {
          base = objects.get(delta.baseOid) ?? (lookup !== undefined ? lookup(delta.baseOid) : undefined);
        } else if (delta.baseOffset !== null) {
          base = byOffset.get(delta.baseOffset);
        }
        if (base === undefined) {
          next.push(delta);
          continue;
        }
        const data = applyDelta(base.data, delta.data);
        if (data === null) return null;
        const object: GitObject = { type: base.type, data };
        objects.set(hashObject(base.type, data), object);
        byOffset.set(delta.start, object);
        progressed = true;
      }
      if (!progressed) return null;
      remaining = next;
    }
    return objects;
  } catch {
    return null;
  }
}

/** Adler-32, the checksum a zlib stream carries in its last 4 bytes. */
function adler32(data: Buffer): number {
  let a = 1;
  let b = 0;
  const MOD = 65521;
  for (let i = 0; i < data.length; i += 1) {
    a = (a + (data[i] as number)) % MOD;
    b = (b + a) % MOD;
  }
  return ((b << 16) | a) >>> 0;
}

/**
 * The exact end of the zlib stream starting at `start`: the smallest end in
 * (start, limit] whose inflate yields exactly `size` bytes. -1 when no such end exists.
 *
 * Fast path: inflate the whole remainder once (inflateSync returns the first stream's
 * data and ignores trailing bytes), then locate the stream end by its Adler-32 trailer
 * and verify it with a single inflate. A binary search over throwing probes costs
 * ~3 ms per pack; this costs one inflate plus one verification.
 */
function findStreamEnd(buffer: Buffer, start: number, limit: number, size: number): number {
  let data: Buffer;
  try {
    data = inflateSync(buffer.subarray(start, limit));
  } catch {
    return findStreamEndSlow(buffer, start, limit, size);
  }
  if (data.length !== size) return findStreamEndSlow(buffer, start, limit, size);
  const needle = Buffer.alloc(4);
  needle.writeUInt32BE(adler32(data), 0);
  let from = start + 2; // past the 2-byte zlib header
  for (;;) {
    const at = buffer.indexOf(needle, from);
    if (at < 0 || at + 4 > limit) break;
    const end = at + 4;
    try {
      if (inflateSync(buffer.subarray(start, end)).length === size) return end;
    } catch {
      // The Adler bytes occurred inside the deflate payload: keep scanning.
    }
    from = at + 1;
  }
  return findStreamEndSlow(buffer, start, limit, size);
}

/**
 * The slow path: binary search for the smallest end whose inflate yields exactly
 * `size` bytes. Node's inflateSync validates the stream's checksum, so a truncated
 * stream never yields the full output and the predicate is monotone.
 */
function findStreamEndSlow(buffer: Buffer, start: number, limit: number, size: number): number {
  let lo = start + 1;
  let hi = limit;
  let found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    let ok = false;
    try {
      ok = inflateSync(buffer.subarray(start, mid)).length === size;
    } catch {
      ok = false;
    }
    if (ok) {
      found = mid;
      hi = mid - 1;
    } else {
      lo = mid + 1;
    }
  }
  return found;
}
