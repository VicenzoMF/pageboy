import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { getEmbeddingProvider } from "./embeddings.js";
import { ingestUrl } from "./ingest.js";
import { Store, type SearchMode } from "./store.js";

export async function startMcpServer(store: Store): Promise<void> {
  const semanticAvailable = store.hasEmbeddings();
  const modeNote = semanticAvailable
    ? "Hybrid (FTS5 + semantic) is the default."
    : "Only FTS5 is available. To enable semantic search: set OPENAI_API_KEY and run `pageboy embed`.";

  const server = new McpServer(
    { name: "pageboy", version: "0.2.0" },
    {
      instructions:
        `Local docs indexed from web articles, grouped into collections. ` +
        `Use list_collections() to discover bases, list_docs(collection?) to browse, ` +
        `search_docs(query, collection?) to find passages, and get_doc(id) to read full text. ` +
        modeNote,
    },
  );

  server.registerTool(
    "list_collections",
    {
      title: "List collections",
      description:
        "Return every collection in this store with its document count.",
      inputSchema: {},
      annotations: { readOnlyHint: true, idempotentHint: true },
    },
    async () => {
      const cs = store.listCollections();
      if (cs.length === 0) {
        return { content: [{ type: "text", text: "No collections." }] };
      }
      const lines = cs.map((c) => `${c.collection}  (${c.doc_count} docs)`);
      return { content: [{ type: "text", text: lines.join("\n") }] };
    },
  );

  server.registerTool(
    "list_docs",
    {
      title: "List indexed documents",
      description:
        "List indexed articles, optionally filtered by collection.",
      inputSchema: {
        collection: z
          .string()
          .min(1)
          .optional()
          .describe("Filter by collection name"),
      },
      annotations: { readOnlyHint: true, idempotentHint: true },
    },
    async ({ collection }) => {
      const docs = store.listDocs(collection);
      if (docs.length === 0) {
        return {
          content: [
            {
              type: "text",
              text: collection
                ? `No documents in collection "${collection}".`
                : "No documents indexed.",
            },
          ],
        };
      }
      const lines = docs.map(
        (d) =>
          `#${d.id} [${d.collection}] — ${d.title} (${d.chunk_count} chunks)\n  ${d.url}`,
      );
      return { content: [{ type: "text", text: lines.join("\n\n") }] };
    },
  );

  server.registerTool(
    "search_docs",
    {
      title: "Search indexed documents",
      description:
        `Search article chunks. Default mode is "hybrid" (FTS5 + semantic RRF) when embeddings exist, else "fts". ` +
        `Returns top matches with title, URL, and the matching passage.`,
      inputSchema: {
        query: z.string().min(1).describe("Natural-language search query"),
        collection: z
          .string()
          .min(1)
          .optional()
          .describe("Restrict search to a single collection"),
        limit: z
          .number()
          .int()
          .min(1)
          .max(20)
          .optional()
          .describe("Max results (default 6)"),
        mode: z
          .enum(["fts", "vector", "hybrid"])
          .optional()
          .describe("Force search mode. Default: hybrid if embeddings, else fts."),
      },
      annotations: { readOnlyHint: true, idempotentHint: true },
    },
    async ({ query, collection, limit, mode }) => {
      const effectiveMode: SearchMode =
        mode ?? (store.hasEmbeddings() ? "hybrid" : "fts");
      const opts = { collection, limit: limit ?? 6 };

      let hits;
      if (effectiveMode === "fts") {
        hits = store.ftsSearch(query, opts);
      } else {
        const provider = await getEmbeddingProvider();
        if (!store.hasEmbeddings() || !provider) {
          return {
            content: [
              {
                type: "text",
                text: `Semantic search unavailable (no embeddings indexed or no provider). Use mode="fts" or run \`pageboy embed\` first.`,
              },
            ],
            isError: true,
          };
        }
        const [qvec] = await provider.embed([query]);
        hits =
          effectiveMode === "vector"
            ? store.vectorSearch(qvec, opts)
            : store.hybridSearch(query, qvec, opts);
      }

      if (hits.length === 0) {
        return {
          content: [
            { type: "text", text: `No matches (mode=${effectiveMode}) for: ${query}` },
          ],
        };
      }
      const blocks = hits.map(
        (h, i) =>
          `[${i + 1}] doc #${h.doc_id} chunk ${h.idx} [${h.collection}] — ${h.doc_title}\n` +
          `    ${h.doc_url}\n\n${h.text}`,
      );
      return {
        content: [
          {
            type: "text",
            text: `mode=${effectiveMode}\n\n${blocks.join("\n\n---\n\n")}`,
          },
        ],
      };
    },
  );

  server.registerTool(
    "get_doc",
    {
      title: "Get full document text",
      description:
        "Return every chunk of an indexed article in order. Use list_docs first to get the id.",
      inputSchema: {
        id: z.number().int().positive().describe("Document id from list_docs"),
      },
      annotations: { readOnlyHint: true, idempotentHint: true },
    },
    async ({ id }) => {
      const result = store.getDoc(id);
      if (!result) {
        return {
          content: [{ type: "text", text: `No document with id ${id}.` }],
          isError: true,
        };
      }
      const { doc, chunks } = result;
      const header =
        `# ${doc.title}\n` +
        `collection: ${doc.collection}\n` +
        (doc.byline ? `by ${doc.byline}\n` : "") +
        `${doc.url}\n`;
      const body = chunks.map((c) => c.text).join("\n\n");
      return { content: [{ type: "text", text: `${header}\n${body}` }] };
    },
  );

  server.registerTool(
    "refresh_doc",
    {
      title: "Refresh a document",
      description:
        "Re-fetch a document's URL and re-index. Reports whether content changed.",
      inputSchema: {
        id: z.number().int().positive().describe("Document id to refresh"),
      },
      annotations: { readOnlyHint: false, idempotentHint: true },
    },
    async ({ id }) => {
      const got = store.getDoc(id);
      if (!got) {
        return {
          content: [{ type: "text", text: `No document with id ${id}.` }],
          isError: true,
        };
      }
      const embedder = store.hasEmbeddings() ? await getEmbeddingProvider() : null;
      try {
        const r = await ingestUrl(got.doc.url, store, {
          collection: got.doc.collection,
          embedder,
        });
        const status = r.unchanged ? "unchanged" : "refreshed";
        return {
          content: [
            {
              type: "text",
              text: `${status} #${id} [${got.doc.collection}]: ${r.title} (${r.chunkCount} chunks)`,
            },
          ],
        };
      } catch (e) {
        return {
          content: [
            {
              type: "text",
              text: `Refresh failed: ${e instanceof Error ? e.message : String(e)}`,
            },
          ],
          isError: true,
        };
      }
    },
  );

  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(
    `pageboy MCP server running on stdio (semantic=${semanticAvailable})`,
  );

  const shutdown = async () => {
    await server.close();
    store.close();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}
