// git smart HTTP: v0/v2 upload-pack advertisement, v2 ls-refs and fetch, v0
// receive-pack. The wire shapes are the suite's own git-client's: every response here
// is built to parse under its decoder, its advertisement parser, its v2 fetch parser
// and its push-report parser.

import {
  decodePktLines,
  encodePktLine,
  encodePktLines,
  FLUSH,
  parseTag,
  readPack,
  writePack,
  ZERO_OID,
  type GitObject,
} from './gitobj.ts';
import { type Repo, type Store } from './store.ts';

const AGENT = 'git/github-core-clone-01';
const UPLOAD_AD_CT = 'application/x-git-upload-pack-advertisement';
const UPLOAD_RESULT_CT = 'application/x-git-upload-pack-result';
const RECEIVE_AD_CT = 'application/x-git-receive-pack-advertisement';
const RECEIVE_RESULT_CT = 'application/x-git-receive-pack-result';

export interface GitResponse {
  readonly status: number;
  readonly contentType: string;
  readonly body: Buffer;
}

function textResponse(status: number, contentType: string, body: string | Buffer): GitResponse {
  return { status, contentType, body: typeof body === 'string' ? Buffer.from(body, 'utf8') : body };
}

interface AdvCache {
  rev: number;
  v0Upload: Buffer;
  v2Upload: Buffer;
  v0Receive: Buffer;
}

const advCache = new WeakMap<Repo, AdvCache>();

function peeledOid(store: Store, oid: string): string | null {
  const object = store.getObject(oid);
  if (object === undefined || object.type !== 'tag') return null;
  return parseTag(object.data).object;
}

/** The v0 ref lines for a repo (HEAD first, then refs sorted, peeled tags inline). */
function v0RefLines(store: Store, repo: Repo, headOid: string, capabilities: string): Buffer {
  const lines: (string | Buffer)[] = [];
  const refs = store.sortedRefs(repo);
  if (refs.length === 0) {
    lines.push(`${ZERO_OID} capabilities^{}\0${capabilities}\n`);
    return encodePktLines(lines);
  }
  lines.push(`${headOid} HEAD\0${capabilities}\n`);
  for (const [name, oid] of refs) {
    lines.push(`${oid} ${name}\n`);
    const peeled = peeledOid(store, oid);
    if (peeled !== null) lines.push(`${peeled} ${name}^{}\n`);
  }
  return encodePktLines(lines);
}

function buildAdvertisements(store: Store, repo: Repo): AdvCache {
  const headOid = store.headOid(repo);
  const v0Upload = Buffer.concat([
    encodePktLine('# service=git-upload-pack\n'),
    FLUSH,
    v0RefLines(store, repo, headOid, `symref=HEAD:refs/heads/${repo.defaultBranch} side-band-64k ofs-delta agent=${AGENT}`),
    FLUSH,
  ]);
  const v2Upload = encodePktLines([
    'version 2\n',
    `agent=${AGENT}\n`,
    'ls-refs\n',
    'fetch=shallow wait-for-done\n',
    'object-format=sha1\n',
    'flush',
  ]);
  const v0Receive = Buffer.concat([
    encodePktLine('# service=git-receive-pack\n'),
    FLUSH,
    v0RefLines(store, repo, headOid, `report-status side-band-64k delete-refs ofs-delta agent=${AGENT}`),
    FLUSH,
  ]);
  return { rev: repo.rev, v0Upload, v2Upload, v0Receive };
}

function advertisements(store: Store, repo: Repo): AdvCache {
  const cached = advCache.get(repo);
  if (cached !== undefined && cached.rev === repo.rev) return cached;
  const built = buildAdvertisements(store, repo);
  advCache.set(repo, built);
  return built;
}

