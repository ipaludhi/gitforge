// HTTP router: auth first, JSON bodies, request ids, and dispatch to the four surfaces.
// Transport-independent: the caller hands it a parsed request and gets a reply object.
// A raw node:net server (src/transport.ts) owns the bytes; this file owns the semantics.
// Every reply is JSON (never HTML) and carries X-GitHub-Request-Id. /healthz is open;
// everything else needs Authorization: Bearer <token> (the entry process's own
// MAKEFUN_SHOP_TOKEN, or any non-empty bearer when the env var is unset in dev).

import { handleGit } from './gitproto.ts';
import { handleRest, NO_CONTENT } from './rest.ts';
import { handleGraphQL } from './graphql.ts';
import { handleMcp, mcpParseError } from './mcp.ts';
import { Store } from './store.ts';

export interface AppOptions {
  store: Store;
  token: string;
}

/** One parsed HTTP request, as the transport hands it over. Header names are lowercase. */
export interface TransportRequest {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: Buffer;
}

/** One reply, as the transport writes it. body is always a Buffer (possibly empty). */
export interface TransportReply {
  status: number;
  contentType: string;
  body: Buffer;
  headers?: Record<string, string>;
}

let requestCounter = 0;

function requestId(): string {
  requestCounter += 1;
  return `req-${process.pid}-${requestCounter}`;
}

function jsonReply(status: number, json: unknown, headers: Record<string, string> = {}): TransportReply {
  const body = Buffer.from(JSON.stringify(json), 'utf8');
  return { status, contentType: 'application/json', body, headers: { 'x-github-request-id': requestId(), ...headers } };
}

function noContentReply(): TransportReply {
  return { status: NO_CONTENT, contentType: '', body: Buffer.alloc(0), headers: { 'x-github-request-id': requestId() } };
}

function rawReply(status: number, contentType: string, body: Buffer): TransportReply {
  return { status, contentType, body, headers: { 'x-github-request-id': requestId() } };
}

function parseJsonBody(raw: Buffer): { ok: true; value: unknown } | { ok: false } {
  if (raw.length === 0) return { ok: true, value: null };
  try {
    return { ok: true, value: JSON.parse(raw.toString('utf8')) };
  } catch {
    return { ok: false };
  }
}

export function createDispatcher(options: AppOptions): (req: TransportRequest) => TransportReply {
  const { store, token } = options;

  return (req) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const path = url.pathname;
    const method = (req.method ?? 'GET').toUpperCase();

    // ---- open health check
    if (path === '/healthz') {
      return jsonReply(200, { ok: true });
    }

    const isGit = path.endsWith('.git/info/refs') || path.endsWith('.git/git-upload-pack') || path.endsWith('.git/git-receive-pack');
    const isRest = path === '/api/v3' || path.startsWith('/api/v3/');
    const isGraphQL = path === '/api/graphql';
    const isMcp = path === '/mcp';

    if (!isGit && !isRest && !isGraphQL && !isMcp) {
      return jsonReply(404, { message: 'Not Found' });
    }

    const raw = req.body;

    // ---- MCP parses its body before auth: a malformed body is 400/-32700 even unauthenticated
    if (isMcp) {
      const parsed = parseJsonBody(raw);
      if (!parsed.ok) {
        const reply = mcpParseError();
        return jsonReply(reply.status, reply.json);
      }
      const auth = req.headers.authorization ?? '';
      if (!auth.startsWith('Bearer ') || auth.slice(7).trim() === '') {
        return jsonReply(401, { message: 'Requires authentication' }, { 'www-authenticate': 'Basic realm="Git Forge"' });
      }
      if (token !== '' && auth.slice(7) !== token) {
        return jsonReply(401, { message: 'Bad credentials' }, { 'www-authenticate': 'Basic realm="Git Forge"' });
      }
      const reply = handleMcp(store, parsed.value);
      return jsonReply(reply.status, reply.json);
    }

    // ---- auth for git / rest / graphql
    // Bearer is the suite's form; real git clients send Basic, so accept a Basic
    // credential whose username or password is the token (GitHub does the same).
    const auth = req.headers.authorization ?? '';
    let authed = false;
    if (auth.startsWith('Bearer ')) {
      const presented = auth.slice(7).trim();
      authed = presented !== '' && (token === '' || presented === token);
    } else if (auth.startsWith('Basic ') && token !== '') {
      try {
        const decoded = Buffer.from(auth.slice(6).trim(), 'base64').toString('utf8');
        const parts = decoded.split(':');
        authed = parts.includes(token);
      } catch {
        authed = false;
      }
    }
    if (!authed) {
      return jsonReply(401, { message: 'Requires authentication' }, { 'www-authenticate': 'Basic realm="Git Forge"' });
    }

    // ---- git smart HTTP (raw bodies, no JSON parsing)
    if (isGit) {
      const parts = path.split('/').filter((part) => part !== '');
      // /{owner}/{repo}.git/<tail>
      const owner = parts[0] as string;
      const repoName = (parts[1] as string).replace(/\.git$/, '');
      const tail = parts.slice(2).join('/');
      const query = url.searchParams;
      const repo = store.getRepo(owner, repoName);
      const reply = handleGit(store, repo, tail, method, query, raw, req.headers);
      return rawReply(reply.status, reply.contentType, reply.body);
    }

    // ---- REST + GraphQL share JSON body parsing (malformed JSON is 400)
    const parsed = parseJsonBody(raw);
    if (!parsed.ok) {
      return jsonReply(400, { message: 'Problems parsing JSON' });
    }

    if (isGraphQL) {
      if (method !== 'POST') {
        return jsonReply(404, { message: 'Not Found' });
      }
      const reply = handleGraphQL(store, parsed.value);
      return jsonReply(reply.status, reply.json);
    }

    // ---- REST (segments after /api/v3)
    const segments = path.split('/').filter((part) => part !== '').slice(2);
    const query = url.searchParams;
    const origin = `http://${req.headers.host ?? 'localhost'}`;
    const reply = handleRest(store, method, segments, query, parsed.value, origin);
    if (reply.status === NO_CONTENT) {
      return noContentReply();
    }
    return jsonReply(reply.status, reply.json, reply.headers ?? {});
  };
}
