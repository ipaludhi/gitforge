// GraphQL v4: a small executor for exactly the documents gh and github-mcp-server
// send (the suite's 18 fixed documents), plus the __type introspection they probe.
// A hand-rolled parser for the subset in use — operations, aliases, variables, inline
// enums and input objects, lists, null, inline fragments — and resolvers over the one
// shared store, so a mutation here reads back over REST as the same object.

import { type Issue, type Pull, type Repo, type Store } from './store.ts';

// ---------------------------------------------------------------- parser

type Value =
  | { kind: 'variable'; name: string }
  | { kind: 'string'; value: string }
  | { kind: 'int'; value: number }
  | { kind: 'float'; value: number }
  | { kind: 'boolean'; value: boolean }
  | { kind: 'null' }
  | { kind: 'enum'; value: string }
  | { kind: 'list'; values: Value[] }
  | { kind: 'object'; fields: { name: string; value: Value }[] };

interface Argument {
  name: string;
  value: Value;
}

interface Selection {
  alias: string | null;
  name: string;
  args: Argument[];
  selections: Selection[] | null;
  fragment: string | null; // inline fragment type condition, e.g. 'Repository'
}

interface Operation {
  kind: 'query' | 'mutation';
  name: string | null;
  variables: { name: string; type: string; defaultValue: Value | null }[];
  selections: Selection[];
}

interface FragmentDef {
  name: string;
  type: string;
  selections: Selection[];
}

interface Document {
  operations: Operation[];
  fragments: Map<string, FragmentDef>;
}

type Token =
  | { kind: 'punct'; value: string }
  | { kind: 'name'; value: string }
  | { kind: 'string'; value: string }
  | { kind: 'int'; value: number }
  | { kind: 'float'; value: number }
  | { kind: 'spread' };

function tokenize(source: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < source.length) {
    const ch = source[i] as string;
    if (/\s/.test(ch) || ch === ',') {
      i += 1;
      continue;
    }
    if (ch === '#') {
      while (i < source.length && source[i] !== '\n') i += 1;
      continue;
    }
    if (ch === '.' && source.slice(i, i + 3) === '...') {
      tokens.push({ kind: 'spread' });
      i += 3;
      continue;
    }
    if ('{}():$![]=@'.includes(ch)) {
      tokens.push({ kind: 'punct', value: ch });
      i += 1;
      continue;
    }
    if (ch === '"') {
      let j = i + 1;
      let out = '';
      while (j < source.length && source[j] !== '"') {
        if (source[j] === '\\' && j + 1 < source.length) {
          const esc = source[j + 1] as string;
          out += esc === 'n' ? '\n' : esc === 't' ? '\t' : esc === 'r' ? '\r' : esc;
          j += 2;
        } else {
          out += source[j] as string;
          j += 1;
        }
      }
      tokens.push({ kind: 'string', value: out });
      i = j + 1;
      continue;
    }
    if (/[0-9-]/.test(ch)) {
      let j = i;
      while (j < source.length && /[0-9.eE+-]/.test(source[j] as string)) j += 1;
      const text = source.slice(i, j);
      if (/[.eE]/.test(text)) tokens.push({ kind: 'float', value: Number(text) });
      else tokens.push({ kind: 'int', value: parseInt(text, 10) });
      i = j;
      continue;
    }
    if (/[_A-Za-z]/.test(ch)) {
      let j = i;
      while (j < source.length && /[_A-Za-z0-9]/.test(source[j] as string)) j += 1;
      tokens.push({ kind: 'name', value: source.slice(i, j) });
      i = j;
      continue;
    }
    throw new Error(`unexpected character ${JSON.stringify(ch)} in GraphQL document`);
  }
  return tokens;
}

class Parser {
  private pos = 0;
  private readonly tokens: Token[];
  constructor(tokens: Token[]) {
    this.tokens = tokens;
  }

  private peek(): Token | undefined {
    return this.tokens[this.pos];
  }

  private next(): Token {
    const token = this.tokens[this.pos];
    if (token === undefined) throw new Error('unexpected end of GraphQL document');
    this.pos += 1;
    return token;
  }

