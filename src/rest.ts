// GitHub REST v3: repositories, branches, commits, contents, labels, issues,
// comments and pull requests, over the one shared store. Shapes follow the suite's
// checks: every required field is present with the right type, ids are stable across
// reads, and errors are JSON {message} with the status the checks assert.

import { FORGE_EPOCH_SEC } from './gitobj.ts';
import { type Issue, type Pull, type Repo, type Store } from './store.ts';
import { ZERO_OID } from './gitobj.ts';

export interface RestReply {
  readonly status: number;
  readonly json: unknown;
  readonly headers?: Readonly<Record<string, string>>;
}

export const NO_CONTENT: RestReply = { status: 204, json: null };

function ok(json: unknown, headers?: Readonly<Record<string, string>>): RestReply {
  return { status: 200, json, headers };
}

function created(json: unknown): RestReply {
  return { status: 201, json };
}

function err(status: number, message: string): RestReply {
  return { status, json: { message } };
}

function notFound(what = 'Not Found'): RestReply {
  return err(404, what);
}

function isoAt(seq: number): string {
  return new Date((FORGE_EPOCH_SEC + seq) * 1000).toISOString();
}

// ---------------------------------------------------------------- shapes

export function repoJson(repo: Repo, ownerId: number): Record<string, unknown> {
  return {
    id: repo.id,
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    owner: { login: repo.owner, id: ownerId, type: 'User' },
    private: repo.isPrivate,
    description: repo.description,
    default_branch: repo.defaultBranch,
    created_at: isoAt(repo.seq),
    updated_at: isoAt(repo.seq),
    html_url: `https://example.invalid/${repo.owner}/${repo.name}`,
  };
}

export function issueJson(repo: Repo, issue: Issue): Record<string, unknown> {
  return {
    id: issue.id,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map((name) => ({ name })),
    user: { login: repo.owner, type: 'User' },
    created_at: isoAt(issue.seq),
    updated_at: isoAt(issue.seq),
    html_url: `https://example.invalid/${repo.owner}/${repo.name}/issues/${issue.number}`,
  };
}

export function pullJson(repo: Repo, pull: Pull): Record<string, unknown> {
  return {
    id: pull.id,
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.state,
    merged: pull.merged,
    merged_at: pull.merged ? pull.mergedAt : null,
    merge_commit_sha: pull.mergeCommitSha,
    head: { ref: pull.headRef, sha: pull.headSha, label: `${repo.owner}:${pull.headRef}` },
    base: { ref: pull.baseRef, sha: pull.baseSha, label: `${repo.owner}:${pull.baseRef}` },
    user: { login: repo.owner, type: 'User' },
    html_url: `https://example.invalid/${repo.owner}/${repo.name}/pull/${pull.number}`,
  };
}

// ---------------------------------------------------------------- caches (hot paths)

const repoJsonCache = new WeakMap<Repo, { rev: number; json: Record<string, unknown> }>();
const issueJsonCache = new WeakMap<Repo, Map<number, { rev: number; json: Record<string, unknown> }>>();
const b64Cache = new Map<string, string>();

export function cachedRepoJson(repo: Repo, ownerId: number): Record<string, unknown> {
  const cached = repoJsonCache.get(repo);
  if (cached !== undefined && cached.rev === repo.rev) return cached.json;
  const json = repoJson(repo, ownerId);
  repoJsonCache.set(repo, { rev: repo.rev, json });
  return json;
}

export function cachedIssueJson(repo: Repo, issue: Issue): Record<string, unknown> {
  let perRepo = issueJsonCache.get(repo);
  if (perRepo === undefined) {
    perRepo = new Map();
    issueJsonCache.set(repo, perRepo);
  }
  const cached = perRepo.get(issue.number);
  if (cached !== undefined && cached.rev === issue.rev) return cached.json;
  const json = issueJson(repo, issue);
  perRepo.set(issue.number, { rev: issue.rev, json });
  return json;
}

function b64Of(data: Buffer, oid: string): string {
  let cached = b64Cache.get(oid);
  if (cached === undefined) {
    cached = data.toString('base64');
    if (b64Cache.size < 10000) b64Cache.set(oid, cached);
  }
  return cached;
}

// ---------------------------------------------------------------- pagination

interface Page {
  items: unknown[];
  link: string | null;
}