/** GET /{owner}/{repo}.git/info/refs?service=... — v2 when asked, v0 otherwise. */
export function infoRefs(store: Store, repo: Repo, service: 'git-upload-pack' | 'git-receive-pack', wantV2: boolean): GitResponse {
  const adv = advertisements(store, repo);
  if (service === 'git-receive-pack') {
    return { status: 200, contentType: RECEIVE_AD_CT, body: adv.v0Receive };
  }
  if (wantV2) return { status: 200, contentType: UPLOAD_AD_CT, body: adv.v2Upload };
  return { status: 200, contentType: UPLOAD_AD_CT, body: adv.v0Upload };
}

// ---------------------------------------------------------------- fetch

interface FetchRequest {
  wants: string[];
  haves: string[];
  shallow: string[];
  depth?: number;
  done: boolean;
}

/** Parse a v2 command request (ls-refs or fetch) into its command and argument lines. */
function parseV2Command(body: Buffer): { command: string; args: string[] } | null {
  const packets = decodePktLines(body);
  if (packets === null) return null;
  let command = '';
  const args: string[] = [];
  let seenDelim = false;
  for (const packet of packets) {
    if (packet.kind === 'flush') break;
    if (packet.kind === 'delim') {
      seenDelim = true;
      continue;
    }
    if (packet.kind !== 'data') return null;
    const line = packet.payload.toString('utf8');
    if (!seenDelim) {
      if (line.startsWith('command=')) command = line.slice('command='.length).replace(/\n$/, '');
      // agent= / object-format= lines before the delim are acknowledged, not needed.
    } else {
      args.push(line.replace(/\n$/, ''));
    }
  }
  return command === '' ? null : { command, args };
}

/** Commits within `depth` levels of `wants` (level 0 = the wants), plus their trees/blobs. */
function depthLimitedClosure(store: Store, wants: readonly string[], depth: number | undefined): Set<string> {
  const out = new Set<string>();
  if (depth === undefined) {
    for (const want of wants) {
      for (const oid of store.reachable(want)) out.add(oid);
    }
    return out;
  }
  let frontier = [...wants];
  for (let level = 0; level < depth && frontier.length > 0; level += 1) {
    const next: string[] = [];
    for (const oid of frontier) {
      if (out.has(oid)) continue;
      const object = store.getObject(oid);
      if (object === undefined || object.type !== 'commit') continue;
      out.add(oid);
      const view = store.commitView(oid);
      for (const treeOid of store.treeClosure(view.tree)) out.add(treeOid);
      for (const parent of view.parents) next.push(parent);
    }
    frontier = next;
  }
  return out;
}

/** What the client already holds under a have, truncated at its shallow boundary. */
function shallowTruncatedClosure(store: Store, have: string, shallowSet: ReadonlySet<string>): Set<string> {
  const out = new Set<string>();
  const stack: string[] = [have];
  while (stack.length > 0) {
    const oid = stack.pop() as string;
    if (out.has(oid)) continue;
    const object = store.getObject(oid);
    if (object === undefined) continue;
    if (object.type === 'commit') {
      out.add(oid);
      const view = store.commitView(oid);
      for (const treeOid of store.treeClosure(view.tree)) out.add(treeOid);
      if (!shallowSet.has(oid)) {
        for (const parent of view.parents) stack.push(parent);
      }
    } else if (object.type === 'tree') {
      out.add(oid);
      for (const entry of store.treeEntries(oid)) stack.push(entry.oid);
    } else if (object.type === 'tag') {
      out.add(oid);
      stack.push(parseTag(object.data).object);
    } else {
      out.add(oid);
    }
  }
  return out;
}

/** Commits at exactly level `depth - 1` below `wants` (the new shallow boundary). */
function boundaryAtDepth(store: Store, wants: readonly string[], depth: number): string[] {
  let frontier = [...wants];
  const seen = new Set<string>(frontier);
  for (let level = 1; level < depth; level += 1) {
    const next: string[] = [];
    for (const oid of frontier) {
      const object = store.getObject(oid);
      if (object === undefined || object.type !== 'commit') continue;
      for (const parent of store.commitView(oid).parents) {
        if (!seen.has(parent)) {
          seen.add(parent);
          next.push(parent);
        }
      }
    }
    frontier = next;
    if (frontier.length === 0) break;
  }
  return frontier;
}

