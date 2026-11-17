// The forge's whole state: one in-memory store shared by git smart HTTP, REST v3,
// GraphQL and MCP. Objects are content-addressed and immutable, so trees, commits,
// reachability closures and packfiles are cached globally by id and never invalidated.
// Per-repo derived bytes (advertisements, issue JSON) carry the repo's revision and are
// rebuilt only when that repo changes.

import {
  buildCommit,
  buildTree,
  FORGE_EPOCH_SEC,
  hashObject,
  isOid,
  parseCommit,
  parseTag,
  parseTree,
  writePack,
  ZERO_OID,
  type GitObject,
  type ObjType,
  type TreeEntry,
} from './gitobj.ts';

export interface IssueComment {
  readonly id: number;
  readonly body: string;
}

export interface Issue {
  readonly id: number;
  readonly number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: string[];
  comments: IssueComment[];
  readonly seq: number;
  rev: number;
}

export interface Pull {
  readonly id: number;
  readonly number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  merged: boolean;
  mergedAt: string;
  mergeCommitSha: string | null;
  readonly headRef: string;
  readonly baseRef: string;
  headSha: string;
  baseSha: string;
}

export interface Repo {
  readonly id: number;
  readonly owner: string;
  readonly name: string;
  description: string;
  isPrivate: boolean;
  readonly defaultBranch: string;
  readonly refs: Map<string, string>;
  readonly labels: Map<string, { name: string; color: string }>;
  readonly issues: Map<number, Issue>;
  nextIssue: number;
  readonly pulls: Map<number, Pull>;
  nextPull: number;
  readonly seq: number;
  rev: number;
}

export class Store {
  readonly viewerLogin: string;
  readonly viewerId: number;
  readonly strangerLogin: string;
  readonly org: string;

  private readonly objects = new Map<string, GitObject>();
  private readonly treeCache = new Map<string, TreeEntry[]>();
  private readonly commitCache = new Map<string, { tree: string; parents: string[]; message: string }>();
  private readonly reachCache = new Map<string, Set<string>>();
  private readonly walkCache = new Map<string, string[]>();
  private readonly flatCache = new Map<string, Map<string, { oid: string; mode: string }>>();
  private readonly packCache = new Map<string, Buffer>();
  private readonly repos = new Map<string, Repo>();
  private nextRepoId = 1;
  private nextIssueId = 1;
  private nextCommentId = 1;
  private nextPullId = 1;
  private seq = 0;

  constructor(identity: { viewerLogin: string; viewerId: number; strangerLogin: string; org: string }) {
    this.viewerLogin = identity.viewerLogin;
    this.viewerId = identity.viewerId;
    this.strangerLogin = identity.strangerLogin;
    this.org = identity.org;
  }

  // ---------------------------------------------------------------- objects

  putObject(type: ObjType, data: Buffer): string {
    const oid = hashObject(type, data);
    if (!this.objects.has(oid)) this.objects.set(oid, { type, data });
    return oid;
  }

  getObject(oid: string): GitObject | undefined {
    return this.objects.get(oid);
  }

  hasObject(oid: string): boolean {
    return this.objects.has(oid);
  }

  treeEntries(oid: string): TreeEntry[] {
    let entries = this.treeCache.get(oid);
    if (entries === undefined) {
      const object = this.objects.get(oid);
      if (object === undefined || object.type !== 'tree') throw new Error(`no tree ${oid}`);
      entries = parseTree(object.data);
      this.treeCache.set(oid, entries);
    }
    return entries;
  }

  commitView(oid: string): { tree: string; parents: string[]; message: string } {
    let view = this.commitCache.get(oid);
    if (view === undefined) {
      const object = this.objects.get(oid);
      if (object === undefined || object.type !== 'commit') throw new Error(`no commit ${oid}`);
      const parsed = parseCommit(object.data);
      view = { tree: parsed.tree, parents: parsed.parents, message: parsed.message };
      this.commitCache.set(oid, view);
    }
    return view;
  }

  /** Every object id reachable from `tip` (commits, trees, blobs, tag targets). */
  reachable(tip: string): Set<string> {
    let cached = this.reachCache.get(tip);
    if (cached !== undefined) return cached;
    const out = new Set<string>();
    const stack: string[] = [tip];
    while (stack.length > 0) {
      const oid = stack.pop() as string;
      if (out.has(oid)) continue;
      const object = this.objects.get(oid);
      if (object === undefined) continue;
      out.add(oid);
      if (object.type === 'commit') {
        const view = this.commitView(oid);
        stack.push(view.tree);
        for (const parent of view.parents) stack.push(parent);
      } else if (object.type === 'tree') {
        for (const entry of this.treeEntries(oid)) stack.push(entry.oid);
      } else if (object.type === 'tag') {
        stack.push(parseTag(object.data).object);
      }
    }
    this.reachCache.set(tip, out);
    return out;
  }

