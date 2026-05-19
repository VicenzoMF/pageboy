# pageboy

Turn any web article into a queryable MCP server. Point it at a URL, it extracts
the readable content, chunks it, indexes it, and exposes search/get tools to any
MCP-aware client (Claude Code, Codex, etc.) — all from a single local SQLite
file.

- **Storage:** SQLite + FTS5 (BM25). One file, zero infra.
- **Semantic search:** optional, via [sqlite-vec](https://github.com/asg017/sqlite-vec).
  Embeddings can be local (Transformers.js or Ollama) or remote (OpenAI).
- **Hybrid:** combines FTS5 and vector with Reciprocal Rank Fusion.
- **Collections:** multiple isolated knowledge bases in the same DB.
- **MCP server:** stdio transport, five tools.

## Install

Node ≥ 20.

```bash
# From npm (recommended)
npm install -g pageboy

# Or run without installing
npx pageboy serve
```

From source:

```bash
git clone https://github.com/VicenzoMF/pageboy.git
cd pageboy
npm install
npm run build
```

### What you get by default

The default install is intentionally lean — **FTS5 (BM25) full-text search
works out of the box**, with no extra downloads:

| Feature | Default | How to enable |
|---|---|---|
| FTS5 keyword search | ✅ | always on |
| Section-aware chunking | ✅ | always on |
| Recursive crawl (`--recursive`) | ✅ | always on |
| Semantic / hybrid search | ❌ | pick an embedding provider (see below) |
| Cross-encoder reranking (`--rerank`) | ❌ | `npm i @huggingface/transformers` |

### Optional: enable semantic search and rerank

Both **local embeddings** (Transformers.js) and the **cross-encoder reranker**
share one optional dependency:

```bash
# Local, fully offline (~50 MB ONNX runtime + models on first use)
npm install @huggingface/transformers
```

Already have Ollama or an OpenAI key? You can skip the install entirely —
pageboy will use them instead (details in [Embeddings](#embeddings-optional-but-recommended)).

> The `@huggingface/transformers` package is declared as an **optional
> dependency**, so it does *not* install by default with `npm install -g
> pageboy`. The package is sizable (it ships an ONNX runtime); we keep it
> opt-in so the base CLI stays small. Install it whenever you want local
> embeddings or reranking — pageboy auto-detects it at runtime.

## Quick start

```bash
# Index an article (FTS only, no embeddings needed)
pageboy add https://example.com/some-post

# List what you've indexed
pageboy list

# Search (defaults to hybrid if embeddings exist, else FTS)
pageboy search "what does it say about hooks"
```

The DB lives at `./data/pageboy.db` (override with `--db <path>` or
`PAGEBOY_DB=...`).

## Wire it into Claude Code

```bash
# If installed globally
claude mcp add pageboy pageboy serve

# Or via npx (no install required)
claude mcp add pageboy npx pageboy serve
```

Or add to `.mcp.json` in any project:

```json
{
  "mcpServers": {
    "pageboy": {
      "command": "npx",
      "args": ["pageboy", "serve"]
    }
  }
}
```

Restart Claude Code. Tools available:

| Tool | What it does |
|---|---|
| `list_collections` | List all collections with doc counts |
| `list_docs(collection?)` | List indexed documents |
| `search_docs(query, collection?, limit?, mode?)` | Search chunks (BM25 / vector / hybrid) |
| `get_doc(id)` | Return full text of a document |
| `refresh_doc(id)` | Re-fetch and re-index a document |

## CLI commands

```
pageboy add <url> [-c <collection>] [--no-embed]
                   [-r|--recursive] [--max-depth N] [--max-pages N]
                   [--cross-origin] [--delay-ms N]
                   [--include <regex>] [--exclude <regex>]
pageboy list [-c <collection>]
pageboy collections
pageboy search <query...> [-m fts|vector|hybrid] [-c <collection>] [-n <limit>]
                          [--rerank] [--rerank-model <id>]
pageboy refresh <id|--all> [-c <collection>] [--no-embed]
pageboy embed [-c <collection>]
pageboy serve            # start MCP server on stdio
```

Add `--db <path>` to any command to target a different SQLite file.

## Recursive crawl

```bash
# Index up to 50 pages, depth 2, staying on the same origin
pageboy add https://example.com/docs --recursive --max-depth 2 --max-pages 50

# Limit by URL pattern
pageboy add https://example.com/docs -r \
  --include '^https://example\.com/docs/(api|guides)/' \
  --exclude '\\.(png|jpg)$'
```

Each page is fetched, extracted with Readability, chunked, and indexed.
Same-origin is the default; pass `--cross-origin` to follow external links.

## Reranking

Reranking runs a cross-encoder over the top candidates to reorder them by
true relevance to the query. It's optional, and needs the same
`@huggingface/transformers` package as local embeddings:

```bash
npm install @huggingface/transformers        # one-time
pageboy search "how does the auth token rotate" --rerank
```

Default model: `Xenova/ms-marco-MiniLM-L-6-v2` (~80 MB, downloaded on first
use). Override with `--rerank-model <id>` or `PAGEBOY_RERANK_MODEL=...`.

For the MCP server, set `PAGEBOY_RERANK=1` to rerank on every call.

If `@huggingface/transformers` is **not** installed and you pass `--rerank`,
pageboy prints a warning and falls back to the un-reranked results.

## Collections

Each doc lives in a collection (default: `default`). Use collections to keep
distinct knowledge bases — say, separate `stripe-docs` from `internal-runbooks`
— in the same SQLite file:

```bash
pageboy add https://stripe.com/docs/api -c stripe-docs
pageboy add https://example.com/runbook -c runbooks
pageboy search "rate limit" -c stripe-docs
```

## Embeddings (optional, but recommended)

Without embeddings you get FTS5 only — fast, but vocabulary-literal: queries
must share words with the text. Add embeddings to get semantic + hybrid search
that handles paraphrases and cross-language queries.

pageboy picks a provider in this order:

1. **OpenAI** — if `OPENAI_API_KEY` is set
2. **Ollama** — if reachable at `http://127.0.0.1:11434` or `OLLAMA_HOST` is set
3. **Transformers.js** — fully local, no API. Used when
   `@huggingface/transformers` is installed (it is **opt-in**; install with
   `npm install @huggingface/transformers`).

If none of the three is available, pageboy stays on FTS5 only — `add` and
`search` keep working without embeddings.

Force a specific provider:

```bash
export PAGEBOY_EMBED_PROVIDER=ollama       # or openai, transformers
export PAGEBOY_EMBED_MODEL=nomic-embed-text # provider-specific default otherwise
```

### Ollama example

```bash
ollama pull nomic-embed-text
pageboy add https://example.com/article          # auto-embeds with Ollama
pageboy search "paraphrased question" -m hybrid
```

### Transformers.js

Install once:

```bash
npm install @huggingface/transformers
```

Default model: `Xenova/all-MiniLM-L6-v2` (384 dim, ~25 MB, downloaded on first
use). To go lighter or stronger:

```bash
PAGEBOY_EMBED_MODEL=Xenova/bge-small-en-v1.5 pageboy embed
```

Prefer to skip the ~50 MB ONNX runtime? Just don't install
`@huggingface/transformers` — use Ollama or OpenAI instead, or stay on
FTS-only search.

### OpenAI

```bash
export OPENAI_API_KEY=sk-...
# Optional:
export PAGEBOY_EMBED_MODEL=text-embedding-3-small
export PAGEBOY_EMBED_DIM=1536
pageboy add <url>
```

### Retroactive embedding

If you indexed docs before configuring a provider, fill in the missing
embeddings later:

```bash
pageboy embed                # everything missing
pageboy embed -c stripe-docs # only one collection
```

## Refresh

Articles change. Re-fetch and re-index in place (IDs are preserved):

```bash
pageboy refresh 1            # one doc
pageboy refresh --all        # everything
```

A content-hash check makes no-op refreshes essentially free: if the page hasn't
changed, only `fetched_at` is updated, no chunks are touched.

## Architecture

```
URL ─► fetch ─► JSDOM + Readability ─► section-aware chunk ──┐
                                                              ├─► SQLite (FTS5)
                                                              └─► sqlite-vec (optional)
                                                                     ▲
                                                          embeddings provider
                                                       (OpenAI / Ollama / Transformers.js)

                                  search ─► FTS + vector ─► RRF ─► [cross-encoder rerank]
```

- **Chunking:** walks the Readability HTML, tracks H1/H2/H3 path, prefixes each
  chunk with `Title > H2 > H3` so both FTS and embeddings get section context.
  Soft target ~1400 chars, breaks on paragraph boundaries, sentence-splits long
  paragraphs.
- **FTS5:** unicode61 tokenizer with diacritic folding. BM25 ranking.
- **Vector store:** `vec0` virtual table from sqlite-vec. Embeddings stored as
  raw `FLOAT[dim]` blobs.
- **Hybrid:** RRF (k=60) over the top-N FTS hits and top-N vector hits.
- **Reranker (optional):** Transformers.js cross-encoder
  (`Xenova/ms-marco-MiniLM-L-6-v2` by default) over the top 4× candidates.
  Toggle with `--rerank` on the CLI or `PAGEBOY_RERANK=1` for the MCP server.
- **Recursive crawl:** opt-in BFS (`--recursive`) with `--max-depth`, `--max-pages`,
  same-origin by default, `--delay-ms`, and `--include`/`--exclude` regex filters.
- **Migrations:** `PRAGMA user_version` controls schema versions; old DBs are
  migrated forward on open.

## Environment variables

| Variable | Default | Purpose |
|---|---|---|
| `PAGEBOY_DB` | `./data/pageboy.db` | DB path |
| `PAGEBOY_EMBED_PROVIDER` | auto | `openai` / `ollama` / `transformers` |
| `PAGEBOY_EMBED_MODEL` | provider-specific | Embedding model name |
| `PAGEBOY_EMBED_DIM` | provider-specific | Override vector dim |
| `OPENAI_API_KEY` | — | OpenAI auth (also gates auto-detection) |
| `OPENAI_BASE_URL` | `https://api.openai.com/v1` | OpenAI-compatible endpoints |
| `OLLAMA_HOST` / `OLLAMA_URL` | `http://127.0.0.1:11434` | Ollama base URL |
| `PAGEBOY_RERANK` | — | Set to `1` to enable cross-encoder reranking on every search |
| `PAGEBOY_RERANK_MODEL` | `Xenova/ms-marco-MiniLM-L-6-v2` | Reranker model id (Transformers.js) |

## Limitations

- One writer at a time (SQLite WAL). Fine for personal use, not for shared
  servers.
- Fetches static HTML only (no headless browser). SPAs and pages behind
  Cloudflare challenges may extract poorly. Pre-rendered docs (Next.js SSG,
  Stripe, Hugo, etc.) work well.
- Recursive crawl is BFS over anchor tags; it does not parse sitemaps and
  ignores `robots.txt`. Use `--include`/`--exclude` and `--max-pages` to keep
  it polite.
- Embeddings are computed once per chunk; switching providers/models with
  different dims requires re-embedding (or a fresh DB).
- The cross-encoder reranker downloads ~80 MB on first use and adds
  ~50–200 ms per query.

## License

MIT.
