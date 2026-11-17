// The server the forge runs: one in-memory store shared by git smart HTTP, REST v3,
// GraphQL v4 and MCP, with the viewer identity derived from the scenario's sealed seed
// (the suite's token names that viewer, so the store must too). main.ts owns the
// entry <-> env lifecycle; this file only builds the server around the store.
//
// Transport is a hand-rolled HTTP/1.1 server on raw node:net (src/transport.ts),
// not node:http: measured 2026-11-17, node:http costs ~0.8 ms per request on this
// host (floor 1.62-1.72 ms/op vs raw 0.73-0.96 ms/op), and the bench is thousands
// of tiny requests. The dispatcher (src/http.ts) is unchanged in behaviour.

import type { Server } from 'node:net';
import { createDispatcher } from './src/http.ts';
import { deriveScenarioIdentity } from './src/scenario.ts';
import { Store } from './src/store.ts';
import { createTransportServer } from './src/transport.ts';

/** Build the server. It binds nothing until the caller listens; the entry listens on an ephemeral port. */
export function createApp(): Server {
  const identity = deriveScenarioIdentity();
  const store = new Store(identity);
  const token = process.env.MAKEFUN_SHOP_TOKEN ?? '';
  const dispatch = createDispatcher({ store, token });
  return createTransportServer(dispatch);
}
