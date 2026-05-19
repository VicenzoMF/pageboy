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

```bash
git clone git@github.com:<you>/pageboy.git
cd pageboy
npm install
npm run build
```

Node ≥ 20.

## Quick start

```bash
# Index an article
node dist/cli.js add https://example.com/some-post

# List what you've indexed
node dist/cli.js list

# Search (defaults to hybrid if embeddings exist, else FTS)
node dist/cli.js search "what does it say about hooks"
```

The DB lives at `./data/pageboy.db` (override with `--db <path>` or
`PAGEBOY_DB=...`).

## Wire it into Claude Code

```bash
claude mcp add pageboy node /absolute/path/to/pageboy/dist/cli.js serve
```

Or add to `.mcp.json` in any project:

```json
{
  "mcpServers": {
    "pageboy": {
      "command": "node",
      "args": ["/absolute/path/to/pageboy/dist/cli.js", "serve"]
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
pageboy list [-c <collection>]
pageboy collections
pageboy search <query...> [-m fts|vector|hybrid] [-c <collection>] [-n <limit>]
pageboy refresh <id|--all> [-c <collection>] [--no-embed]
pageboy embed [-c <collection>]
pageboy serve            # start MCP server on stdio
```

Add `--db <path>` to any command to target a different SQLite file.

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
3. **Transformers.js** — fully local, zero setup. Used by default when
   `@huggingface/transformers` is installed (it is, in the default `npm install`).

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

Default model: `Xenova/all-MiniLM-L6-v2` (384 dim, ~25 MB, downloaded on first
use). To go lighter or stronger:

```bash
PAGEBOY_EMBED_MODEL=Xenova/bge-small-en-v1.5 pageboy embed
```

If you don't want the ~50 MB ONNX runtime in your install:

```bash
npm uninstall @huggingface/transformers
```

…and rely on Ollama or OpenAI instead.

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
URL ─► fetch ─► JSDOM + Readability ─► chunk ──┐
                                                ├─► SQLite (FTS5)
                                                └─► sqlite-vec (optional)
                                                       ▲
                                              embeddings provider
                                              (OpenAI / Ollama / Transformers.js)
```

- **Chunking:** ~1400 chars, splits on paragraph boundaries, falls back to
  sentence splits for long paragraphs.
- **FTS5:** unicode61 tokenizer with diacritic folding. BM25 ranking.
- **Vector store:** `vec0` virtual table from sqlite-vec. Embeddings stored as
  raw `FLOAT[dim]` blobs.
- **Hybrid:** RRF (k=60) over the top-N FTS hits and top-N vector hits.
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

## Limitations

- One writer at a time (SQLite WAL). Fine for personal use, not for shared
  servers.
- No incremental crawling — `add <url>` indexes one page. Recursion / sitemap
  parsing isn't implemented.
- Embeddings are computed once per chunk; switching providers/models with
  different dims requires re-embedding (or a fresh DB).

## License

MIT.
