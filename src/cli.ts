#!/usr/bin/env node
import { Command } from "commander";
import { DEFAULT_COLLECTION, Store, type SearchHit, type SearchMode } from "./store.js";
import { existsSync, statSync } from "node:fs";
import { resolveDefaultDb } from "./dbpath.js";
import { embedPending, ingestUrl } from "./ingest.js";
import { crawl } from "./crawler.js";
import {
  getEmbeddingProvider,
  probeOllama,
  transformersJsAvailable,
} from "./embeddings.js";
import { getReranker, loadReranker, type Reranker } from "./reranker.js";
import { startMcpServer } from "./mcp-server.js";

const DEFAULT_DB = resolveDefaultDb();

const program = new Command();
program
  .name("pageboy")
  .description("Turn web articles into a queryable MCP server")
  .option(
    "--db <path>",
    "SQLite database path (default: auto-discovered project DB; env: PAGEBOY_DB)",
    DEFAULT_DB,
  );

program
  .command("add <url>")
  .description("Fetch a URL, extract the article, and index it")
  .option("-c, --collection <name>", "Target collection", DEFAULT_COLLECTION)
  .option("--no-embed", "Skip embeddings even if provider is configured")
  .option("-r, --recursive", "Recursively crawl same-origin links")
  .option("--max-depth <n>", "Max crawl depth (recursive)", "2")
  .option("--max-pages <n>", "Max pages to crawl (recursive)", "50")
  .option("--cross-origin", "Allow links to other origins (recursive)")
  .option("--delay-ms <n>", "Delay between requests in ms (recursive)", "250")
  .option("--include <regex>", "Only crawl URLs matching this regex")
  .option("--exclude <regex>", "Skip URLs matching this regex")
  .action(async (url: string, opts, cmd) => {
    const { db } = cmd.optsWithGlobals();
    const store = new Store(db);
    try {
      const embedder = await resolveEmbedder(opts);

      if (opts.recursive) {
        const summary = await crawl(url, store, {
          collection: opts.collection,
          embedder,
          maxDepth: Number(opts.maxDepth),
          maxPages: Number(opts.maxPages),
          sameOrigin: !opts.crossOrigin,
          delayMs: Number(opts.delayMs),
          include: opts.include ? new RegExp(opts.include) : undefined,
          exclude: opts.exclude ? new RegExp(opts.exclude) : undefined,
          onPage: (e) => {
            const prefix = `  d${e.kind === "skipped" ? "-" : e.depth}`;
            if (e.kind === "indexed") {
              const embedNote = e.result.embedded > 0
                ? `, embedded ${e.result.embedded}`
                : "";
              console.log(
                `${prefix} indexed #${e.result.docId}: ${e.result.title} (${e.result.chunkCount} chunks${embedNote})\n     ${e.url}`,
              );
            } else if (e.kind === "unchanged") {
              console.log(`${prefix} unchanged #${e.result.docId}: ${e.url}`);
            } else if (e.kind === "failed") {
              console.error(`${prefix} failed: ${e.url} — ${e.error}`);
            } else {
              console.log(`${prefix} skipped (${e.reason}): ${e.url}`);
            }
          },
        });
        console.log(
          `\nCrawl summary: visited=${summary.visited} indexed=${summary.indexed} unchanged=${summary.unchanged} failed=${summary.failed} skipped=${summary.skipped}`,
        );
        return;
      }

      const result = await ingestUrl(url, store, {
        collection: opts.collection,
        embedder,
      });
      const status = result.unchanged ? "unchanged" : "indexed";
      const embedNote = result.embedded > 0 ? `, embedded ${result.embedded}` : "";
      console.log(
        `${status} #${result.docId} [${opts.collection}]: ${result.title} (${result.chunkCount} chunks${embedNote})`,
      );
    } finally {
      store.close();
    }
  });