const fetchPackCache = new Map<string, Buffer>();

function sidebandPack(pack: Buffer): Buffer {
  const parts: Buffer[] = [];
  const CHUNK = 32768;
  for (let offset = 0; offset < pack.length; offset += CHUNK) {
    const slice = pack.subarray(offset, Math.min(pack.length, offset + CHUNK));
    const framed = Buffer.allocUnsafe(slice.length + 1);
    framed[0] = 1;
    slice.copy(framed, 1);
    parts.push(encodePktLine(framed));
  }
  return Buffer.concat(parts);
}

/** POST /{owner}/{repo}.git/git-upload-pack — v2 ls-refs or fetch. */
export function uploadPack(store: Store, repo: Repo, body: Buffer): GitResponse {
  const parsed = parseV2Command(body);
  if (parsed === null) {
    return textResponse(400, UPLOAD_RESULT_CT, 'bad request');
  }
  if (parsed.command === 'ls-refs') {
    return lsRefs(store, repo, parsed.args);
  }
  if (parsed.command === 'fetch') {
    return fetch(store, repo, parsed.args);
  }
  return textResponse(400, UPLOAD_RESULT_CT, 'unknown command');
}

function lsRefs(store: Store, repo: Repo, args: readonly string[]): GitResponse {
  const peel = args.includes('peel');
  const symrefs = args.includes('symrefs');
  const prefixes: string[] = [];
  for (const arg of args) {
    if (arg.startsWith('ref-prefix ')) prefixes.push(arg.slice('ref-prefix '.length));
  }
  const keep = (name: string): boolean => prefixes.length === 0 || prefixes.some((prefix) => name.startsWith(prefix));
  const lines: string[] = [];
  const headOid = store.headOid(repo);
  const headTarget = `refs/heads/${repo.defaultBranch}`;
  if (keep('HEAD')) {
    if (headOid === ZERO_OID) {
      lines.push(`unborn HEAD${symrefs ? ` symref-target:${headTarget}` : ''}\n`);
    } else if (symrefs) {
      lines.push(`${headOid} HEAD symref-target:${headTarget}\n`);
    } else {
      lines.push(`${headOid} HEAD\n`);
    }
  }
  for (const [name, oid] of store.sortedRefs(repo)) {
    if (!keep(name)) continue;
    let line = `${oid} ${name}`;
    if (peel) {
      const peeled = peeledOid(store, oid);
      if (peeled !== null) line += ` peeled:${peeled}`;
    }
    lines.push(`${line}\n`);
  }
  lines.push('flush');
  return { status: 200, contentType: UPLOAD_RESULT_CT, body: encodePktLines(lines) };
}