  /** Newest-first commit walk from `tip`, following every parent, deduplicated. */
  walkCommits(tip: string): string[] {
    let cached = this.walkCache.get(tip);
    if (cached !== undefined) return cached;
    const out: string[] = [];
    const seen = new Set<string>();
    const stack: string[] = [tip];
    while (stack.length > 0) {
      const oid = stack.pop() as string;
      if (seen.has(oid)) continue;
      seen.add(oid);
      const object = this.objects.get(oid);
      if (object === undefined || object.type !== 'commit') continue;
      out.push(oid);
      const view = this.commitView(oid);
      for (let i = view.parents.length - 1; i >= 0; i -= 1) stack.push(view.parents[i] as string);
    }
    this.walkCache.set(tip, out);
    return out;
  }

  /** First common ancestor of `a` and `b` (merge base), or null. */
  mergeBase(a: string, b: string): string | null {
    const ancestorsA = new Set(this.walkCommits(a));
    for (const oid of this.walkCommits(b)) {
      if (ancestorsA.has(oid)) return oid;
    }
    return null;
  }

  /** Flat path -> blob map of a tree, recursively. */
  /**
   * Every tree and blob oid reachable from `treeOid`, including the tree itself.
   * (flattenTree only lists leaf blobs; a pack needs the intermediate trees too.)
   */
  treeClosure(treeOid: string): Set<string> {
    const out = new Set<string>();
    const stack: string[] = [treeOid];
    while (stack.length > 0) {
      const oid = stack.pop() as string;
      if (out.has(oid)) continue;
      const object = this.objects.get(oid);
      if (object === undefined) continue;
      out.add(oid);
      if (object.type === 'tree') {
        for (const entry of this.treeEntries(oid)) stack.push(entry.oid);
      }
    }
    return out;
  }

  flattenTree(treeOid: string): Map<string, { oid: string; mode: string }> {
    let cached = this.flatCache.get(treeOid);
    if (cached !== undefined) return cached;
    const out = new Map<string, { oid: string; mode: string }>();
    const walk = (oid: string, prefix: string): void => {
      for (const entry of this.treeEntries(oid)) {
        const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
        if (entry.mode === '40000') walk(entry.oid, path);
        else out.set(path, { oid: entry.oid, mode: entry.mode });
      }
    };
    walk(treeOid, '');
    this.flatCache.set(treeOid, out);
    return out;
  }

  /** The blob id at `segments` under `treeOid`, or null. */
  getBlobAt(treeOid: string, segments: readonly string[]): string | null {
    let current = treeOid;
    for (let i = 0; i < segments.length; i += 1) {
      const entry = this.treeEntries(current).find((candidate) => candidate.name === segments[i]);
      if (entry === undefined) return null;
      if (i === segments.length - 1) return entry.mode === '40000' ? null : entry.oid;
      if (entry.mode !== '40000') return null;
      current = entry.oid;
    }
    return null;
  }

  /** The directory entries at `segments` under `treeOid`, or null when it is not a dir. */
  listDir(treeOid: string, segments: readonly string[]): TreeEntry[] | null {
    let current = treeOid;
    for (const segment of segments) {
      const entry = this.treeEntries(current).find((candidate) => candidate.name === segment);
      if (entry === undefined || entry.mode !== '40000') return null;
      current = entry.oid;
    }
    return this.treeEntries(current);
  }

  /**
   * A tree like `treeOid`'s but with `segments` set to `blobOid` (null deletes the path).
   * `treeOid` null means an empty tree. Intermediate directories are created as needed and
   * pruned when they empty out.
   */
  setPath(treeOid: string | null, segments: readonly string[], blobOid: string | null): string {
    const head = segments[0] as string;
    const rest = segments.slice(1);
    const entries = treeOid === null ? [] : this.treeEntries(treeOid);
    const kept = entries.filter((entry) => entry.name !== head);
    if (rest.length === 0) {
      if (blobOid !== null) kept.push({ mode: '100644', name: head, oid: blobOid });
    } else {
      const existing = entries.find((entry) => entry.name === head && entry.mode === '40000');
      const child = this.setPath(existing === undefined ? null : existing.oid, rest, blobOid);
      const childEntries = this.treeEntries(child);
      if (childEntries.length > 0) kept.push({ mode: '40000', name: head, oid: child });
    }
    return this.putObject('tree', buildTree(kept));
  }