program
  .command("refresh [id]")
  .description("Re-fetch and re-index documents")
  .option("-a, --all", "Refresh every doc")
  .option("-c, --collection <name>", "Limit --all to a collection")
  .option("--no-embed", "Skip embeddings")
  .action(async (idArg: string | undefined, opts, cmd) => {
    const { db } = cmd.optsWithGlobals();
    const store = new Store(db);
    try {
      const embedder = await resolveEmbedder(opts);
      const targets: { id: number; url: string; collection: string }[] = [];

      if (opts.all) {
        for (const d of store.listDocs(opts.collection)) {
          targets.push({ id: d.id, url: d.url, collection: d.collection });
        }
      } else if (idArg) {
        const got = store.getDoc(Number(idArg));
        if (!got) throw new Error(`No document with id ${idArg}`);
        targets.push({
          id: got.doc.id,
          url: got.doc.url,
          collection: got.doc.collection,
        });
      } else {
        throw new Error("Pass an id or --all");
      }

      for (const t of targets) {
        try {
          const r = await ingestUrl(t.url, store, {
            collection: t.collection,
            embedder,
          });
          const status = r.unchanged ? "unchanged" : "refreshed";
          console.log(`${status} #${t.id} [${t.collection}]: ${r.title}`);
        } catch (e) {
          console.error(
            `failed #${t.id} ${t.url}: ${e instanceof Error ? e.message : e}`,
          );
        }
      }
    } finally {
      store.close();
    }
  });

program
  .command("embed")
  .description("Compute embeddings for chunks missing them")
  .option("-c, --collection <name>", "Limit to a collection")
  .action(async (opts, cmd) => {
    const { db } = cmd.optsWithGlobals();
    const store = new Store(db);
    try {
      const provider = await getEmbeddingProvider();
      if (!provider) {
        throw new Error(
          "No embedding provider available. Options: install @huggingface/transformers (default), run Ollama (`ollama pull nomic-embed-text`), or set OPENAI_API_KEY.",
        );
      }
      console.error(`Using embedding provider: ${provider.name} (${provider.model}, dim=${provider.dim})`);
      const n = await embedPending(store, provider, {
        collection: opts.collection,
      });
      console.log(
        `Embedded ${n} chunks with ${provider.model} (dim=${provider.dim}).`,
      );
    } finally {
      store.close();
    }
  });

program
  .command("list")
  .description("List indexed documents")
  .option("-c, --collection <name>", "Filter by collection")
  .action((opts, cmd) => {
    const { db } = cmd.optsWithGlobals();
    const store = new Store(db);
    try {
      const docs = store.listDocs(opts.collection);
      if (docs.length === 0) {
        console.log("(no documents)");
        return;
      }
      for (const d of docs) {
        console.log(
          `#${d.id} [${d.collection}]  ${d.title}\n     ${d.url}  (${d.chunk_count} chunks, ${d.fetched_at})`,
        );
      }
    } finally {
      store.close();
    }
  });

program
  .command("collections")
  .description("List collections with document counts")
  .action((_opts, cmd) => {
    const { db } = cmd.optsWithGlobals();
    const store = new Store(db);
    try {
      const cs = store.listCollections();
      if (cs.length === 0) {
        console.log("(no collections)");
        return;
      }
      for (const c of cs) console.log(`${c.collection}  (${c.doc_count} docs)`);
      const model = store.embeddingModel();
      if (model) console.log(`\nembeddings: ${model} (dim=${store.embeddingDim()})`);
    } finally {
      store.close();
    }
  });

program
  .command("search <query...>")
  .description("Search across indexed chunks")
  .option("-n, --limit <n>", "max results", "6")
  .option("-c, --collection <name>", "Filter by collection")
  .option("-m, --mode <mode>", "fts | vector | hybrid (default: hybrid if embeddings)")
  .option("--rerank", "Apply cross-encoder reranker (Transformers.js)")
  .option("--rerank-model <id>", "Override reranker model id")
  .action(async (queryParts: string[], opts, cmd) => {
    const { db } = cmd.optsWithGlobals();
    const store = new Store(db);
    try {
      const query = queryParts.join(" ");
      const limit = Number(opts.limit);
      const mode = (opts.mode as SearchMode | undefined) ?? autoMode(store);
      let reranker: Reranker | null;
      if (opts.rerank) {
        reranker = await loadReranker(
          opts.rerankModel ??
            process.env.PAGEBOY_RERANK_MODEL ??
            "Xenova/ms-marco-MiniLM-L-6-v2",
        );
        if (!reranker) {
          console.error(
            "warning: --rerank requested but @huggingface/transformers is not installed. Run: npm install @huggingface/transformers",
          );
        }
      } else {
        reranker = await getReranker();
      }

      const hits = await runSearch(store, query, mode, {
        collection: opts.collection,
        limit,
        reranker,
      });
      printHits(hits, mode);
    } finally {
      store.close();
    }
  });