function fetch(store: Store, repo: Repo, args: readonly string[]): GitResponse {
  const req: FetchRequest = { wants: [], haves: [], shallow: [], done: false };
  for (const arg of args) {
    if (arg.startsWith('want ')) req.wants.push(arg.slice(5));
    else if (arg.startsWith('have ')) req.haves.push(arg.slice(5));
    else if (arg.startsWith('shallow ')) req.shallow.push(arg.slice(8));
    else if (arg.startsWith('deepen ')) req.depth = parseInt(arg.slice(7), 10);
    else if (arg === 'done') req.done = true;
    // thin-pack, no-progress, ofs-delta, filter, deepen-since, deepen-not: acknowledged, not needed.
  }
  const wanted = depthLimitedClosure(store, req.wants, req.depth);
  const shallowSet = new Set(req.shallow);
  const held = new Set<string>();
  for (const have of req.haves) {
    for (const oid of shallowTruncatedClosure(store, have, shallowSet)) held.add(oid);
  }
  const sendIds = [...wanted].filter((oid) => !held.has(oid));
  const cacheKey = `${req.wants.join(',')}|${req.haves.join(',')}|${req.shallow.join(',')}|${req.depth ?? ''}`;
  let pack = fetchPackCache.get(cacheKey);
  if (pack === undefined) {
    const objects: GitObject[] = [];
    for (const oid of sendIds) {
      const object = store.getObject(oid);
      if (object !== undefined) objects.push(object);
    }
    // Deterministic order: commits first (walk order), then the rest by id.
    objects.sort((a, b) => {
      if (a.type === 'commit' && b.type !== 'commit') return -1;
      if (a.type !== 'commit' && b.type === 'commit') return 1;
      return 0;
    });
    pack = writePack(objects);
    fetchPackCache.set(cacheKey, pack);
  }

  const parts: Buffer[] = [];
  // Protocol v2 acknowledgments, matching real git's server (verified against git
  // daemon): the section is sent whenever the client sent haves — with or without
  // `done` (real git negotiates: haves first, `done` only after the acks). With
  // no haves the response goes straight to shallow-info / packfile. One `ACK`
  // per have the server holds (in request order), plus `ready` when at least one
  // was ACKed; `NAK` when none was common. The section ends with DELIM (0001),
  // not flush, because the packfile section follows in the same response.
  if (req.haves.length > 0) {
    const ackLines: string[] = [];
    let anyCommon = false;
    for (const have of req.haves) {
      if (store.hasObject(have)) {
        ackLines.push(`ACK ${have}\n`);
        anyCommon = true;
      }
    }
    if (anyCommon) ackLines.push('ready\n');
    else ackLines.push('NAK\n');
    parts.push(encodePktLines(['acknowledgments\n', ...ackLines, 'delim']));
  }
  const shallowLines: string[] = [];
  const unshallowLines: string[] = [];
  if (req.depth !== undefined) {
    const boundary = boundaryAtDepth(store, req.wants, req.depth);
    for (const oid of boundary) shallowLines.push(`shallow ${oid}\n`);
    // An old shallow commit whose parent is now included stops being shallow.
    // `included` is the same closure as `wanted`: reuse it, do not recompute.
    const boundarySet = new Set(boundary);
    for (const old of req.shallow) {
      if (!boundarySet.has(old) && wanted.has(old)) {
        // Its parents are included when it sits above the boundary level.
        const object = store.getObject(old);
        if (object !== undefined && object.type === 'commit') {
          const parents = store.commitView(old).parents;
          if (parents.every((parent) => wanted.has(parent)) && parents.length > 0) {
            unshallowLines.push(`unshallow ${old}\n`);
          }
        }
      }
    }
  } else if (req.shallow.length > 0) {
    for (const oid of req.shallow) shallowLines.push(`shallow ${oid}\n`);
  }
  if (shallowLines.length > 0 || unshallowLines.length > 0) {
    parts.push(encodePktLines(['shallow-info\n', ...shallowLines, ...unshallowLines, 'flush']));
  }
  parts.push(encodePktLine('packfile\n'));
  parts.push(sidebandPack(pack));
  parts.push(FLUSH);
  return { status: 200, contentType: UPLOAD_RESULT_CT, body: Buffer.concat(parts) };
}

// ---------------------------------------------------------------- receive-pack

interface PushCommand {
  oldOid: string;
  newOid: string;
  ref: string;
}

