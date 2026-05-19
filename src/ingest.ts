import { Readability } from "@mozilla/readability";
import { JSDOM } from "jsdom";
import { embedInBatches, type EmbeddingProvider } from "./embeddings.js";
import { Store, DEFAULT_COLLECTION, type UpsertResult } from "./store.js";

export interface IngestOptions {
  collection?: string;
  embedder?: EmbeddingProvider | null;
}

export interface IngestResult extends UpsertResult {
  title: string;
  embedded: number;
}

const TARGET_CHARS = 1400;
const MIN_CHARS = 400;

export async function ingestUrl(
  url: string,
  store: Store,
  opts: IngestOptions = {},
): Promise<IngestResult> {
  const collection = opts.collection ?? DEFAULT_COLLECTION;

  const res = await fetch(url, {
    headers: {
      "user-agent": "pageboy/0.2",
      accept: "text/html,application/xhtml+xml",
    },
    redirect: "follow",
  });
  if (!res.ok) {
    throw new Error(`Fetch failed: ${res.status} ${res.statusText}`);
  }
  const html = await res.text();

  const dom = new JSDOM(html, { url });
  const article = new Readability(dom.window.document).parse();
  if (!article || !article.textContent?.trim()) {
    throw new Error("Could not extract readable content from page");
  }

  const text = normalizeWhitespace(article.textContent);
  const chunks = chunkText(text);
  if (chunks.length === 0) {
    throw new Error("No chunks produced after extraction");
  }

  const title = article.title?.trim() || url;
  const upserted = store.upsertDoc({
    url,
    title,
    byline: article.byline?.trim() || null,
    site_name: article.siteName?.trim() || null,
    collection,
    chunks,
  });

  let embedded = 0;
  if (opts.embedder && !upserted.unchanged) {
    embedded = await embedDoc(store, opts.embedder, upserted.docId);
  }

  return { ...upserted, title, embedded };
}

export async function embedDoc(
  store: Store,
  provider: EmbeddingProvider,
  docId: number,
): Promise<number> {
  store.initEmbeddings(provider.dim, provider.model);
  const result = store.getDoc(docId);
  if (!result) throw new Error(`No document with id ${docId}`);

  const pending = store
    .chunksWithoutEmbeddings()
    .filter((c) => c.doc_id === docId);
  if (pending.length === 0) return 0;

  const vectors = await embedInBatches(
    provider,
    pending.map((c) => c.text),
  );
  store.storeEmbeddings(
    pending.map((c) => c.id),
    vectors,
  );
  return pending.length;
}

export async function embedPending(
  store: Store,
  provider: EmbeddingProvider,
  opts: { collection?: string } = {},
): Promise<number> {
  store.initEmbeddings(provider.dim, provider.model);
  let total = 0;
  while (true) {
    const batch = store.chunksWithoutEmbeddings(opts.collection, 200);
    if (batch.length === 0) break;
    const vectors = await embedInBatches(
      provider,
      batch.map((c) => c.text),
    );
    store.storeEmbeddings(
      batch.map((c) => c.id),
      vectors,
    );
    total += batch.length;
  }
  return total;
}

function normalizeWhitespace(s: string): string {
  return s
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function chunkText(text: string): string[] {
  const paragraphs = text
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .filter(Boolean);

  const chunks: string[] = [];
  let buf = "";

  const flush = () => {
    const t = buf.trim();
    if (t) chunks.push(t);
    buf = "";
  };

  for (const para of paragraphs) {
    if (para.length > TARGET_CHARS) {
      flush();
      for (const piece of splitLong(para)) chunks.push(piece);
      continue;
    }
    if (buf.length + para.length + 2 > TARGET_CHARS && buf.length >= MIN_CHARS) {
      flush();
    }
    buf = buf ? `${buf}\n\n${para}` : para;
  }
  flush();
  return chunks;
}

function splitLong(text: string): string[] {
  const sentences = text.split(/(?<=[.!?])\s+(?=[A-Z])/);
  const out: string[] = [];
  let buf = "";
  for (const s of sentences) {
    if (buf.length + s.length + 1 > TARGET_CHARS && buf.length >= MIN_CHARS) {
      out.push(buf.trim());
      buf = s;
    } else {
      buf = buf ? `${buf} ${s}` : s;
    }
  }
  if (buf.trim()) out.push(buf.trim());
  return out;
}