  private expectPunct(value: string): void {
    const token = this.next();
    if (token.kind !== 'punct' || token.value !== value) throw new Error(`expected ${value} in GraphQL document`);
  }

  private acceptPunct(value: string): boolean {
    const token = this.peek();
    if (token !== undefined && token.kind === 'punct' && token.value === value) {
      this.pos += 1;
      return true;
    }
    return false;
  }

  private expectName(): string {
    const token = this.next();
    if (token.kind !== 'name') throw new Error('expected a name in GraphQL document');
    return token.value;
  }

  parseDocument(): Document {
    const operations: Operation[] = [];
    const fragments = new Map<string, FragmentDef>();
    while (this.pos < this.tokens.length) {
      const token = this.peek();
      if (token === undefined) break;
      if (token.kind === 'punct' && token.value === '{') {
        operations.push({ kind: 'query', name: null, variables: [], selections: this.parseSelections() });
        continue;
      }
      if (token.kind === 'name' && (token.value === 'query' || token.value === 'mutation')) {
        const kind = this.next().value as 'query' | 'mutation';
        let name: string | null = null;
        const next = this.peek();
        if (next !== undefined && next.kind === 'name') name = this.next().value as string;
        const variables = this.parseVariableDefinitions();
        operations.push({ kind, name, variables, selections: this.parseSelections() });
        continue;
      }
      if (token.kind === 'name' && token.value === 'fragment') {
        this.next();
        const name = this.expectName();
        const on = this.expectName();
        if (on !== 'on') throw new Error('expected on in fragment definition');
        const type = this.expectName();
        fragments.set(name, { name, type, selections: this.parseSelections() });
        continue;
      }
      throw new Error(`unexpected token in GraphQL document: ${JSON.stringify(token)}`);
    }
    return { operations, fragments };
  }

  private parseVariableDefinitions(): { name: string; type: string; defaultValue: Value | null }[] {
    const variables: { name: string; type: string; defaultValue: Value | null }[] = [];
    if (!this.acceptPunct('(')) return variables;
    while (!this.acceptPunct(')')) {
      this.expectPunct('$');
      const name = this.expectName();
      this.expectPunct(':');
      const type = this.parseType();
      let defaultValue: Value | null = null;
      if (this.acceptPunct('=')) defaultValue = this.parseValue();
      variables.push({ name, type, defaultValue });
    }
    return variables;
  }

  private parseType(): string {
    let type = '';
    if (this.acceptPunct('[')) {
      type = `[${this.parseType()}]`;
    } else {
      type = this.expectName();
    }
    if (this.acceptPunct('!')) type += '!';
    return type;
  }

  private parseSelections(): Selection[] {
    this.expectPunct('{');
    const selections: Selection[] = [];
    while (!this.acceptPunct('}')) {
      const token = this.peek();
      if (token === undefined) throw new Error('unterminated selection set');
      if (token.kind === 'spread') {
        this.next();
        const next = this.peek();
        if (next !== undefined && next.kind === 'name' && next.value === 'on') {
          this.next();
          const type = this.expectName();
          const inner = this.parseSelections();
          for (const selection of inner) selections.push({ ...selection, fragment: type });
        } else if (next !== undefined && next.kind === 'name') {
          const name = this.next().value as string;
          selections.push({ alias: null, name: `...${name}`, args: [], selections: null, fragment: null });
        } else {
          throw new Error('bad fragment spread');
        }
        continue;
      }
      if (token.kind !== 'name') throw new Error('expected a field name');
      let alias: string | null = null;
      let name = this.next().value as string;
      if (this.acceptPunct(':')) {
        alias = name;
        name = this.expectName();
      }
      const args = this.parseArguments();
      let sub: Selection[] | null = null;
      const ahead = this.peek();
      if (ahead !== undefined && ahead.kind === 'punct' && ahead.value === '{') sub = this.parseSelections();
      selections.push({ alias, name, args, selections: sub, fragment: null });
    }
    return selections;
  }

