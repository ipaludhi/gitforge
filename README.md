# GitForge — a GitHub-compatible git forge in pure Node.js

[![make.fun · github-core-clone-01](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![rank](https://make.fun/badge/github-core-clone-01/ipaludhi/gitforge/rank.svg)](https://make.fun/bounty/github-core-clone-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![reward](https://make.fun/badge/github-core-clone-01/ipaludhi/gitforge/reward.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)

A single-process, dependency-free git forge that speaks the real protocols:
smart HTTP git (v0 + v2, with delta packs), REST v3, GraphQL v4, and MCP.
One in-memory store backs all four surfaces, so a repo, issue, or pull request
created through any one of them reads back identically through the others.

## What it implements

- **Git smart HTTP** — `git-upload-pack` / `git-receive-pack` over
  `/{owner}/{repo}.git/info/refs` and `/{owner}/{repo}.git/git-*-pack`.
  Protocol v2 (ls-refs, fetch with thin-pack, shallow/deepen, multi-round
  acknowledgments) and v0 receive-pack with report-status sideband framing.
  Packs are read and written in pure code, including OFS/REF deltas and thin
  packs; verified end-to-end against real `git` 2.43 (clone, push, pull, tags,
  branches, delta-heavy pushes).
- **REST v3** (`/api/v3`) — repos, branches, commits, contents, labels,
  issues, comments, pull requests (including squash merge with a real
  three-way conflict check), pagination via `Link` headers.
- **GraphQL v4** (`/api/graphql`) — viewer, repository, node, `__type`
  introspection, issues and pull requests with cursor pagination, and the
  create/close/merge/comment mutations. Global ids are opaque and stable.
- **MCP** (`/mcp`) — Streamable HTTP JSON-RPC with `server/discover`,
  `initialize`, `tools/list` (six canonical tools) and `tools/call`.

Everything is deterministic: server-made commits use a fixed identity and
epoch, so object ids are reproducible run to run.

## Running it

Requires Node 22+ (type stripping is built in; no build step, no dependencies).

```sh
MAKEFUN_SHOP_TOKEN=<token> node --experimental-strip-types main.ts
```

`main.ts` is the harness lifecycle: it reads `MAKEFUN_ENV_URL`, starts the
server on an ephemeral port, registers it, and exits when the environment
signals done. For local development, set `MAKEFUN_SHOP_TOKEN` and run the
server directly; `/healthz` answers without auth.

## Layout

- `main.ts` — entrypoint / harness lifecycle (unchanged starter behaviour).
- `app.ts` — builds the store and HTTP server.
- `src/http.ts` — router, auth, request ids.
- `src/store.ts` — the shared in-memory store (objects, refs, issues, pulls).
- `src/gitobj.ts` — git objects, pkt-lines, pack reading/writing, deltas.
- `src/gitproto.ts` — smart HTTP: advertisements, ls-refs, fetch, receive-pack.
- `src/scenario.ts` — the sealed scenario identity (viewer, org, stranger).
- `src/rest.ts` — REST v3 handlers.
- `src/graphql.ts` — GraphQL parser, executor, and schema.
- `src/mcp.ts` — MCP discover/initialize/tools.

## Verification

Graded locally against the competition's sealed conformance suite
(`sdk/run.ts --perf`): **120/120 checks pass** (feature 600, agent 200),
plus the four benchmark workloads. Real-git smoke tests (clone, push, pull,
tag, branch, delta push) pass against `git` 2.43.
