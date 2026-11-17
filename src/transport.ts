// Raw TCP HTTP/1.1 server: the transport layer of the forge.
//
// Why hand-rolled: node:http costs ~0.8 ms per request on this host (measured
// 2026-11-17: node:http floor 1.62-1.72 ms/op vs raw net 0.73-0.96 ms/op, same client,
// same fixed response). The bench workloads are thousands of tiny requests, so the
// HTTP stack itself is the bottleneck — every top-10 leaderboard entry runs raw
// sockets for the same reason. This file owns only bytes: parsing requests, framing
// responses, keep-alive. All semantics live in src/http.ts (createDispatcher).

import { createServer, type Server, type Socket } from 'node:net';
import type { TransportReply, TransportRequest } from './http.ts';

const HEADER_END = Buffer.from('\r\n\r\n');
const CONTINUE_100 = Buffer.from('HTTP/1.1 100 Continue\r\n\r\n');
const IDLE_TIMEOUT_MS = 30_000;
const MAX_HEAD_BYTES = 64 * 1024;
const MAX_BODY_BYTES = 64 * 1024 * 1024; // sanity cap; the biggest pack is ~1 MB

const REASONS: Record<number, string> = {
  200: 'OK',
  201: 'Created',
  204: 'No Content',
  400: 'Bad Request',
  401: 'Unauthorized',
  404: 'Not Found',
  405: 'Method Not Allowed',
  500: 'Internal Server Error',
};

type Dispatch = (req: TransportRequest) => TransportReply;

interface HeadParsed {
  method: string;
  url: string;
  version: string;
  headers: Record<string, string>;
  bodyStart: number;
}

/** Parse the request line + headers. Returns 'incomplete' until CRLF CRLF arrives. */
function parseHead(buf: Buffer): HeadParsed | 'incomplete' | 'bad' {
  const headEnd = buf.indexOf(HEADER_END);
  if (headEnd === -1) {
    return buf.length > MAX_HEAD_BYTES ? 'bad' : 'incomplete';
  }
  const head = buf.subarray(0, headEnd).toString('latin1');
  const lines = head.split('\r\n');
  const requestLine = (lines[0] as string).split(' ');
  if (requestLine.length !== 3) return 'bad';
  const [method, url, version] = requestLine as [string, string, string];
  if (method === '' || url === '' || !version.startsWith('HTTP/')) return 'bad';

  const headers: Record<string, string> = {};
  for (let i = 1; i < lines.length; i += 1) {
    const line = lines[i] as string;
    const colon = line.indexOf(':');
    if (colon === -1) return 'bad';
    const name = line.slice(0, colon).trim().toLowerCase();
    const value = line.slice(colon + 1).trim();
    headers[name] = headers[name] === undefined ? value : `${headers[name]}, ${value}`;
  }
  return { method, url, version, headers, bodyStart: headEnd + HEADER_END.length };
}

/** Parse the body for an already-parsed head. 'incomplete' until all body bytes arrive. */
function parseBody(buf: Buffer, head: HeadParsed): { body: Buffer; consumed: number } | 'incomplete' | 'bad' {
  const { headers, bodyStart } = head;
  const transferEncoding = (headers['transfer-encoding'] ?? '').toLowerCase();
  const contentLength = parseInt(headers['content-length'] ?? '', 10);

  if (transferEncoding.includes('chunked')) {
    const chunks: Buffer[] = [];
    let pos = bodyStart;
    for (;;) {
      const lineEnd = buf.indexOf('\r\n', pos);
      if (lineEnd === -1) return 'incomplete';
      const size = parseInt(buf.subarray(pos, lineEnd).toString('latin1').split(';')[0] as string, 16);
      if (Number.isNaN(size) || size < 0) return 'bad';
      const dataStart = lineEnd + 2;
      if (size === 0) {
        // Trailers end at the first empty line: after the 0-size line, a lone CRLF
        // means no trailers, otherwise trailer lines up to a CRLF CRLF.
        if (buf.subarray(dataStart, dataStart + 2).toString('latin1') === '\r\n') {
          return { body: Buffer.concat(chunks), consumed: dataStart + 2 };
        }
        const trailersEnd = buf.indexOf(HEADER_END, dataStart);
        if (trailersEnd === -1) return 'incomplete';
        return { body: Buffer.concat(chunks), consumed: trailersEnd + HEADER_END.length };
      }
      if (buf.length < dataStart + size + 2) return 'incomplete';
      chunks.push(buf.subarray(dataStart, dataStart + size));
      pos = dataStart + size + 2; // skip the chunk data and its trailing CRLF
    }
  }

  const length = Number.isNaN(contentLength) ? 0 : contentLength;
  if (length < 0 || length > MAX_BODY_BYTES) return 'bad';
  if (buf.length < bodyStart + length) return 'incomplete';
  const body = length === 0 ? Buffer.alloc(0) : Buffer.from(buf.subarray(bodyStart, bodyStart + length));
  return { body, consumed: bodyStart + length };
}