  private parseArguments(): Argument[] {
    const args: Argument[] = [];
    if (!this.acceptPunct('(')) return args;
    while (!this.acceptPunct(')')) {
      const name = this.expectName();
      this.expectPunct(':');
      args.push({ name, value: this.parseValue() });
    }
    return args;
  }

  private parseValue(): Value {
    const token = this.next();
    if (token.kind === 'punct' && token.value === '$') return { kind: 'variable', name: this.expectName() };
    if (token.kind === 'punct' && token.value === '[') {
      const values: Value[] = [];
      while (!(this.peek()?.kind === 'punct' && this.peek()?.value === ']')) values.push(this.parseValue());
      this.next();
      return { kind: 'list', values };
    }
    if (token.kind === 'punct' && token.value === '{') {
      const fields: { name: string; value: Value }[] = [];
      while (!(this.peek()?.kind === 'punct' && this.peek()?.value === '}')) {
        const name = this.expectName();
        this.expectPunct(':');
        fields.push({ name, value: this.parseValue() });
      }
      this.next();
      return { kind: 'object', fields };
    }
    if (token.kind === 'string') return { kind: 'string', value: token.value };
    if (token.kind === 'int') return { kind: 'int', value: token.value };
    if (token.kind === 'float') return { kind: 'float', value: token.value };
    if (token.kind === 'name') {
      if (token.value === 'true') return { kind: 'boolean', value: true };
      if (token.value === 'false') return { kind: 'boolean', value: false };
      if (token.value === 'null') return { kind: 'null' };
      return { kind: 'enum', value: token.value };
    }
    throw new Error('unexpected value in GraphQL document');
  }
}

// ---------------------------------------------------------------- values

function resolveValue(value: Value, variables: Readonly<Record<string, unknown>>): unknown {
  switch (value.kind) {
    case 'variable':
      return variables[value.name];
    case 'string':
    case 'enum':
      return value.value;
    case 'int':
    case 'float':
      return value.value;
    case 'boolean':
      return value.value;
    case 'null':
      return null;
    case 'list':
      return value.values.map((item) => resolveValue(item, variables));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const field of value.fields) out[field.name] = resolveValue(field.value, variables);
      return out;
    }
  }
}

function argValue(args: readonly Argument[], name: string, variables: Readonly<Record<string, unknown>>): unknown {
  const found = args.find((arg) => arg.name === name);
  return found === undefined ? undefined : resolveValue(found.value, variables);
}

// ---------------------------------------------------------------- ids

function b64(text: string): string {
  return Buffer.from(text, 'utf8').toString('base64');
}

function unb64(text: string): string | null {
  try {
    return Buffer.from(text, 'base64').toString('utf8');
  } catch {
    return null;
  }
}

function repoGid(repo: Repo): string {
  return b64(`Repository:${repo.owner}/${repo.name}`);
}

function issueGid(repo: Repo, issue: Issue): string {
  return b64(`Issue:${repo.owner}/${repo.name}:${issue.number}`);
}

function pullGid(repo: Repo, pull: Pull): string {
  return b64(`PullRequest:${repo.owner}/${repo.name}:${pull.number}`);
}

function commentGid(repo: Repo, issueNumber: number, commentId: number): string {
  return b64(`IssueComment:${repo.owner}/${repo.name}:${issueNumber}:${commentId}`);
}

function cursorFor(number: number): string {
  return b64(`cursor:${number}`);
}

function cursorNumber(cursor: string): number | null {
  const text = unb64(cursor);
  if (text === null) return null;
  const match = /^cursor:(\d+)$/.exec(text);
  return match === null ? null : parseInt(match[1] as string, 10);
}

// ---------------------------------------------------------------- introspection

const TYPE_FIELDS: Record<string, string[]> = {
  Issue: ['id', 'number', 'title', 'state', 'body'],
  PullRequest: ['id', 'number', 'headRefName', 'baseRefName', 'mergeable', 'state', 'merged', 'files'],
  Repository: [
    'id',
    'databaseId',
    'name',
    'nameWithOwner',
    'owner',
    'defaultBranchRef',
    'viewerPermission',
    'hasIssuesEnabled',
    'issue',
    'issues',
    'pullRequests',
    'pullRequest',
  ],
};