/** POST /{owner}/{repo}.git/git-receive-pack — v0 command list + pack, report-status. */
export function receivePack(store: Store, repo: Repo, body: Buffer): GitResponse {
  const commands: PushCommand[] = [];
  let packStart = -1;
  // Walk the raw body: pkt-lines until the first flush, then the pack bytes. The pack
  // itself is binary, so the command list is parsed by hand, not as pkt-lines.
  {
    let cursor = 0;
    let first = true;
    let ok = true;
    while (cursor < body.length) {
      if (cursor + 4 > body.length) {
        ok = false;
        break;
      }
      const head = body.toString('ascii', cursor, cursor + 4);
      if (head === '0000') {
        cursor += 4;
        packStart = cursor;
        break;
      }
      if (!/^[0-9a-fA-F]{4}$/.test(head)) {
        ok = false;
        break;
      }
      const len = parseInt(head, 16);
      if (len < 4 || cursor + len > body.length) {
        ok = false;
        break;
      }
      const payload = body.toString('utf8', cursor + 4, cursor + len);
      let line = payload.replace(/\n$/, '');
      if (first) {
        const nul = line.indexOf('\0');
        if (nul >= 0) line = line.slice(0, nul);
        first = false;
      }
      const match = /^([0-9a-f]{40}) ([0-9a-f]{40}) (\S+)$/.exec(line);
      if (match === null) {
        ok = false;
        break;
      }
      commands.push({ oldOid: match[1] as string, newOid: match[2] as string, ref: match[3] as string });
      cursor += len;
    }
    if (!ok) {
      return textResponse(400, RECEIVE_RESULT_CT, 'malformed command list');
    }
  }
  if (commands.length === 0) {
    return textResponse(400, RECEIVE_RESULT_CT, 'no commands');
  }
  const updatesRef = commands.some((command) => command.newOid !== ZERO_OID);
  const packBytes = packStart >= 0 ? body.subarray(packStart) : Buffer.alloc(0);
  let unpackOk = true;
  let unpackDetail = 'ok';
  if (updatesRef) {
    if (packBytes.length === 0) {
      unpackOk = false;
      unpackDetail = 'missing packfile';
    } else {
      // The store lookup resolves a thin pack's REF_DELTA base that the pack does not carry.
      const objects = readPack(packBytes, (oid) => store.getObject(oid));
      if (objects === null) {
        unpackOk = false;
        unpackDetail = 'packfile failed to parse';
      } else {
        for (const [oid, object] of objects) {
          if (!store.hasObject(oid)) store.putObject(object.type, object.data);
        }
      }
    }
  }

  const results: { ref: string; ok: boolean; reason: string }[] = [];
  for (const command of commands) {
    if (!unpackOk) {
      results.push({ ref: command.ref, ok: false, reason: 'unpack failed' });
      continue;
    }
    const current = store.refTip(repo, command.ref);
    if (command.oldOid === ZERO_OID && command.newOid === ZERO_OID) {
      results.push({ ref: command.ref, ok: false, reason: 'invalid command' });
    } else if (command.newOid === ZERO_OID) {
      // Delete: the old id must match the current tip.
      if (current === ZERO_OID) {
        results.push({ ref: command.ref, ok: false, reason: 'non-fast-forward' });
      } else if (command.oldOid !== ZERO_OID && command.oldOid !== current) {
        results.push({ ref: command.ref, ok: false, reason: 'non-fast-forward' });
      } else {
        store.deleteRef(repo, command.ref);
        results.push({ ref: command.ref, ok: true, reason: '' });
      }
    } else if (command.oldOid === ZERO_OID) {
      // Create: the ref must not exist yet, and the new object must be known.
      if (current !== ZERO_OID) {
        results.push({ ref: command.ref, ok: false, reason: 'non-fast-forward' });
      } else if (!store.hasObject(command.newOid)) {
        results.push({ ref: command.ref, ok: false, reason: 'unable to read new object' });
      } else {
        store.setRef(repo, command.ref, command.newOid);
        results.push({ ref: command.ref, ok: true, reason: '' });
      }
    } else {
      // Update: old must match the tip and the new tip must descend from it.
      if (current !== command.oldOid) {
        results.push({ ref: command.ref, ok: false, reason: 'non-fast-forward' });
      } else if (!store.hasObject(command.newOid)) {
        results.push({ ref: command.ref, ok: false, reason: 'unable to read new object' });
      } else if (command.newOid === command.oldOid) {
        results.push({ ref: command.ref, ok: true, reason: '' });
      } else if (!isAncestor(store, command.oldOid, command.newOid)) {
        results.push({ ref: command.ref, ok: false, reason: 'non-fast-forward' });
      } else {
        store.setRef(repo, command.ref, command.newOid);
        results.push({ ref: command.ref, ok: true, reason: '' });
      }
    }
  }

  // report-status inside sideband band 1: the band-1 payload is itself a pkt-line
  // stream (real git parses it with its pkt-line reader). The whole report —
  // every line plus its own terminating flush — goes in ONE outer band-1 packet,
  // followed by the outer flush. (One outer packet per line, or a missing inner
  // flush, makes real git fail with "remote end hung up unexpectedly".)
  const inner: string[] = [unpackOk ? 'unpack ok\n' : `unpack ${unpackDetail}\n`];
  for (const result of results) {
    inner.push(result.ok ? `ok ${result.ref}\n` : `ng ${result.ref} ${result.reason}\n`);
  }
  const innerStream = Buffer.concat([...inner.map((line) => encodePktLine(line)), FLUSH]);
  const framed = Buffer.allocUnsafe(innerStream.length + 1);
  framed[0] = 1;
  innerStream.copy(framed, 1);
  return { status: 200, contentType: RECEIVE_RESULT_CT, body: Buffer.concat([encodePktLine(framed), FLUSH]) };
}