function paginate<T>(all: readonly T[], query: ReadonlyMap<string, string>, origin: string, path: string): Page {
  const perPageRaw = parseInt(query.get('per_page') ?? '30', 10);
  const perPage = Number.isFinite(perPageRaw) ? Math.min(100, Math.max(1, perPageRaw)) : 30;
  const pageRaw = parseInt(query.get('page') ?? '1', 10);
  const page = Number.isFinite(pageRaw) ? Math.max(1, pageRaw) : 1;
  const totalPages = Math.max(1, Math.ceil(all.length / perPage));
  const start = (page - 1) * perPage;
  const items = all.slice(start, start + perPage) as unknown[];
  const kept = new URLSearchParams();
  for (const [key, value] of query) {
    if (key !== 'page') kept.set(key, value);
  }
  kept.set('per_page', String(perPage));
  let link: string | null = null;
  if (page < totalPages) {
    const next = new URLSearchParams(kept);
    next.set('page', String(page + 1));
    const last = new URLSearchParams(kept);
    last.set('page', String(totalPages));
    link = `<${origin}${path}?${next.toString()}>; rel="next", <${origin}${path}?${last.toString()}>; rel="last"`;
  }
  return { items, link };
}

// ---------------------------------------------------------------- router

type Body = Record<string, unknown>;

