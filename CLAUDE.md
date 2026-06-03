# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

The npm package is **`pageboy`**; the working directory is named `InstantRAG` for historical reasons. Always refer to the tool as `pageboy` in code, docs, and CLI output.

## Commands

| Task | Command |
|---|---|
| Build (TypeScript → `dist/`) | `npm run build` |
| Dev run (no build, via tsx) | `npm run dev -- <args>` |
| Run all tests | `npm test` (builds first, then `node --test tests/*.test.mjs`) |
| Run one test file | `npm run build && node --test tests/store.test.mjs` |
| Run a single test by name | `node --test --test-name-pattern="ftsSearch finds" tests/store.test.mjs` (after build) |
| Start MCP server (stdio) | `node dist/cli.js serve` |
| Smoke-check publish artifact | `npm pack --dry-run` (CI runs this) |

**Tests import the compiled output (`../dist/store.js`).** Any code change that isn't followed by `npm run build` will be invisible to the test runner — `npm test` handles this; running `node --test` directly does not.

CI matrix is Node 20 and 22; Node ≥ 20 is required.

## Architecture

End-to-end pipeline:

```
URL → fetch → JSDOM + Readability → section-aware chunks
                                      ↓
                              SQLite (FTS5) + sqlite-vec (optional)
                                      ↓
                  search: FTS ∪ vector → RRF fusion → optional cross-encoder rerank
                                      ↓
                              CLI / MCP stdio server
```

### Module map (`src/`)

- **`store.ts`** — `better-sqlite3` wrapper. Owns schema, FTS5 triggers, `vec0` virtual table from `sqlite-vec`, and all reads/writes. Migrations are gated by `PRAGMA user_version` (currently v3); add a new `migrateToV<N>()` and bump `current < N` in `migrate()` to evolve the schema. The embedding dim is **locked on first `initEmbeddings` call** and persisted in the `meta` table — switching models/dims later throws; use a fresh DB. Hybrid search is `rrfFuse` (k=60) over independent FTS and vector top-N lists. `toFtsQuery` drops tokens ≤ 3 chars and ORs the rest as prefix matches (`"tok"*`).
- **`ingest.ts`** — Fetches HTML, runs Readability, then `walkSections` walks the cleaned DOM tracking H1/H2/H3 into a `path[]`. `chunkText` packs paragraphs into ~1400-char chunks (MIN 400), splitting long paragraphs on sentence boundaries. Each chunk's text is prefixed with `Title > H2 > H3\n\n…` so both BM25 and embeddings see the section context. Dedup is by SHA-256 over chunk texts + section paths; identical content just refreshes `fetched_at`.
- **`crawler.ts`** — Opt-in BFS (`pageboy add --recursive`). Same-origin by default, configurable depth/max-pages/delay and `--include`/`--exclude` regex filters. Calls back into `ingestFetched` per page.
- **`embeddings.ts`** — `EmbeddingProvider` interface with three implementations (OpenAI, Ollama, Transformers.js) and a priority-based selector `getEmbeddingProvider()`: explicit `PAGEBOY_EMBED_PROVIDER` → OpenAI (if `OPENAI_API_KEY`) → Ollama (if reachable) → Transformers.js (if installed). Returns `null` if none available; callers must handle that and fall back to FTS-only.
- **`reranker.ts`** — Optional cross-encoder via Transformers.js. Cached singleton keyed by model id. `getReranker()` returns one only if `PAGEBOY_RERANK=1` (or `PAGEBOY_RERANK_MODEL` is set); CLI `--rerank` calls `loadReranker(...)` directly to force-load.
- **`mcp-server.ts`** — `@modelcontextprotocol/sdk` stdio server. Exposes five tools: `list_collections`, `list_docs`, `search_docs`, `get_doc`, `refresh_doc`. `search_docs` mirrors the CLI's search pipeline (mode defaults to `hybrid` if embeddings exist, else `fts`; auto-applies the reranker when enabled by env).
- **`cli.ts`** — `commander` entry point, also exported as the `pageboy` bin. The `runSearch` helper is shared between the `search` command and used as a template for the MCP handler. `runDoctor` powers `pageboy doctor`. The global `--db` default comes from `resolveDefaultDb()`.
- **`dbpath.ts`** — `resolveDefaultDb()` picks the default DB path so that `add` (your shell) and `serve` (the editor-spawned MCP process) agree regardless of cwd. Priority: `PAGEBOY_DB` → existing `data/pageboy.db` in cwd or any ancestor → `data/pageboy.db` at the nearest `.git` root → `~/.pageboy/pageboy.db`. This replaced the old cwd-relative `./data/pageboy.db` default, which silently diverged when the two processes ran from different directories.

### Optional dependency pattern (don't break it)

`@huggingface/transformers` is declared as an **optional** dependency so the base install stays small. Both `embeddings.ts` and `reranker.ts` load it via:

```ts
const mod = await (Function("s", "return import(s)") as (s: string) => Promise<unknown>)(spec);
```

The `Function(...)` indirection is deliberate — it prevents `tsc` from trying to resolve `@huggingface/transformers` types at build time when the package isn't installed. **Do not** replace these with a plain `await import("@huggingface/transformers")` or a static import; the build will fail in lean environments (including the CI matrix). The same applies to the legacy `@xenova/transformers` fallback alias.

### Data layout & env

- The default DB is resolved by `resolveDefaultDb()` (see `dbpath.ts`): `PAGEBOY_DB` env → existing `data/pageboy.db` in cwd/ancestors → `data/pageboy.db` at the nearest `.git` root → `~/.pageboy/pageboy.db`. Override explicitly with `--db <path>` or `PAGEBOY_DB`. `pageboy doctor` prints the path it resolved.
- Provider env vars: `PAGEBOY_EMBED_PROVIDER`, `PAGEBOY_EMBED_MODEL`, `PAGEBOY_EMBED_DIM`, `OPENAI_API_KEY`, `OPENAI_BASE_URL`, `OLLAMA_HOST`/`OLLAMA_URL`.
- Rerank env vars: `PAGEBOY_RERANK` (set to `1`/`true` to enable in the MCP server), `PAGEBOY_RERANK_MODEL`.
- `pageboy doctor` is the source of truth for what the runtime currently sees — run it when debugging "why isn't semantic search on?" type questions.

### TypeScript / module setup

- ESM output (`"type": "module"`, NodeNext resolution). Internal imports must use `.js` extensions even though sources are `.ts` (e.g. `import { Store } from "./store.js"`).
- Strict mode is on. `dist/` is the published artifact; `src/` is not shipped.