program
  .command("doctor")
  .description("Diagnose runtime, database, and provider availability")
  .action(async (_opts, cmd) => {
    const { db } = cmd.optsWithGlobals();
    await runDoctor(db);
  });

program
  .command("serve")
  .description("Start the MCP server over stdio")
  .action(async (_opts, cmd) => {
    const { db } = cmd.optsWithGlobals();
    const store = new Store(db);
    await startMcpServer(store);
  });

program.parseAsync().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});

// ---------- helpers ----------

async function resolveEmbedder(opts: { embed?: boolean }) {
  if (opts.embed === false) return null;
  return await getEmbeddingProvider();
}

function autoMode(store: Store): SearchMode {
  return store.hasEmbeddings() ? "hybrid" : "fts";
}

export async function runSearch(
  store: Store,
  query: string,
  mode: SearchMode,
  opts: { collection?: string; limit?: number; reranker?: Reranker | null },
): Promise<SearchHit[]> {
  const limit = opts.limit ?? 6;
  const reranker = opts.reranker ?? null;
  const overFetch = reranker ? Math.max(limit * 4, 20) : limit;
  const innerOpts = { collection: opts.collection, limit: overFetch };

  let hits: SearchHit[];
  if (mode === "fts") {
    hits = store.ftsSearch(query, innerOpts);
  } else {
    const provider = await getEmbeddingProvider();
    if (!store.hasEmbeddings() || !provider) {
      if (mode === "vector") {
        throw new Error(
          "Semantic search needs embeddings + an embedding provider (set OPENAI_API_KEY and run `embed`).",
        );
      }
      hits = store.ftsSearch(query, innerOpts);
    } else {
      const [qvec] = await provider.embed([query]);
      hits =
        mode === "vector"
          ? store.vectorSearch(qvec, innerOpts)
          : store.hybridSearch(query, qvec, innerOpts);
    }
  }

  if (reranker && hits.length > 0) {
    const scores = await reranker.rerank(
      query,
      hits.map((h) => h.text),
    );
    hits = hits
      .map((h, i) => ({ ...h, rerank_score: scores[i] }))
      .sort((a, b) => (b.rerank_score ?? 0) - (a.rerank_score ?? 0));
  }
  return hits.slice(0, limit);
}