function asString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function asBool(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

/** The repo at /repos/{owner}/{name}, or null when the owner is not the viewer or it is missing. */
function findRepo(store: Store, owner: string, name: string): Repo | null {
  if (owner !== store.viewerLogin) return null;
  return store.getRepo(owner, name) ?? null;
}

function decodeSegment(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

/**
 * Handle one REST call. `segments` are the path parts after /api/v3 (already split on '/').
 * `query` is the parsed query string. `body` is the parsed JSON body (null when absent or
 * unparseable — the http layer answers 400 for a malformed body before this runs).
 */
export function handleRest(
  store: Store,
  method: string,
  segments: readonly string[],
  query: ReadonlyMap<string, string>,
  body: Body | null,
  origin: string,
): RestReply {
  const seg = segments.map(decodeSegment);
  const first = seg[0] ?? '';

  // GET /api/v3/ — the root.
  if (seg.length === 0) {
    if (method !== 'GET') return err(405, 'Method Not Allowed');
    return ok({}, { 'X-OAuth-Scopes': 'repo, read:org' });
  }
  if (first === 'meta' && seg.length === 1) {
    if (method !== 'GET') return err(405, 'Method Not Allowed');
    return ok({ installed_version: '1.0.0' });
  }
  if (first === 'user') return handleUser(store, method, seg.slice(1), query, body, origin);
  if (first === 'repos') return handleRepos(store, method, seg.slice(1), query, body, origin);
  return notFound('Not Found');
}

function handleUser(
  store: Store,
  method: string,
  seg: readonly string[],
  query: ReadonlyMap<string, string>,
  body: Body | null,
  origin: string,
): RestReply {
  if (seg.length === 0) {
    if (method !== 'GET') return err(405, 'Method Not Allowed');
    return ok({
      login: store.viewerLogin,
      id: store.viewerId,
      name: '',
      email: '',
      type: 'User',
    });
  }
  if (seg[0] === 'repos') {
    if (seg.length === 1 && method === 'GET') {
      const repos = store.listRepos(store.viewerLogin);
      const page = paginate(repos.map((repo) => cachedRepoJson(repo, store.viewerId)), query, origin, '/api/v3/user/repos');
      return ok(page.items, page.link === null ? undefined : { Link: page.link });
    }
    if (seg.length === 1 && method === 'POST') {
      const name = asString(body?.name);
      if (name === '') return err(422, 'name is required');
      const description = asString(body?.description);
      const isPrivate = asBool(body?.private, false);
      const repo = store.createRepo(store.viewerLogin, name, description, isPrivate);
      if (repo === null) return err(422, `Repository ${name} already exists`);
      return created(cachedRepoJson(repo, store.viewerId));
    }
    return notFound('Not Found');
  }
  return notFound('Not Found');
}

function handleRepos(
  store: Store,
  method: string,
  seg: readonly string[],
  query: ReadonlyMap<string, string>,
  body: Body | null,
  origin: string,
): RestReply {
  const owner = seg[0] ?? '';
  const name = seg[1] ?? '';
  if (owner === '' || name === '') return notFound('Not Found');
  const repo = findRepo(store, owner, name);
  if (repo === null) return notFound('Not Found');
  const rest = seg.slice(2);
  if (rest.length === 0) {
    if (method === 'GET') return ok(cachedRepoJson(repo, store.viewerId));
    if (method === 'PATCH') {
      if (body !== null && typeof body.description === 'string') {
        repo.description = body.description;
        repo.rev += 1;
      }
      return ok(cachedRepoJson(repo, store.viewerId));
    }
    if (method === 'DELETE') {
      store.deleteRepo(owner, name);
      return NO_CONTENT;
    }
    return err(405, 'Method Not Allowed');
  }
  const section = rest[0] as string;
  switch (section) {
    case 'branches':
      return handleBranches(store, repo, method, rest.slice(1));
    case 'commits':
      return handleCommits(store, repo, method, query);
    case 'git':
      return handleGitRefs(store, repo, method, rest.slice(1), body);
    case 'contents':
      return handleContents(store, repo, method, rest.slice(1), query, body);
    case 'labels':
      return handleLabels(repo, method, body);
    case 'issues':
      return handleIssues(store, repo, method, rest.slice(1), query, body, origin);
    case 'pulls':
      return handlePulls(store, repo, method, rest.slice(1), query, body);
    default:
      return notFound('Not Found');
  }
}

function handleBranches(store: Store, repo: Repo, method: string, rest: readonly string[]): RestReply {
  if (method === 'GET' && rest.length === 0) {
    const out = store.sortedRefs(repo)
      .filter(([name]) => name.startsWith('refs/heads/'))
      .map(([name, oid]) => ({ name: name.slice('refs/heads/'.length), commit: { sha: oid } }));
    return ok(out);
  }
  if (method === 'GET' && rest.length >= 1) {
    const branch = rest.join('/');
    const oid = store.refTip(repo, `refs/heads/${branch}`);
    if (oid === ZERO_OID) return notFound('Branch not found');
    return ok({ name: branch, commit: { sha: oid } });
  }
  return err(405, 'Method Not Allowed');
}

function handleCommits(store: Store, repo: Repo, method: string, query: ReadonlyMap<string, string>): RestReply {
  if (method !== 'GET') return err(405, 'Method Not Allowed');
  const ref = query.get('sha');
  let tip: string;
  if (ref != null && ref !== '') {
    tip = store.refTip(repo, `refs/heads/${ref}`);
    if (tip === ZERO_OID && /^[0-9a-f]{40}$/.test(ref)) tip = ref;
    if (tip === ZERO_OID) return ok([]);
  } else {
    tip = store.headOid(repo);
  }
  if (tip === ZERO_OID) return ok([]);
  const out = store.walkCommits(tip).map((sha) => {
    const view = store.commitView(sha);
    return {
      sha,
      commit: {
        // The REST view shows the message as it was sent: git stores it with a trailing
        // newline, the API does not.
        message: view.message.replace(/\n$/, ''),
        author: { name: 'Forge', email: 'forge@example.invalid', date: isoAt(0) },
        committer: { name: 'Forge', email: 'forge@example.invalid', date: isoAt(0) },
      },
    };
  });
  return ok(out);
}

function handleGitRefs(store: Store, repo: Repo, method: string, rest: readonly string[], body: Body | null): RestReply {
  if (rest[0] !== 'refs') return notFound('Not Found');
  if (method === 'POST' && rest.length === 1) {
    const ref = asString(body?.ref);
    const sha = asString(body?.sha);
    if (!ref.startsWith('refs/') || !/^[0-9a-f]{40}$/.test(sha)) return err(422, 'invalid ref or sha');
    if (!store.hasObject(sha)) return err(422, 'object does not exist');
    if (store.refTip(repo, ref) !== ZERO_OID) return err(422, 'Reference already exists');
    store.setRef(repo, ref, sha);
    return created({ ref, object: { sha } });
  }
  if (method === 'GET' && rest.length >= 2) {
    const ref = rest.slice(1).join('/');
    const oid = store.refTip(repo, ref);
    if (oid === ZERO_OID) return notFound('Reference not found');
    return ok({ ref, object: { sha: oid } });
  }
  if (method === 'GET' && rest.length === 1) {
    return ok(store.sortedRefs(repo).map(([ref, oid]) => ({ ref, object: { sha: oid } })));
  }
  return err(405, 'Method Not Allowed');
}

function handleContents(
  store: Store,
  repo: Repo,
  method: string,
  rest: readonly string[],
  query: ReadonlyMap<string, string>,
  body: Body | null,
): RestReply {
  const path = rest.join('/');
  const refName = query.get('ref');
  const branch = refName != null && refName !== '' ? refName : repo.defaultBranch;
  if (method === 'GET') {
    const tip = store.refTip(repo, `refs/heads/${branch}`);
    if (tip === ZERO_OID) return notFound('Not Found');
    const tree = store.commitView(tip).tree;
    const segments = path === '' ? [] : path.split('/');
    if (path === '') {
      const entries = store.listDir(tree, []) ?? [];
      return ok(entries.map((entry) => dirEntry(entry, '')));
    }
    const blobOid = store.getBlobAt(tree, segments);
    if (blobOid !== null) {
      const object = store.getObject(blobOid);
      if (object === undefined) return notFound('Not Found');
      return ok({
        type: 'file',
        encoding: 'base64',
        content: b64Of(object.data, blobOid),
        sha: blobOid,
        size: object.data.length,
        name: segments[segments.length - 1] as string,
        path,
      });
    }
    const entries = store.listDir(tree, segments);
    if (entries === null) return notFound('Not Found');
    return ok(entries.map((entry) => dirEntry(entry, path)));
  }
  if (method === 'PUT') {
    if (path === '') return err(422, 'path is required');
    const contentB64 = asString(body?.content);
    const message = asString(body?.message);
    if (message === '') return err(422, 'message is required');
    let content: Buffer;
    try {
      content = Buffer.from(contentB64.replace(/[\r\n\t ]+/g, ''), 'base64');
    } catch {
      return err(422, 'content is not valid base64');
    }
    const putBranch = typeof body?.branch === 'string' && (body.branch as string) !== '' ? (body.branch as string) : branch;
    const tip = store.refTip(repo, `refs/heads/${putBranch}`);
    if (typeof body?.sha === 'string' && (body.sha as string) !== '') {
      const current = tip === ZERO_OID ? null : store.getBlobAt(store.commitView(tip).tree, path.split('/'));
      if (current === null || current !== (body.sha as string)) return err(409, 'sha does not match the current content');
    }
    const isUpdate = tip !== ZERO_OID && store.getBlobAt(store.commitView(tip).tree, path.split('/')) !== null;
    const { commitSha, blobSha } = store.commitFile(repo, putBranch, path, content, message);
    const reply: RestReply = {
      status: isUpdate ? 200 : 201,
      json: { content: { name: path.split('/').pop() ?? path, path, sha: blobSha, encoding: 'base64' }, commit: { sha: commitSha } },
    };
    return reply;
  }
  if (method === 'DELETE') {
    if (path === '') return err(422, 'path is required');
    const tip = store.refTip(repo, `refs/heads/${branch}`);
    if (tip === ZERO_OID) return notFound('Not Found');
    const current = store.getBlobAt(store.commitView(tip).tree, path.split('/'));
    if (current === null) return notFound('Not Found');
    if (typeof body?.sha === 'string' && (body.sha as string) !== '' && (body.sha as string) !== current) {
      return err(409, 'sha does not match the current content');
    }
    const deleted = store.deleteFile(repo, branch, path, asString(body?.message) || 'delete file');
    if (deleted === null) return notFound('Not Found');
    return ok({ commit: { sha: deleted.commitSha } });
  }
  return err(405, 'Method Not Allowed');
}

function dirEntry(entry: { mode: string; name: string; oid: string }, parentPath: string): Record<string, unknown> {
  return {
    type: entry.mode === '40000' ? 'dir' : 'file',
    name: entry.name,
    path: parentPath === '' ? entry.name : `${parentPath}/${entry.name}`,
    sha: entry.oid,
  };
}

function handleLabels(repo: Repo, method: string, body: Body | null): RestReply {
  if (method === 'GET') {
    return ok([...repo.labels.values()].map((label) => ({ name: label.name, color: label.color })));
  }
  if (method === 'POST') {
    const name = asString(body?.name);
    if (name === '') return err(422, 'name is required');
    const color = asString(body?.color) || 'ededed';
    repo.labels.set(name, { name, color });
    return created({ name, color });
  }
  return err(405, 'Method Not Allowed');
}

function handleIssues(
  store: Store,
  repo: Repo,
  method: string,
  rest: readonly string[],
  query: ReadonlyMap<string, string>,
  body: Body | null,
  origin: string,
): RestReply {
  if (rest.length === 0) {
    if (method === 'POST') {
      const title = asString(body?.title);
      if (title === '') return err(422, 'title is required');
      const labelsRaw = body?.labels;
      const labels: string[] = Array.isArray(labelsRaw) ? labelsRaw.filter((item): item is string => typeof item === 'string') : [];
      for (const label of labels) {
        if (!repo.labels.has(label)) return err(422, `label ${label} does not exist`);
      }
      const issue = store.createIssue(repo, title, asString(body?.body), labels);
      return created(cachedIssueJson(repo, issue));
    }
    if (method === 'GET') {
      const state = query.get('state') ?? 'open';
      const sort = query.get('sort') ?? 'created';
      const direction = query.get('direction') ?? 'desc';
      let issues = [...repo.issues.values()];
      if (state !== 'all') issues = issues.filter((issue) => issue.state === state);
      if (sort === 'created') {
        issues.sort((a, b) => (direction === 'asc' ? a.seq - b.seq : b.seq - a.seq));
      } else {
        issues.sort((a, b) => (direction === 'asc' ? a.number - b.number : b.number - a.number));
      }
      const page = paginate(issues.map((issue) => cachedIssueJson(repo, issue)), query, origin, `/api/v3/repos/${repo.owner}/${repo.name}/issues`);
      return ok(page.items, page.link === null ? undefined : { Link: page.link });
    }
    return err(405, 'Method Not Allowed');
  }
  const number = parseInt(rest[0] as string, 10);
  if (!Number.isSafeInteger(number) || number < 1) return notFound('Not Found');
  const issue = repo.issues.get(number);
  if (issue === undefined) return notFound('Not Found');
  if (rest.length === 1) {
    if (method === 'GET') return ok(cachedIssueJson(repo, issue));
    if (method === 'PATCH') {
      if (typeof body?.state === 'string' && (body.state === 'open' || body.state === 'closed')) {
        issue.state = body.state;
        issue.rev += 1;
      }
      if (typeof body?.title === 'string') {
        issue.title = body.title;
        issue.rev += 1;
      }
      if (typeof body?.body === 'string') {
        issue.body = body.body;
        issue.rev += 1;
      }
      return ok(cachedIssueJson(repo, issue));
    }
    return err(405, 'Method Not Allowed');
  }
  if (rest[1] === 'comments' && rest.length === 2) {
    if (method === 'GET') {
      return ok(issue.comments.map((comment) => ({ id: comment.id, body: comment.body })));
    }
    if (method === 'POST') {
      const text = asString(body?.body);
      if (text === '') return err(422, 'body is required');
      const comment = { id: commentSeq++, body: text };
      issue.comments.push(comment);
      return created({ id: comment.id, body: comment.body });
    }
    return err(405, 'Method Not Allowed');
  }
  return notFound('Not Found');
}

let commentSeq = 1;

function handlePulls(
  store: Store,
  repo: Repo,
  method: string,
  rest: readonly string[],
  query: ReadonlyMap<string, string>,
  body: Body | null,
): RestReply {
  if (rest.length === 0) {
    if (method === 'POST') {
      const title = asString(body?.title);
      const head = asString(body?.head);
      const base = asString(body?.base);
      if (title === '' || head === '' || base === '') return err(422, 'title, head and base are required');
      const pull = store.createPull(repo, title, asString(body?.body), head, base);
      if (pull === null) return err(422, 'head or base branch does not exist');
      return created(pullJson(repo, pull));
    }
    if (method === 'GET') {
      const state = query.get('state') ?? 'open';
      let pulls = [...repo.pulls.values()];
      if (state !== 'all') pulls = pulls.filter((pull) => pull.state === state);
      pulls.sort((a, b) => a.number - b.number);
      return ok(pulls.map((pull) => pullJson(repo, pull)));
    }
    return err(405, 'Method Not Allowed');
  }
  const number = parseInt(rest[0] as string, 10);
  if (!Number.isSafeInteger(number) || number < 1) return notFound('Not Found');
  const pull = repo.pulls.get(number);
  if (pull === undefined) return notFound('Not Found');
  if (rest.length === 1) {
    if (method === 'GET') return ok(pullJson(repo, pull));
    return err(405, 'Method Not Allowed');
  }
  if (rest[1] === 'files' && rest.length === 2) {
    if (method !== 'GET') return err(405, 'Method Not Allowed');
    return ok(store.diffFiles(pull.baseSha, pull.headSha));
  }
  if (rest[1] === 'merge' && rest.length === 2) {
    if (method !== 'PUT') return err(405, 'Method Not Allowed');
    const merged = store.squashMerge(repo, pull);
    if (merged === null) return err(405, 'the pull request cannot be merged (conflict or already closed)');
    return ok({ sha: merged.sha, merged: true, message: `Merge pull request #${pull.number}: ${pull.title}` });
  }
  return notFound('Not Found');
}
