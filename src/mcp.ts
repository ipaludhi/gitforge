// MCP: JSON-RPC 2.0 over Streamable HTTP at POST /mcp. The suite speaks the modern
// 2026-07-28 era: it probes server/discover first, then tools/list and tools/call.
// A plain JSON body is answered (SSE is not required). Every request answers inside
// the client's 3 s window, and tools act on the same store as REST and GraphQL.

import { type Repo, type Store } from './store.ts';

// ---------------------------------------------------------------- tool catalogue

interface ToolDef {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, { type: string; description: string }>;
    required: string[];
  };
  handler: (store: Store, args: Record<string, unknown>) => { content: { type: 'text'; text: string }[]; structuredContent?: Record<string, unknown>; isError?: boolean };
}

function toolText(payload: unknown): { content: { type: 'text'; text: string }[]; structuredContent?: Record<string, unknown> } {
  return { content: [{ type: 'text', text: JSON.stringify(payload) }], structuredContent: payload as Record<string, unknown> };
}

const TOOLS: ToolDef[] = [
  {
    name: 'create_repo',
    description: 'Create a new repository for the viewer.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Repository name' },
        description: { type: 'string', description: 'Repository description' },
        private: { type: 'boolean', description: 'Whether the repository is private' },
      },
      required: ['name'],
    },
    handler: (store, args) => {
      const name = typeof args.name === 'string' ? args.name : '';
      const description = typeof args.description === 'string' ? args.description : '';
      const isPrivate = args.private === true;
      const repo = store.createRepo(store.viewerLogin, name, description, isPrivate);
      if (repo === null) {
        return { content: [{ type: 'text', text: `Repository ${name} already exists` }], isError: true };
      }
      return toolText({ full_name: `${repo.owner}/${repo.name}`, name: repo.name, private: repo.isPrivate, id: repo.id });
    },
  },
  {
    name: 'get_repo',
    description: 'Get a repository by owner and name.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login' },
        repo: { type: 'string', description: 'Repository name' },
      },
      required: ['owner', 'repo'],
    },
    handler: (store, args) => {
      const owner = typeof args.owner === 'string' ? args.owner : '';
      const name = typeof args.repo === 'string' ? args.repo : '';
      const repo = store.getRepo(owner, name);
      if (repo === undefined) {
        return { content: [{ type: 'text', text: `Repository ${owner}/${name} not found` }], isError: true };
      }
      return toolText({
        full_name: `${repo.owner}/${repo.name}`,
        name: repo.name,
        private: repo.isPrivate,
        default_branch: repo.defaultBranch,
        id: repo.id,
        description: repo.description,
      });
    },
  },
  {
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login' },
        repo: { type: 'string', description: 'Repository name' },
        title: { type: 'string', description: 'Issue title' },
        body: { type: 'string', description: 'Issue body' },
      },
      required: ['owner', 'repo', 'title'],
    },
    handler: (store, args) => {
      const owner = typeof args.owner === 'string' ? args.owner : '';
      const name = typeof args.repo === 'string' ? args.repo : '';
      const title = typeof args.title === 'string' ? args.title : '';
      const body = typeof args.body === 'string' ? args.body : '';
      const repo = store.getRepo(owner, name);
      if (repo === undefined) {
        return { content: [{ type: 'text', text: `Repository ${owner}/${name} not found` }], isError: true };
      }
      const issue = store.createIssue(repo, title, body, []);
      return toolText({ number: issue.number, id: issue.id, title: issue.title, state: issue.state });
    },
  },
  {
    name: 'list_issues',
    description: 'List issues in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login' },
        repo: { type: 'string', description: 'Repository name' },
        state: { type: 'string', description: 'Issue state filter: open, closed or all' },
      },
      required: ['owner', 'repo'],
    },
    handler: (store, args) => {
      const owner = typeof args.owner === 'string' ? args.owner : '';
      const name = typeof args.repo === 'string' ? args.repo : '';
      const state = typeof args.state === 'string' ? args.state : 'open';
      const repo = store.getRepo(owner, name);
      if (repo === undefined) {
        return { content: [{ type: 'text', text: `Repository ${owner}/${name} not found` }], isError: true };
      }
      let issues = [...repo.issues.values()];
      if (state !== 'all') issues = issues.filter((issue) => issue.state === state);
      issues.sort((a, b) => a.number - b.number);
      return toolText(issues.map((issue) => ({ number: issue.number, id: issue.id, title: issue.title, state: issue.state, body: issue.body })));
    },
  },
  {
    name: 'create_pull_request',
    description: 'Create a pull request in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login' },
        repo: { type: 'string', description: 'Repository name' },
        title: { type: 'string', description: 'Pull request title' },
        body: { type: 'string', description: 'Pull request body' },
        head: { type: 'string', description: 'Head branch name' },
        base: { type: 'string', description: 'Base branch name' },
      },
      required: ['owner', 'repo', 'title', 'head', 'base'],
    },
    handler: (store, args) => {
      const owner = typeof args.owner === 'string' ? args.owner : '';
      const name = typeof args.repo === 'string' ? args.repo : '';
      const title = typeof args.title === 'string' ? args.title : '';
      const body = typeof args.body === 'string' ? args.body : '';
      const head = typeof args.head === 'string' ? args.head : '';
      const base = typeof args.base === 'string' ? args.base : '';
      const repo = store.getRepo(owner, name);
      if (repo === undefined) {
        return { content: [{ type: 'text', text: `Repository ${owner}/${name} not found` }], isError: true };
      }
      const pull = store.createPull(repo, title, body, head, base);
      if (pull === null) {
        return { content: [{ type: 'text', text: `Cannot create pull request: head or base branch not found` }], isError: true };
      }
      return toolText({ number: pull.number, id: pull.id, title: pull.title, state: pull.state, head: { ref: pull.headRef, sha: pull.headSha }, base: { ref: pull.baseRef, sha: pull.baseSha } });
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Merge a pull request with a squash merge.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login' },
        repo: { type: 'string', description: 'Repository name' },
        pull_number: { type: 'integer', description: 'Pull request number' },
      },
      required: ['owner', 'repo', 'pull_number'],
    },
    handler: (store, args) => {
      const owner = typeof args.owner === 'string' ? args.owner : '';
      const name = typeof args.repo === 'string' ? args.repo : '';
      const number = typeof args.pull_number === 'number' ? args.pull_number : NaN;
      const repo = store.getRepo(owner, name);
      if (repo === undefined) {
        return { content: [{ type: 'text', text: `Repository ${owner}/${name} not found` }], isError: true };
      }
      const pull = repo.pulls.get(number);
      if (pull === undefined) {
        return { content: [{ type: 'text', text: `Pull request #${number} not found` }], isError: true };
      }
      const merged = store.squashMerge(repo, pull);
      if (merged === null) {
        return { content: [{ type: 'text', text: `Pull request #${number} cannot be merged` }], isError: true };
      }
      return toolText({ merged: true, sha: merged.sha, message: `Merge pull request #${number}: ${pull.title}` });
    },
  },
];