  /** Build a tree from a flat path -> blob map, from scratch. */
  buildTreeFromFlat(flat: ReadonlyMap<string, { oid: string; mode: string }>): string {
    let root: string | null = null;
    const paths = [...flat.keys()].sort();
    for (const path of paths) {
      const entry = flat.get(path) as { oid: string; mode: string };
      root = this.setPath(root, path.split('/'), entry.oid);
    }
    if (root === null) return this.putObject('tree', buildTree([]));
    return root;
  }

  /** Pack of the objects reachable from `tip`, optionally cut at `depth` (shallow). */
  packFor(tip: string, depth?: number): Buffer {
    const key = `${tip}|${depth ?? 'full'}`;
    const cached = this.packCache.get(key);
    if (cached !== undefined) return cached;
    let ids: Set<string>;
    if (depth === undefined) {
      ids = this.reachable(tip);
    } else {
      // Shallow: only the commits within `depth` of the tip, plus their trees and blobs.
      ids = new Set<string>();
      let frontier: string[] = [tip];
      for (let level = 0; level < depth && frontier.length > 0; level += 1) {
        const next: string[] = [];
        for (const oid of frontier) {
          if (ids.has(oid)) continue;
          const object = this.objects.get(oid);
          if (object === undefined || object.type !== 'commit') continue;
          ids.add(oid);
          const view = this.commitView(oid);
          for (const treeOid of this.treeClosure(view.tree)) ids.add(treeOid);
          for (const parent of view.parents) next.push(parent);
        }
        frontier = next;
      }
    }
    const objects: GitObject[] = [];
    for (const oid of ids) {
      const object = this.objects.get(oid);
      if (object !== undefined) objects.push(object);
    }
    const pack = writePack(objects);
    this.packCache.set(key, pack);
    return pack;
  }

  /** Shallow boundary of a depth-limited fetch from `tip`: the commits at exactly `depth`. */
  shallowBoundary(tip: string, depth: number): string[] {
    const out: string[] = [];
    let frontier: string[] = [tip];
    const seen = new Set<string>([tip]);
    for (let level = 1; level <= depth; level += 1) {
      const next: string[] = [];
      for (const oid of frontier) {
        const object = this.objects.get(oid);
        if (object === undefined || object.type !== 'commit') continue;
        for (const parent of this.commitView(oid).parents) {
          if (!seen.has(parent)) {
            seen.add(parent);
            next.push(parent);
          }
        }
      }
      if (level === depth) out.push(...next);
      frontier = next;
      if (frontier.length === 0) break;
    }
    return out;
  }

  // ---------------------------------------------------------------- repos

  private repoKey(owner: string, name: string): string {
    return `${owner}\0${name}`;
  }

  createRepo(owner: string, name: string, description: string, isPrivate: boolean): Repo | null {
    const key = this.repoKey(owner, name);
    if (this.repos.has(key)) return null;
    const repo: Repo = {
      id: this.nextRepoId,
      owner,
      name,
      description,
      isPrivate,
      defaultBranch: 'main',
      refs: new Map(),
      labels: new Map(),
      issues: new Map(),
      nextIssue: 1,
      pulls: new Map(),
      nextPull: 1,
      seq: this.seq,
      rev: 0,
    };
    this.nextRepoId += 1;
    this.seq += 1;
    this.repos.set(key, repo);
    return repo;
  }

  getRepo(owner: string, name: string): Repo | undefined {
    return this.repos.get(this.repoKey(owner, name));
  }

  deleteRepo(owner: string, name: string): boolean {
    return this.repos.delete(this.repoKey(owner, name));
  }

  listRepos(owner: string): Repo[] {
    const out: Repo[] = [];
    for (const repo of this.repos.values()) {
      if (repo.owner === owner) out.push(repo);
    }
    out.sort((a, b) => a.seq - b.seq);
    return out;
  }

  /** The tip of `ref` in `repo`, or ZERO_OID when the ref does not exist. */
  refTip(repo: Repo, ref: string): string {
    return repo.refs.get(ref) ?? ZERO_OID;
  }