const ENUM_VALUES: Record<string, string[]> = {
  SearchType: ['ISSUE', 'PULL_REQUEST', 'REPOSITORY', 'USER', 'DISCUSSION'],
};

// ---------------------------------------------------------------- executor

interface Ctx {
  store: Store;
  variables: Readonly<Record<string, unknown>>;
  errors: { message: string }[];
  fragments: Map<string, FragmentDef>;
}

type AnyRecord = Record<string, unknown>;

function isRecord(value: unknown): value is AnyRecord {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function fieldError(ctx: Ctx, typeName: string, field: string): null {
  ctx.errors.push({ message: `Cannot query field "${field}" on type "${typeName}".` });
  return null;
}

function executeSelections(
  ctx: Ctx,
  typeName: string,
  source: AnyRecord,
  selections: readonly Selection[],
): AnyRecord {
  const out: AnyRecord = {};
  for (const selection of selections) {
    if (selection.name.startsWith('...')) {
      const fragment = ctx.fragments.get(selection.name.slice(3));
      if (fragment !== undefined) {
        Object.assign(out, executeSelections(ctx, typeName, source, fragment.selections));
      }
      continue;
    }
    if (selection.fragment !== null && selection.fragment !== typeName) continue;
    const key = selection.alias ?? selection.name;
    out[key] = resolveField(ctx, typeName, source, selection);
  }
  return out;
}

function resolveField(ctx: Ctx, typeName: string, source: AnyRecord, selection: Selection): unknown {
  const { store, variables } = ctx;
  const field = selection.name;
  const args = selection.args;

  if (field === '__typename') return typeName;

  // ---- root Query
  if (typeName === 'Query') {
    if (field === 'viewer') {
      const user = { login: store.viewerLogin };
      return selection.selections === null ? user : executeSelections(ctx, 'User', user, selection.selections);
    }
    if (field === 'repository') {
      const owner = argValue(args, 'owner', variables);
      const name = argValue(args, 'name', variables);
      if (typeof owner !== 'string' || typeof name !== 'string') return null;
      if (owner !== store.viewerLogin) return null;
      const repo = store.getRepo(owner, name);
      if (repo === undefined) return null;
      return selection.selections === null ? {} : executeSelections(ctx, 'Repository', { __repo: repo }, selection.selections);
    }
    if (field === 'node') {
      const id = argValue(args, 'id', variables);
      if (typeof id !== 'string') return null;
      const decoded = unb64(id);
      if (decoded === null) return null;
      const repoMatch = /^Repository:([^/]+)\/(.+)$/.exec(decoded);
      if (repoMatch !== null) {
        const repo = store.getRepo(repoMatch[1] as string, repoMatch[2] as string);
        if (repo === undefined) return null;
        return selection.selections === null ? {} : executeSelections(ctx, 'Repository', { __repo: repo }, selection.selections);
      }
      const issueMatch = /^Issue:([^/]+)\/(.+):(\d+)$/.exec(decoded);
      if (issueMatch !== null) {
        const repo = store.getRepo(issueMatch[1] as string, issueMatch[2] as string);
        const issue = repo?.issues.get(parseInt(issueMatch[3] as string, 10));
        if (repo === undefined || issue === undefined) return null;
        return selection.selections === null ? {} : executeSelections(ctx, 'Issue', { __repo: repo, __issue: issue }, selection.selections);
      }
      const pullMatch = /^PullRequest:([^/]+)\/(.+):(\d+)$/.exec(decoded);
      if (pullMatch !== null) {
        const repo = store.getRepo(pullMatch[1] as string, pullMatch[2] as string);
        const pull = repo?.pulls.get(parseInt(pullMatch[3] as string, 10));
        if (repo === undefined || pull === undefined) return null;
        return selection.selections === null ? {} : executeSelections(ctx, 'PullRequest', { __repo: repo, __pull: pull }, selection.selections);
      }
      return null;
    }
    if (field === '__type') {
      const name = argValue(args, 'name', variables);
      if (typeof name !== 'string') return null;
      const type = { __typeName: name };
      return selection.selections === null ? type : executeSelections(ctx, '__Type', type, selection.selections);
    }
    return fieldError(ctx, typeName, field);
  }

  // ---- root Mutation
  if (typeName === 'Mutation') {
    const input = argValue(args, 'input', variables);
    const inputObj = isRecord(input) ? input : {};
    if (field === 'createIssue') {
      const repo = repoFromGid(store, inputObj.repositoryId);
      if (repo === null) return fieldError(ctx, typeName, field);
      const title = typeof inputObj.title === 'string' ? inputObj.title : '';
      const body = typeof inputObj.body === 'string' ? inputObj.body : '';
      const issue = store.createIssue(repo, title, body, []);
      const payload = { __issue: issue, __repo: repo };
      return selection.selections === null ? payload : executeSelections(ctx, 'CreateIssuePayload', payload, selection.selections);
    }
    if (field === 'closeIssue') {
      const found = issueFromGid(store, inputObj.issueId);
      if (found === null) return fieldError(ctx, typeName, field);
      found.issue.state = 'closed';
      found.issue.rev += 1;
      const payload = { __issue: found.issue, __repo: found.repo };
      return selection.selections === null ? payload : executeSelections(ctx, 'CloseIssuePayload', payload, selection.selections);
    }
    if (field === 'createPullRequest') {
      const repo = repoFromGid(store, inputObj.repositoryId);
      if (repo === null) return fieldError(ctx, typeName, field);
      const head = typeof inputObj.headRefName === 'string' ? inputObj.headRefName : '';
      const base = typeof inputObj.baseRefName === 'string' ? inputObj.baseRefName : '';
      const title = typeof inputObj.title === 'string' ? inputObj.title : '';
      const pull = store.createPull(repo, title, typeof inputObj.body === 'string' ? inputObj.body : '', head, base);
      if (pull === null) return fieldError(ctx, typeName, field);
      const payload = { __pull: pull, __repo: repo };
      return selection.selections === null ? payload : executeSelections(ctx, 'CreatePullRequestPayload', payload, selection.selections);
    }
    if (field === 'mergePullRequest') {
      const found = pullFromGid(store, inputObj.pullRequestId);
      if (found === null) return fieldError(ctx, typeName, field);
      store.squashMerge(found.repo, found.pull);
      const payload = { __pull: found.pull, __repo: found.repo };
      return selection.selections === null ? payload : executeSelections(ctx, 'MergePullRequestPayload', payload, selection.selections);
    }
    if (field === 'addComment') {
      const found = issueFromGid(store, inputObj.subjectId);
      if (found === null) return fieldError(ctx, typeName, field);
      const body = typeof inputObj.body === 'string' ? inputObj.body : '';
      const comment = { id: nextCommentId(), body };
      found.issue.comments.push(comment);
      const payload = { __comment: comment, __repo: found.repo, __issueNumber: found.issue.number };
      return selection.selections === null ? payload : executeSelections(ctx, 'AddCommentPayload', payload, selection.selections);
    }
    return fieldError(ctx, typeName, field);
  }

  // ---- __Type introspection
  if (typeName === '__Type') {
    const typeNameValue = source.__typeName as string;
    if (field === 'fields') {
      const names = TYPE_FIELDS[typeNameValue] ?? [];
      return names.map((name) => ({ name }));
    }
    if (field === 'enumValues') {
      const names = ENUM_VALUES[typeNameValue] ?? [];
      return names.map((name) => ({ name }));
    }
    if (field === 'name') return typeNameValue;
    return fieldError(ctx, typeName, field);
  }

  // ---- User
  if (typeName === 'User') {
    if (field === 'login') return source.login as string;
    return fieldError(ctx, typeName, field);
  }

  // ---- Repository
  if (typeName === 'Repository') {
    const repo = source.__repo as Repo;
    switch (field) {
      case 'id':
        return repoGid(repo);
      case 'databaseId':
        return repo.id;
      case 'name':
        return repo.name;
      case 'nameWithOwner':
        return `${repo.owner}/${repo.name}`;
      case 'owner': {
        const user = { login: repo.owner };
        return selection.selections === null ? user : executeSelections(ctx, 'User', user, selection.selections);
      }
      case 'defaultBranchRef': {
        const ref = { name: repo.defaultBranch };
        return selection.selections === null ? ref : executeSelections(ctx, 'Ref', ref, selection.selections);
      }
      case 'viewerPermission':
        return 'ADMIN';
      case 'hasIssuesEnabled':
        return true;
      case 'issue': {
        const number = argValue(args, 'number', variables);
        if (typeof number !== 'number') return null;
        const issue = repo.issues.get(number);
        if (issue === undefined) return null;
        return selection.selections === null ? {} : executeSelections(ctx, 'Issue', { __repo: repo, __issue: issue }, selection.selections);
      }
      case 'issues':
        return issuesConnection(ctx, repo, args, selection);
      case 'pullRequests':
        return pullsConnection(ctx, repo, args, selection);
      case 'pullRequest': {
        const number = argValue(args, 'number', variables);
        if (typeof number !== 'number') return null;
        const pull = repo.pulls.get(number);
        if (pull === undefined) return null;
        return selection.selections === null ? {} : executeSelections(ctx, 'PullRequest', { __repo: repo, __pull: pull }, selection.selections);
      }
      default:
        return fieldError(ctx, typeName, field);
    }
  }

  // ---- Issue
  if (typeName === 'Issue') {
    const repo = source.__repo as Repo;
    const issue = source.__issue as Issue;
    switch (field) {
      case 'id':
        return issueGid(repo, issue);
      case 'number':
        return issue.number;
      case 'title':
        return issue.title;
      case 'state':
        return issue.state === 'open' ? 'OPEN' : 'CLOSED';
      case 'body':
        return issue.body;
      default:
        return fieldError(ctx, typeName, field);
    }
  }

  // ---- PullRequest
  if (typeName === 'PullRequest') {
    const repo = source.__repo as Repo;
    const pull = source.__pull as Pull;
    switch (field) {
      case 'id':
        return pullGid(repo, pull);
      case 'number':
        return pull.number;
      case 'state':
        if (pull.merged) return 'MERGED';
        return pull.state === 'open' ? 'OPEN' : 'CLOSED';
      case 'merged':
        return pull.merged;
      case 'headRefName':
        return pull.headRef;
      case 'baseRefName':
        return pull.baseRef;
      case 'mergeable': {
        const conflict = store.mergeConflict(repo, pull);
        if (conflict === null) return 'UNKNOWN';
        return conflict ? 'CONFLICTING' : 'MERGEABLE';
      }
      case 'files': {
        const rows = store.diffFiles(pull.baseSha, pull.headSha);
        const nodes = rows.map((row) => ({ path: row.filename }));
        const conn = { __nodes: nodes };
        return selection.selections === null ? conn : executeSelections(ctx, 'PullRequestFileConnection', conn, selection.selections);
      }
      default:
        return fieldError(ctx, typeName, field);
    }
  }

  // ---- connections
  if (typeName === 'IssueConnection' || typeName === 'PullRequestConnection' || typeName === 'PullRequestFileConnection') {
    if (field === 'nodes') {
      const nodes = source.__nodes as AnyRecord[];
      if (selection.selections === null) return nodes;
      const itemType = typeName === 'IssueConnection' ? 'Issue' : typeName === 'PullRequestConnection' ? 'PullRequest' : 'PullRequestFile';
      return nodes.map((node) => executeSelections(ctx, itemType, node, selection.selections as Selection[]));
    }
    if (field === 'pageInfo') {
      const pageInfo = source.__pageInfo as AnyRecord;
      return selection.selections === null ? pageInfo : executeSelections(ctx, 'PageInfo', pageInfo, selection.selections);
    }
    return fieldError(ctx, typeName, field);
  }

  if (typeName === 'PageInfo') {
    if (field === 'hasNextPage') return source.hasNextPage as boolean;
    if (field === 'endCursor') return (source.endCursor as string | null) ?? null;
    return fieldError(ctx, typeName, field);
  }

  if (typeName === 'Ref') {
    if (field === 'name') return source.name as string;
    return fieldError(ctx, typeName, field);
  }

  if (typeName === 'PullRequestFile') {
    if (field === 'path') return source.path as string;
    return fieldError(ctx, typeName, field);
  }

  // ---- mutation payloads
  if (typeName === 'CreateIssuePayload' || typeName === 'CloseIssuePayload') {
    if (field === 'issue') {
      const issue = source.__issue as Issue;
      const repo = source.__repo as Repo;
      return selection.selections === null ? {} : executeSelections(ctx, 'Issue', { __repo: repo, __issue: issue }, selection.selections);
    }
    return fieldError(ctx, typeName, field);
  }
  if (typeName === 'CreatePullRequestPayload' || typeName === 'MergePullRequestPayload') {
    if (field === 'pullRequest') {
      const pull = source.__pull as Pull;
      const repo = source.__repo as Repo;
      return selection.selections === null ? {} : executeSelections(ctx, 'PullRequest', { __repo: repo, __pull: pull }, selection.selections);
    }
    return fieldError(ctx, typeName, field);
  }
  if (typeName === 'AddCommentPayload') {
    if (field === 'commentEdge') {
      const edge = { __comment: source.__comment as { id: number; body: string }, __repo: source.__repo as Repo, __issueNumber: source.__issueNumber as number };
      return selection.selections === null ? edge : executeSelections(ctx, 'IssueCommentEdge', edge, selection.selections);
    }
    return fieldError(ctx, typeName, field);
  }
  if (typeName === 'IssueCommentEdge') {
    if (field === 'node') {
      const node = { __comment: source.__comment as { id: number; body: string }, __repo: source.__repo as Repo, __issueNumber: source.__issueNumber as number };
      return selection.selections === null ? node : executeSelections(ctx, 'IssueComment', node, selection.selections);
    }
    return fieldError(ctx, typeName, field);
  }
  if (typeName === 'IssueComment') {
    const repo = source.__repo as Repo;
    const comment = source.__comment as { id: number; body: string };
    if (field === 'id') return commentGid(repo, source.__issueNumber as number, comment.id);
    if (field === 'body') return comment.body;
    return fieldError(ctx, typeName, field);
  }

  return fieldError(ctx, typeName, field);
}

let commentSeq = 100000;
function nextCommentId(): number {
  return commentSeq++;
}

function repoFromGid(store: Store, gid: unknown): Repo | null {
  if (typeof gid !== 'string') return null;
  const decoded = unb64(gid);
  if (decoded === null) return null;
  const match = /^Repository:([^/]+)\/(.+)$/.exec(decoded);
  if (match === null) return null;
  return store.getRepo(match[1] as string, match[2] as string) ?? null;
}

function issueFromGid(store: Store, gid: unknown): { repo: Repo; issue: Issue } | null {
  if (typeof gid !== 'string') return null;
  const decoded = unb64(gid);
  if (decoded === null) return null;
  const match = /^Issue:([^/]+)\/(.+):(\d+)$/.exec(decoded);
  if (match === null) return null;
  const repo = store.getRepo(match[1] as string, match[2] as string);
  const issue = repo?.issues.get(parseInt(match[3] as string, 10));
  if (repo === undefined || issue === undefined) return null;
  return { repo, issue };
}

function pullFromGid(store: Store, gid: unknown): { repo: Repo; pull: Pull } | null {
  if (typeof gid !== 'string') return null;
  const decoded = unb64(gid);
  if (decoded === null) return null;
  const match = /^PullRequest:([^/]+)\/(.+):(\d+)$/.exec(decoded);
  if (match === null) return null;
  const repo = store.getRepo(match[1] as string, match[2] as string);
  const pull = repo?.pulls.get(parseInt(match[3] as string, 10));
  if (repo === undefined || pull === undefined) return null;
  return { repo, pull };
}

function issuesConnection(ctx: Ctx, repo: Repo, args: readonly Argument[], selection: Selection): unknown {
  const { variables } = ctx;
  const first = argValue(args, 'first', variables);
  const after = argValue(args, 'after', variables);
  const states = argValue(args, 'states', variables);
  const orderBy = argValue(args, 'orderBy', variables);
  let issues = [...repo.issues.values()];
  if (Array.isArray(states)) {
    const wanted = new Set(states.map((state) => String(state)));
    issues = issues.filter((issue) => wanted.has(issue.state === 'open' ? 'OPEN' : 'CLOSED'));
  }
  let desc = false;
  if (isRecord(orderBy)) {
    desc = orderBy.direction === 'DESC';
  }
  issues.sort((a, b) => (desc ? b.seq - a.seq : a.seq - b.seq));
  if (typeof after === 'string' && after !== '') {
    const cursor = cursorNumber(after);
    if (cursor !== null) {
      issues = issues.filter((issue) => (desc ? issue.number < cursor : issue.number > cursor));
    }
  }
  const limit = typeof first === 'number' ? first : issues.length;
  const page = issues.slice(0, limit);
  const hasNextPage = issues.length > page.length;
  const endCursor = page.length > 0 ? cursorFor(page[page.length - 1]?.number ?? 0) : null;
  const conn: AnyRecord = {
    __nodes: page.map((issue) => ({ __repo: repo, __issue: issue })),
    __pageInfo: { hasNextPage, endCursor },
  };
  return selection.selections === null ? conn : executeSelections(ctx, 'IssueConnection', conn, selection.selections);
}

function pullsConnection(ctx: Ctx, repo: Repo, args: readonly Argument[], selection: Selection): unknown {
  const { variables } = ctx;
  const first = argValue(args, 'first', variables);
  let pulls = [...repo.pulls.values()];
  pulls.sort((a, b) => a.number - b.number);
  const limit = typeof first === 'number' ? first : pulls.length;
  const page = pulls.slice(0, limit);
  const hasNextPage = pulls.length > page.length;
  const endCursor = page.length > 0 ? cursorFor(page[page.length - 1]?.number ?? 0) : null;
  const conn: AnyRecord = {
    __nodes: page.map((pull) => ({ __repo: repo, __pull: pull })),
    __pageInfo: { hasNextPage, endCursor },
  };
  return selection.selections === null ? conn : executeSelections(ctx, 'PullRequestConnection', conn, selection.selections);
}

// ---------------------------------------------------------------- entry

export interface GraphQLReply {
  readonly status: number;
  readonly json: unknown;
}

/** Run one parsed operation body ({query, variables, operationName}) or a batch array. */
export function handleGraphQL(store: Store, body: unknown): GraphQLReply {
  if (Array.isArray(body)) {
    const results = body.map((entry) => runOperation(store, entry));
    return { status: 200, json: results };
  }
  return { status: 200, json: runOperation(store, body) };
}

function runOperation(store: Store, entry: unknown): Record<string, unknown> {
  if (!isRecord(entry) || typeof entry.query !== 'string') {
    return { data: null, errors: [{ message: 'a GraphQL operation needs a query string' }] };
  }
  const variables = isRecord(entry.variables) ? (entry.variables as Readonly<Record<string, unknown>>) : {};
  let document: Document;
  try {
    document = new Parser(tokenize(entry.query)).parseDocument();
  } catch (err) {
    return { data: null, errors: [{ message: err instanceof Error ? err.message : String(err) }] };
  }
  const operationName = typeof entry.operationName === 'string' ? entry.operationName : null;
  let operation = document.operations[0] as Operation | undefined;
  if (operationName !== null) {
    operation = document.operations.find((candidate) => candidate.name === operationName);
  }
  if (operation === undefined) {
    return { data: null, errors: [{ message: `unknown operation ${operationName ?? ''}` }] };
  }
  const ctx: Ctx = { store, variables, errors: [], fragments: document.fragments };
  const rootType = operation.kind === 'mutation' ? 'Mutation' : 'Query';
  let data: AnyRecord;
  try {
    data = executeSelections(ctx, rootType, {}, operation.selections);
  } catch (err) {
    return { data: null, errors: [{ message: err instanceof Error ? err.message : String(err) }] };
  }
  if (ctx.errors.length > 0) return { data, errors: ctx.errors };
  return { data };
}