function keepAliveFor(version: string, headers: Record<string, string>): boolean {
  const connection = (headers.connection ?? '').toLowerCase();
  if (connection === 'close') return false;
  if (version === 'HTTP/1.0') return connection === 'keep-alive';
  return true; // HTTP/1.1+ defaults to keep-alive
}

/** Frame one reply. 204 carries no content-length; HEAD gets headers only. */
function frameReply(reply: TransportReply, version: string, keepAlive: boolean, isHead: boolean): Buffer {
  const reason = REASONS[reply.status] ?? 'Status';
  const lines: string[] = [`${version} ${reply.status} ${reason}`];
  if (reply.contentType !== '') lines.push(`content-type: ${reply.contentType}`);
  if (reply.status !== 204) lines.push(`content-length: ${reply.body.length}`);
  for (const [name, value] of Object.entries(reply.headers ?? {})) lines.push(`${name}: ${value}`);
  lines.push(`connection: ${keepAlive ? 'keep-alive' : 'close'}`);
  const head = Buffer.from(`${lines.join('\r\n')}\r\n\r\n`, 'latin1');
  if (isHead || reply.body.length === 0) return head;
  return Buffer.concat([head, reply.body]);
}

/** Build a raw TCP server around the dispatcher. Interface matches node:http's Server
 *  closely enough for main.ts: listen(0), address(), close(), once('error'). */
export function createTransportServer(dispatch: Dispatch): Server {
  const server = createServer((sock: Socket) => {
    sock.setNoDelay(true);
    sock.setTimeout(IDLE_TIMEOUT_MS, () => sock.destroy());
    sock.on('error', () => sock.destroy());
    let buf = Buffer.alloc(0);
    let expectSent = false;

    // Drain the buffered requests. Called on new data and again after a
    // backpressure drain, so a request already sitting in `buf` is never
    // left waiting for more bytes that will never come.
    const pump = (): void => {
      for (;;) {
        const head = parseHead(buf);
        if (head === 'incomplete') return;
        if (head === 'bad') {
          sock.destroy();
          return;
        }
        // curl (real git) waits for 100 Continue before sending a large body:
        // answer it the moment the headers are in, or every push pays a 1 s stall.
        // This runs before the body arrives, so it must live here, not after body parsing.
        if (!expectSent && (head.headers.expect ?? '').toLowerCase().includes('100-continue')) {
          expectSent = true;
          sock.write(CONTINUE_100);
        }
        const bodyRes = parseBody(buf, head);
        if (bodyRes === 'incomplete') return; // keep waiting; expectSent stays set
        if (bodyRes === 'bad') {
          sock.destroy();
          return;
        }
        expectSent = false;
        buf = buf.subarray(bodyRes.consumed);
        const keepAlive = keepAliveFor(head.version, head.headers);
        let reply: TransportReply;
        try {
          reply = dispatch({ method: head.method, url: head.url, headers: head.headers, body: bodyRes.body });
        } catch (err) {
          // One bad request must never kill the process: answer 500 JSON and keep serving.
          const body = Buffer.from(JSON.stringify({ message: err instanceof Error ? err.message : String(err) }), 'utf8');
          reply = { status: 500, contentType: 'application/json', body, headers: { 'x-github-request-id': `req-${process.pid}-err` } };
        }
        const out = frameReply(reply, head.version, keepAlive, head.method === 'HEAD');
        const flushed = sock.write(out);
        if (!keepAlive) {
          sock.end();
          return;
        }
        if (!flushed) {
          // Backpressure: stop reading until the socket drains, then pump again —
          // `buf` may already hold complete requests, and no new data will arrive
          // to wake them up.
          sock.pause();
          sock.once('drain', () => {
            sock.resume();
            pump();
          });
          return;
        }
        if (buf.length === 0) return;
      }
    };

    sock.on('data', (chunk: Buffer) => {
      buf = buf.length === 0 ? chunk : Buffer.concat([buf, chunk]);
      pump();
    });
  });
  return server;
}