async function runDoctor(dbPath: string): Promise<void> {
  const lines: string[] = [];
  const ok = (s: string) => lines.push(`  [OK]      ${s}`);
  const warn = (s: string) => lines.push(`  [WARN]    ${s}`);
  const miss = (s: string) => lines.push(`  [MISSING] ${s}`);
  const info = (s: string) => lines.push(`            ${s}`);

  lines.push("Runtime");
  ok(`Node ${process.version}`);

  lines.push("");
  lines.push("Database");
  if (existsSync(dbPath)) {
    const stat = statSync(dbPath);
    ok(`${dbPath} (${(stat.size / 1024).toFixed(1)} KB)`);
    try {
      const store = new Store(dbPath);
      try {
        const collections = store.listCollections();
        const docs = collections.reduce((n, c) => n + c.doc_count, 0);
        info(
          `collections=${collections.length}, docs=${docs}, embeddings_dim=${store.embeddingDim() ?? "—"}, embedding_model=${store.embeddingModel() ?? "—"}`,
        );
      } finally {
        store.close();
      }
    } catch (e) {
      warn(`could not open DB: ${e instanceof Error ? e.message : e}`);
    }
  } else {
    warn(`${dbPath} does not exist yet (run \`pageboy add <url>\` to create it)`);
  }

  lines.push("");
  lines.push("Search backends");
  ok("FTS5 (built into SQLite)");
  try {
    const probe = new Store(dbPath);
    try {
      if (probe.hasEmbeddings() || probe.embeddingModel() !== null) {
        ok("sqlite-vec extension loaded");
      } else if (probe.embeddingDim() === null) {
        info("sqlite-vec extension loaded (no embeddings indexed yet)");
      }
    } finally {
      probe.close();
    }
  } catch {
    warn("sqlite-vec extension failed to load — semantic search disabled");
  }

  lines.push("");
  lines.push("Embedding providers (used in this priority order)");
  if (process.env.OPENAI_API_KEY) {
    ok(
      `OpenAI — base ${process.env.OPENAI_BASE_URL ?? "https://api.openai.com/v1"}, model ${process.env.PAGEBOY_EMBED_MODEL ?? "text-embedding-3-small"}`,
    );
  } else {
    miss("OpenAI — OPENAI_API_KEY not set");
  }

  const ollamaHost =
    process.env.OLLAMA_HOST ??
    process.env.OLLAMA_URL ??
    "http://127.0.0.1:11434";
  const ollamaReachable = await probeOllama(ollamaHost);
  if (ollamaReachable) {
    ok(`Ollama — reachable at ${ollamaHost}`);
  } else {
    miss(`Ollama — not reachable at ${ollamaHost}`);
  }

  const transformersInstalled = await transformersJsAvailable();
  if (transformersInstalled) {
    ok(
      `Transformers.js — installed (model ${process.env.PAGEBOY_EMBED_MODEL ?? "Xenova/all-MiniLM-L6-v2"})`,
    );
  } else {
    miss(
      "Transformers.js — @huggingface/transformers not installed (npm install @huggingface/transformers)",
    );
  }

  const provider = await getEmbeddingProvider();
  if (provider) {
    info(`→ active provider: ${provider.name} (${provider.model}, dim=${provider.dim})`);
  } else {
    info("→ no embedding provider available; search will use FTS5 only");
  }

  lines.push("");
  lines.push("Reranker");
  const rerankEnabled =
    process.env.PAGEBOY_RERANK === "1" ||
    process.env.PAGEBOY_RERANK?.toLowerCase() === "true";
  if (rerankEnabled) {
    if (transformersInstalled) {
      ok(
        `enabled — model ${process.env.PAGEBOY_RERANK_MODEL ?? "Xenova/ms-marco-MiniLM-L-6-v2"}`,
      );
    } else {
      warn(
        "PAGEBOY_RERANK is set but @huggingface/transformers is not installed",
      );
    }
  } else {
    info(
      "disabled by default — pass --rerank to a search, or set PAGEBOY_RERANK=1",
    );
  }

  console.log(lines.join("\n"));
}

function printHits(hits: SearchHit[], mode: SearchMode) {
  if (hits.length === 0) {
    console.log(`(no matches, mode=${mode})`);
    return;
  }
  console.log(`mode=${mode}, hits=${hits.length}\n`);
  for (const [i, h] of hits.entries()) {
    const baseTag =
      h.source === "fts"
        ? `bm25=${h.fts_score?.toFixed(2)}`
        : h.source === "vector"
          ? `dist=${h.vec_distance?.toFixed(3)}`
          : `rrf=${h.fused_score.toFixed(4)}`;
    const tag =
      h.rerank_score !== undefined
        ? `rerank=${h.rerank_score.toFixed(3)} ${baseTag}`
        : baseTag;
    const section = h.section_path ? ` [${h.section_path}]` : "";
    console.log(
      `[${i + 1}] doc #${h.doc_id} chunk ${h.idx} [${h.collection}] (${tag}) — ${h.doc_title}${section}`,
    );
    console.log(`    ${h.doc_url}`);
    console.log(`    ${h.text.slice(0, 260).replace(/\s+/g, " ")}…`);
    console.log();
  }
}