/** True when `ancestor` is reachable from `oid` (including equality). Walks parents depth-first
 * and stops at the first match: a fast-forward check on a long linear history is O(1), not O(n). */
function isAncestor(store: Store, ancestor: string, oid: string): boolean {
  if (ancestor === oid) return true;
  const seen = new Set<string>();
  const stack: string[] = [oid];
  while (stack.length > 0) {
    const current = stack.pop() as string;
    if (current === ancestor) return true;
    if (seen.has(current)) continue;
    seen.add(current);
    const object = store.getObject(current);
    if (object === undefined || object.type !== 'commit') continue;
    for (const parent of store.commitView(current).parents) stack.push(parent);
  }
  return false;
}

// ---------------------------------------------------------------- dispatcher

/**
 * Route one git smart-HTTP request. `repo` is undefined when the repository does not
 * exist under the viewer (a missing repo is 404 on both services, and the server keeps
 * serving afterwards). v2 is honoured only for upload-pack: receive-pack info/refs is
 * always v0, because the suite's fixture push requires it.
 */
export function handleGit(
  store: Store,
  repo: Repo | undefined,
  tail: string,
  method: string,
  query: URLSearchParams,
  body: Buffer,
  headers: Readonly<Record<string, string | string[] | undefined>>,
): GitResponse {
  if (repo === undefined) {
    return textResponse(404, 'text/plain', 'Not Found');
  }
  if (tail === 'info/refs') {
    if (method !== 'GET') return textResponse(405, 'text/plain', 'Method Not Allowed');
    const service = query.get('service');
    if (service !== 'git-upload-pack' && service !== 'git-receive-pack') {
      return textResponse(400, 'text/plain', 'Invalid service');
    }
    const protocol = headers['git-protocol'];
    const wantV2 = service === 'git-upload-pack' && (Array.isArray(protocol) ? protocol.includes('version=2') : protocol === 'version=2');
    return infoRefs(store, repo, service, wantV2);
  }
  if (tail === 'git-upload-pack') {
    if (method !== 'POST') return textResponse(405, 'text/plain', 'Method Not Allowed');
    return uploadPack(store, repo, body);
  }
  if (tail === 'git-receive-pack') {
    if (method !== 'POST') return textResponse(405, 'text/plain', 'Method Not Allowed');
    return receivePack(store, repo, body);
  }
  return textResponse(404, 'text/plain', 'Not Found');
}