// ---------------------------------------------------------------- JSON-RPC

interface JsonRpcRequest {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: Record<string, unknown>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function rpcResult(id: string | number | null, result: unknown): Record<string, unknown> {
  return { jsonrpc: '2.0', id, result };
}

function rpcError(id: string | number | null, code: number, message: string): Record<string, unknown> {
  return { jsonrpc: '2.0', id, error: { code, message } };
}

const SERVER_INFO = { name: 'git-forge', version: '1.0.0' };

/** Handle one decoded JSON-RPC request body (already parsed; malformed bodies are 400/-32700 at the http layer). */
export function handleMcp(store: Store, body: unknown): { status: number; json: Record<string, unknown> } {
  if (!isRecord(body) || typeof body.method !== 'string') {
    return { status: 400, json: rpcError(body !== null && isRecord(body) && 'id' in body ? (body.id as string | number | null) : null, -32600, 'Invalid Request') };
  }
  const request = body as JsonRpcRequest;
  const id = request.id ?? null;
  const params = isRecord(request.params) ? request.params : {};
  const method = request.method;

  if (method === 'server/discover') {
    return {
      status: 200,
      json: rpcResult(id, {
        supportedVersions: ['2026-07-28', '2025-11-25'],
        capabilities: { tools: {} },
        serverInfo: SERVER_INFO,
      }),
    };
  }

  if (method === 'initialize') {
    const offered = typeof params.protocolVersion === 'string' ? params.protocolVersion : '2025-11-25';
    return {
      status: 200,
      json: rpcResult(id, {
        protocolVersion: offered,
        capabilities: { tools: {} },
        serverInfo: SERVER_INFO,
      }),
    };
  }

  if (method === 'notifications/initialized') {
    return { status: 202, json: rpcResult(id, {}) };
  }

  if (method === 'tools/list') {
    const tools = TOOLS.map((tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema,
    }));
    return { status: 200, json: rpcResult(id, { tools }) };
  }

  if (method === 'tools/call') {
    const name = typeof params.name === 'string' ? params.name : '';
    const args = isRecord(params.arguments) ? (params.arguments as Record<string, unknown>) : {};
    const tool = TOOLS.find((candidate) => candidate.name === name);
    if (tool === undefined) {
      return { status: 200, json: rpcError(id, -32602, `Unknown tool: ${name}`) };
    }
    const missing = tool.inputSchema.required.filter((key) => args[key] === undefined || args[key] === null || args[key] === '');
    if (missing.length > 0) {
      return { status: 200, json: rpcResult(id, { content: [{ type: 'text', text: `Missing required arguments: ${missing.join(', ')}` }], isError: true }) };
    }
    const result = tool.handler(store, args);
    return { status: 200, json: rpcResult(id, result) };
  }

  return { status: 200, json: rpcError(id, -32601, `Method not found: ${method}`) };
}

export function mcpParseError(): { status: number; json: Record<string, unknown> } {
  return { status: 400, json: rpcError(null, -32700, 'Parse error') };
}