  headOid(repo: Repo): string {
    return this.refTip(repo, `refs/heads/${repo.defaultBranch}`);
  }

  /** Set a ref (bumping the repo revision so cached advertisements rebuild). */
  setRef(repo: Repo, ref: string, oid: string): void {
    repo.refs.set(ref, oid);
    repo.rev += 1;
  }

  deleteRef(repo: Repo, ref: string): boolean {
    const had = repo.refs.delete(ref);
    if (had) repo.rev += 1;
    return had;
  }

  /** All refs sorted by name (HEAD first is the caller's job). */
  sortedRefs(repo: Repo): [string, string][] {
    return [...repo.refs.entries()].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  }

  // ---------------------------------------------------------------- contents commits

  /**
   * Commit `content` at `path` on `branch` (creating the branch from the default tip,
   * or as a root commit when the repo is unborn). Returns the commit and blob ids.
   */
  commitFile(
    repo: Repo,
    branch: string,
    path: string,
    content: Buffer,
    message: string,
  ): { commitSha: string; blobSha: string } {
    const ref = `refs/heads/${branch}`;
    const parent = this.refTip(repo, ref);
    const hasParent = parent !== ZERO_OID;
    const parentTree = hasParent ? this.commitView(parent).tree : null;
    const blobSha = this.putObject('blob', content);
    const tree = this.setPath(parentTree, path.split('/'), blobSha);
    const commitData = buildCommit(tree, hasParent ? [parent] : [], message.endsWith('\n') ? message : `${message}\n`);
    const commitSha = this.putObject('commit', commitData);
    this.setRef(repo, ref, commitSha);
    return { commitSha, blobSha };
  }

  /** Delete `path` on `branch`; null when the file is not there. */
  deleteFile(repo: Repo, branch: string, path: string, message: string): { commitSha: string } | null {
    const ref = `refs/heads/${branch}`;
    const parent = this.refTip(repo, ref);
    if (parent === ZERO_OID) return null;
    const parentTree = this.commitView(parent).tree;
    if (this.getBlobAt(parentTree, path.split('/')) === null) return null;
    const tree = this.setPath(parentTree, path.split('/'), null);
    const commitData = buildCommit(tree, [parent], message.endsWith('\n') ? message : `${message}\n`);
    const commitSha = this.putObject('commit', commitData);
    this.setRef(repo, ref, commitSha);
    return { commitSha };
  }

  // ---------------------------------------------------------------- issues / pulls

  createIssue(repo: Repo, title: string, body: string, labels: string[]): Issue {
    const issue: Issue = {
      id: this.nextIssueId,
      number: repo.nextIssue,
      title,
      body,
      state: 'open',
      labels: [...labels],
      comments: [],
      seq: this.seq,
      rev: 0,
    };
    this.nextIssueId += 1;
    this.seq += 1;
    repo.nextIssue += 1;
    repo.issues.set(issue.number, issue);
    return issue;
  }

  createPull(repo: Repo, title: string, body: string, headRef: string, baseRef: string): Pull | null {
    const headSha = this.refTip(repo, `refs/heads/${headRef}`);
    const baseSha = this.refTip(repo, `refs/heads/${baseRef}`);
    if (headSha === ZERO_OID || baseSha === ZERO_OID) return null;
    const pull: Pull = {
      id: this.nextPullId,
      number: repo.nextPull,
      title,
      body,
      state: 'open',
      merged: false,
      mergedAt: '',
      mergeCommitSha: null,
      headRef,
      baseRef,
      headSha,
      baseSha,
    };
    this.nextPullId += 1;
    repo.nextPull += 1;
    repo.pulls.set(pull.number, pull);
    return pull;
  }

  /**
   * Whether a three-way merge of `pull` would conflict: true when the same path
   * changed differently on both sides since the merge base, false when it merges
   * cleanly, null when the merge base or a tip is missing.
   */
  mergeConflict(repo: Repo, pull: Pull): boolean | null {
    const baseTip = this.refTip(repo, `refs/heads/${pull.baseRef}`);
    const headTip = this.refTip(repo, `refs/heads/${pull.headRef}`);
    if (baseTip === ZERO_OID || headTip === ZERO_OID) return null;
    const base = this.mergeBase(baseTip, headTip);
    if (base === null) return null;
    const baseTree = this.flattenTree(this.commitView(base).tree);
    const oursTree = this.flattenTree(this.commitView(baseTip).tree);
    const theirsTree = this.flattenTree(this.commitView(headTip).tree);
    const paths = new Set<string>([...baseTree.keys(), ...oursTree.keys(), ...theirsTree.keys()]);
    for (const path of paths) {
      const bId = baseTree.get(path)?.oid ?? null;
      const oId = oursTree.get(path)?.oid ?? null;
      const tId = theirsTree.get(path)?.oid ?? null;
      if (oId === tId) continue;
      if (bId === oId) continue;
      if (bId === tId) continue;
      return true;
    }
    return false;
  }

