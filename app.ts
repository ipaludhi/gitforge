// The server the forge runs: one in-memory store shared by git smart HTTP, REST v3,
// GraphQL v4 and MCP, with the viewer identity derived from the scenario's sealed seed
// (the suite's token names that viewer, so the store must too). main.ts owns the
// entry <-> env lifecycle; this file only builds the HTTP server around the store.

import { createServer, type Server } from 'node:http';
import { createHandler } from './src/http.ts';
import { deriveScenarioIdentity } from './src/scenario.ts';
import { Store } from './src/store.ts';

/** Build the server. It binds nothing until the caller listens; the entry listens on an ephemeral port. */
export function createApp(): Server {
  const identity = deriveScenarioIdentity();
  const store = new Store(identity);
  const token = process.env.MAKEFUN_SHOP_TOKEN ?? '';
  const handler = createHandler({ store, token });
  return createServer((req, res) => {
    handler(req, res).catch((err: unknown) => {
      // One bad request must never kill the process: answer 500 JSON and keep serving.
      try {
        res.writeHead(500, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ message: err instanceof Error ? err.message : String(err) }));
      } catch {
        // The socket is already gone; there is nothing left to answer.
      }
    });
  });
}
