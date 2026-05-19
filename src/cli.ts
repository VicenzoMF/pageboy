#!/usr/bin/env node
import { Command } from "commander";
import { resolve } from "node:path";
import { DEFAULT_COLLECTION, Store, type SearchHit, type SearchMode } from "./store.js";
import { embedPending, ingestUrl } from "./ingest.js";
import { getEmbeddingProvider } from "./embeddings.js";
import { startMcpServer } from "./mcp-server.js";

const DEFAULT_DB = resolve(
  process.env.PAGEBOY_DB ?? "./data/pageboy.db",
);

const program = new Command();
program
  .name("pageboy")
  .description("Turn web articles into a queryable MCP server")
  .option("--db <path>", "SQLite database path (env: PAGEBOY_DB)", DEFAULT_DB);

program
  .command("add <url>")
  .description("Fetch a URL, extract the article, and index it")
  .option("-c, --collection <name>", "Target collection", DEFAULT_COLLECTION)
  .option("--no-embed", "Skip embeddings even if provider is configured")
  .action(async (url: string, opts, cmd) => {
    const { db } = cmd.optsWithGlobals();
    const store = new Store(db);
    try {
      const embedder = await resolveEmbedder(opts);
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
  .action(async (queryParts: string[], opts, cmd) => {
    const { db } = cmd.optsWithGlobals();
    const store = new Store(db);
    try {
      const query = queryParts.join(" ");
      const limit = Number(opts.limit);
      const mode = (opts.mode as SearchMode | undefined) ?? autoMode(store);

      const hits = await runSearch(store, query, mode, {
        collection: opts.collection,
        limit,
      });
      printHits(hits, mode);
    } finally {
      store.close();
    }
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
  opts: { collection?: string; limit?: number },
): Promise<SearchHit[]> {
  if (mode === "fts") return store.ftsSearch(query, opts);

  const provider = await getEmbeddingProvider();
  if (!store.hasEmbeddings() || !provider) {
    if (mode === "vector") {
      throw new Error(
        "Semantic search needs embeddings + an embedding provider (set OPENAI_API_KEY and run `embed`).",
      );
    }
    return store.ftsSearch(query, opts);
  }
  const [qvec] = await provider.embed([query]);
  if (mode === "vector") return store.vectorSearch(qvec, opts);
  return store.hybridSearch(query, qvec, opts);
}

function printHits(hits: SearchHit[], mode: SearchMode) {
  if (hits.length === 0) {
    console.log(`(no matches, mode=${mode})`);
    return;
  }
  console.log(`mode=${mode}, hits=${hits.length}\n`);
  for (const [i, h] of hits.entries()) {
    const tag =
      h.source === "fts"
        ? `bm25=${h.fts_score?.toFixed(2)}`
        : h.source === "vector"
          ? `dist=${h.vec_distance?.toFixed(3)}`
          : `rrf=${h.fused_score.toFixed(4)}`;
    console.log(
      `[${i + 1}] doc #${h.doc_id} chunk ${h.idx} [${h.collection}] (${tag}) — ${h.doc_title}`,
    );
    console.log(`    ${h.doc_url}`);
    console.log(`    ${h.text.slice(0, 260).replace(/\s+/g, " ")}…`);
    console.log();
  }
}
