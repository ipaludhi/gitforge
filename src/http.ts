// HTTP router: auth first, JSON bodies, request ids, and dispatch to the four surfaces.
// Every reply is JSON (never HTML) and carries X-GitHub-Request-Id. /healthz is open;
// everything else needs Authorization: Bearer <token> (the entry process's own
// MAKEFUN_SHOP_TOKEN, or any non-empty bearer when the env var is unset in dev).

import { type IncomingMessage, type ServerResponse } from 'node:http';
import { handleGit } from './gitproto.ts';
import { handleRest, NO_CONTENT } from './rest.ts';
import { handleGraphQL } from './graphql.ts';
import { handleMcp, mcpParseError } from './mcp.ts';
import { Store } from './store.ts';

export interface AppOptions {
  store: Store;
  token: string;
}

let requestCounter = 0;

function requestId(): string {
  requestCounter += 1;
  return `req-${process.pid}-${requestCounter}`;
}

function sendJson(res: ServerResponse, status: number, json: unknown, headers: Record<string, string> = {}): void {
  const body = JSON.stringify(json);
  res.writeHead(status, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(body),
    'x-github-request-id': requestId(),
    ...headers,
  });
  res.end(body);
}

function sendNoContent(res: ServerResponse): void {
  res.writeHead(NO_CONTENT, { 'x-github-request-id': requestId() });
  res.end();
}

function sendRaw(res: ServerResponse, status: number, contentType: string, body: Buffer): void {
  res.writeHead(status, {
    'content-type': contentType,
    'content-length': body.length,
    'x-github-request-id': requestId(),
  });
  res.end(body);
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function parseJsonBody(raw: Buffer): { ok: true; value: unknown } | { ok: false } {
  if (raw.length === 0) return { ok: true, value: null };
  try {
    return { ok: true, value: JSON.parse(raw.toString('utf8')) };
  } catch {
    return { ok: false };
  }
}

export function createHandler(options: AppOptions): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  const { store, token } = options;

  return async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const path = url.pathname;
    const method = (req.method ?? 'GET').toUpperCase();

    // ---- open health check
    if (path === '/healthz') {
      sendJson(res, 200, { ok: true });
      return;
    }

    const isGit = path.endsWith('.git/info/refs') || path.endsWith('.git/git-upload-pack') || path.endsWith('.git/git-receive-pack');
    const isRest = path === '/api/v3' || path.startsWith('/api/v3/');
    const isGraphQL = path === '/api/graphql';
    const isMcp = path === '/mcp';

    if (!isGit && !isRest && !isGraphQL && !isMcp) {
      sendJson(res, 404, { message: 'Not Found' });
      return;
    }

    const raw = await readBody(req);

    // ---- MCP parses its body before auth: a malformed body is 400/-32700 even unauthenticated
    if (isMcp) {
      const parsed = parseJsonBody(raw);
      if (!parsed.ok) {
        const reply = mcpParseError();
        sendJson(res, reply.status, reply.json);
        return;
      }
      const auth = req.headers.authorization ?? '';
      if (!auth.startsWith('Bearer ') || auth.slice(7).trim() === '') {
        sendJson(res, 401, { message: 'Requires authentication' }, { 'www-authenticate': 'Basic realm="Git Forge"' });
        return;
      }
      if (token !== '' && auth.slice(7) !== token) {
        sendJson(res, 401, { message: 'Bad credentials' }, { 'www-authenticate': 'Basic realm="Git Forge"' });
        return;
      }
      const reply = handleMcp(store, parsed.value);
      sendJson(res, reply.status, reply.json);
      return;
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
      sendJson(res, 401, { message: 'Requires authentication' }, { 'www-authenticate': 'Basic realm="Git Forge"' });
      return;
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
      sendRaw(res, reply.status, reply.contentType, reply.body);
      return;
    }

    // ---- REST + GraphQL share JSON body parsing (malformed JSON is 400)
    const parsed = parseJsonBody(raw);
    if (!parsed.ok) {
      sendJson(res, 400, { message: 'Problems parsing JSON' });
      return;
    }

    if (isGraphQL) {
      if (method !== 'POST') {
        sendJson(res, 404, { message: 'Not Found' });
        return;
      }
      const reply = handleGraphQL(store, parsed.value);
      sendJson(res, reply.status, reply.json);
      return;
    }

    // ---- REST (segments after /api/v3)
    const segments = path.split('/').filter((part) => part !== '').slice(2);
    const query = url.searchParams;
    const origin = `http://${req.headers.host ?? 'localhost'}`;
    const reply = handleRest(store, method, segments, query, parsed.value, origin);
    if (reply.status === NO_CONTENT) {
      sendNoContent(res);
      return;
    }
    sendJson(res, reply.status, reply.json, reply.headers ?? {});
  };
}