  /**
   * Squash-merge a pull request onto its base branch. Returns the squash commit id, or
   * null when the three-way merge conflicts (same path changed differently on both sides
   * since the merge base) or the pull is already closed.
   */
  squashMerge(repo: Repo, pull: Pull): { sha: string } | null {
    if (pull.state !== 'open') return null;
    if (this.mergeConflict(repo, pull) !== false) return null;
    const baseTip = this.refTip(repo, `refs/heads/${pull.baseRef}`);
    const headTip = this.refTip(repo, `refs/heads/${pull.headRef}`);
    if (baseTip === ZERO_OID || headTip === ZERO_OID) return null;
    const base = this.mergeBase(baseTip, headTip);
    if (base === null) return null;
    const baseTree = this.flattenTree(this.commitView(base).tree);
    const oursTree = this.flattenTree(this.commitView(baseTip).tree);
    const theirsTree = this.flattenTree(this.commitView(headTip).tree);
    const merged = new Map<string, { oid: string; mode: string }>();
    const paths = new Set<string>([...baseTree.keys(), ...oursTree.keys(), ...theirsTree.keys()]);
    for (const path of paths) {
      const b = baseTree.get(path);
      const o = oursTree.get(path);
      const t = theirsTree.get(path);
      const oId = o?.oid ?? null;
      const tId = t?.oid ?? null;
      const bId = b?.oid ?? null;
      if (oId === tId) {
        if (o !== undefined) merged.set(path, o);
      } else if (bId === oId) {
        if (t !== undefined) merged.set(path, t);
      } else if (bId === tId) {
        if (o !== undefined) merged.set(path, o);
      } else {
        return null; // both sides changed the path differently: conflict
      }
    }
    const tree = this.buildTreeFromFlat(merged);
    const message = `${pull.title}\n`;
    const commitData = buildCommit(tree, [baseTip], message);
    const sha = this.putObject('commit', commitData);
    this.setRef(repo, `refs/heads/${pull.baseRef}`, sha);
    pull.state = 'closed';
    pull.merged = true;
    pull.mergedAt = new Date(FORGE_EPOCH_SEC * 1000).toISOString();
    pull.mergeCommitSha = sha;
    return { sha };
  }

  /** Line counts of a blob (text), for pull-request file stats. */
  lineCount(blobOid: string): number {
    const object = this.objects.get(blobOid);
    if (object === undefined) return 0;
    const text = object.data.toString('utf8');
    if (text === '') return 0;
    return text.split('\n').length - (text.endsWith('\n') ? 1 : 0);
  }

  /** The diff between two tip commits, as file rows (added/modified/removed). */
  diffFiles(baseTip: string, headTip: string): { filename: string; status: string; additions: number; deletions: number; changes: number }[] {
    const base = baseTip === ZERO_OID ? new Map() : this.flattenTree(this.commitView(baseTip).tree);
    const head = headTip === ZERO_OID ? new Map() : this.flattenTree(this.commitView(headTip).tree);
    const rows: { filename: string; status: string; additions: number; deletions: number; changes: number }[] = [];
    const paths = new Set<string>([...base.keys(), ...head.keys()]);
    for (const path of [...paths].sort()) {
      const b = base.get(path);
      const h = head.get(path);
      if (b !== undefined && h !== undefined && b.oid === h.oid) continue;
      if (b === undefined && h !== undefined) {
        const additions = this.lineCount(h.oid);
        rows.push({ filename: path, status: 'added', additions, deletions: 0, changes: additions });
      } else if (b !== undefined && h === undefined) {
        const deletions = this.lineCount(b.oid);
        rows.push({ filename: path, status: 'removed', additions: 0, deletions, changes: deletions });
      } else if (b !== undefined && h !== undefined) {
        const additions = this.lineCount(h.oid);
        const deletions = this.lineCount(b.oid);
        rows.push({ filename: path, status: 'modified', additions, deletions, changes: additions + deletions });
      }
    }
    return rows;
  }
}
