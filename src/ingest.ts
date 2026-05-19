import { Readability } from "@mozilla/readability";
import { JSDOM } from "jsdom";
import { embedInBatches, type EmbeddingProvider } from "./embeddings.js";
import {
  Store,
  DEFAULT_COLLECTION,
  type ChunkInput,
  type UpsertResult,
} from "./store.js";

export interface IngestOptions {
  collection?: string;
  embedder?: EmbeddingProvider | null;
}

export interface IngestResult extends UpsertResult {
  title: string;
  embedded: number;
}

export interface FetchedArticle {
  url: string;
  html: string;
  title: string;
  byline: string | null;
  site_name: string | null;
  content_html: string | null;
  text_content: string;
  links: string[];
}

const TARGET_CHARS = 1400;
const MIN_CHARS = 400;
const HEADING_TAGS = new Set(["h1", "h2", "h3", "h4", "h5", "h6"]);
const TEXT_BLOCK_TAGS = new Set([
  "p",
  "li",
  "blockquote",
  "pre",
  "dd",
  "dt",
  "figcaption",
  "summary",
  "td",
  "th",
]);
const CONTAINER_TAGS = new Set([
  "div",
  "section",
  "article",
  "main",
  "aside",
  "header",
  "footer",
  "ul",
  "ol",
  "dl",
  "table",
  "tbody",
  "thead",
  "tr",
  "figure",
  "details",
]);

export async function fetchArticle(url: string): Promise<FetchedArticle> {
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
  const finalUrl = res.url || url;

  const dom = new JSDOM(html, { url: finalUrl });
  const links = extractLinks(dom.window.document, finalUrl);
  const article = new Readability(dom.window.document).parse();
  if (!article || !article.textContent?.trim()) {
    throw new Error("Could not extract readable content from page");
  }

  return {
    url: finalUrl,
    html,
    title: article.title?.trim() || finalUrl,
    byline: article.byline?.trim() || null,
    site_name: article.siteName?.trim() || null,
    content_html: article.content ?? null,
    text_content: article.textContent,
    links,
  };
}

function extractLinks(doc: Document, baseUrl: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const anchors = doc.querySelectorAll("a[href]");
  for (const a of Array.from(anchors)) {
    const href = a.getAttribute("href");
    if (!href) continue;
    const normalized = normalizeUrl(href, baseUrl);
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    out.push(normalized);
  }
  return out;
}

const SKIP_EXTENSIONS = new Set([
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".webp",
  ".svg",
  ".ico",
  ".pdf",
  ".zip",
  ".tar",
  ".gz",
  ".tgz",
  ".rar",
  ".7z",
  ".mp3",
  ".mp4",
  ".webm",
  ".mov",
  ".avi",
  ".woff",
  ".woff2",
  ".ttf",
  ".eot",
  ".css",
  ".js",
  ".json",
  ".xml",
  ".rss",
  ".atom",
  ".dmg",
  ".exe",
]);

export function normalizeUrl(href: string, baseUrl: string): string | null {
  let u: URL;
  try {
    u = new URL(href, baseUrl);
  } catch {
    return null;
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return null;
  u.hash = "";
  u.hostname = u.hostname.toLowerCase();
  const path = u.pathname;
  const dot = path.lastIndexOf(".");
  if (dot > -1) {
    const ext = path.slice(dot).toLowerCase();
    if (SKIP_EXTENSIONS.has(ext)) return null;
  }
  return u.toString();
}

export async function ingestUrl(
  url: string,
  store: Store,
  opts: IngestOptions = {},
): Promise<IngestResult> {
  const collection = opts.collection ?? DEFAULT_COLLECTION;
  const fetched = await fetchArticle(url);
  return ingestFetched(fetched, store, { ...opts, collection });
}

export async function ingestFetched(
  fetched: FetchedArticle,
  store: Store,
  opts: IngestOptions = {},
): Promise<IngestResult> {
  const collection = opts.collection ?? DEFAULT_COLLECTION;

  const chunks = buildChunks(fetched);
  if (chunks.length === 0) {
    throw new Error("No chunks produced after extraction");
  }

  const upserted = store.upsertDoc({
    url: fetched.url,
    title: fetched.title,
    byline: fetched.byline,
    site_name: fetched.site_name,
    collection,
    chunks,
  });

  let embedded = 0;
  if (opts.embedder && !upserted.unchanged) {
    embedded = await embedDoc(store, opts.embedder, upserted.docId);
  }

  return { ...upserted, title: fetched.title, embedded };
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

// ---------- chunking ----------

export function buildChunks(fetched: FetchedArticle): ChunkInput[] {
  const sections = fetched.content_html
    ? walkSections(fetched.content_html, fetched.title)
    : [
        {
          path: [fetched.title],
          text: normalizeWhitespace(fetched.text_content),
        },
      ];

  const out: ChunkInput[] = [];
  for (const sec of sections) {
    const pathStr = sec.path.filter(Boolean).join(" > ") || null;
    for (const piece of chunkText(sec.text)) {
      const text = pathStr ? `${pathStr}\n\n${piece}` : piece;
      out.push({ text, section_path: pathStr });
    }
  }
  return out;
}

interface Section {
  path: string[];
  text: string;
}

export function walkSections(contentHtml: string, docTitle: string): Section[] {
  const dom = new JSDOM(`<!DOCTYPE html><html><body>${contentHtml}</body></html>`);
  const body = dom.window.document.body;

  const sections: Section[] = [];
  let path: string[] = docTitle ? [docTitle] : [];
  let buffer: string[] = [];

  const flush = () => {
    const text = normalizeWhitespace(buffer.join("\n\n"));
    if (text) sections.push({ path: [...path], text });
    buffer = [];
  };

  const walk = (node: Element) => {
    for (const child of Array.from(node.children) as Element[]) {
      const tag = child.tagName.toLowerCase();
      if (HEADING_TAGS.has(tag)) {
        flush();
        const level = parseInt(tag.slice(1), 10);
        const heading = (child.textContent ?? "").trim();
        const start = docTitle ? 1 : 0;
        path = path.slice(0, start + level - 1);
        path[start + level - 1] = heading;
        continue;
      }
      if (TEXT_BLOCK_TAGS.has(tag)) {
        const text = (child.textContent ?? "").trim();
        if (text) buffer.push(text);
        continue;
      }
      if (CONTAINER_TAGS.has(tag)) {
        walk(child);
        continue;
      }
      const text = (child.textContent ?? "").trim();
      if (text) buffer.push(text);
    }
  };

  walk(body);
  flush();

  if (sections.length === 0) {
    const text = normalizeWhitespace(body.textContent ?? "");
    if (text) sections.push({ path, text });
  }
  return sections;
}

function normalizeWhitespace(s: string): string {
  return s
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function chunkText(text: string): string[] {
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
