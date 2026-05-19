import {
  fetchArticle,
  ingestFetched,
  normalizeUrl,
  type IngestResult,
} from "./ingest.js";
import { Store, DEFAULT_COLLECTION } from "./store.js";
import type { EmbeddingProvider } from "./embeddings.js";

export interface CrawlOptions {
  collection?: string;
  embedder?: EmbeddingProvider | null;
  maxDepth?: number;
  maxPages?: number;
  sameOrigin?: boolean;
  delayMs?: number;
  include?: RegExp;
  exclude?: RegExp;
  onPage?: (event: CrawlEvent) => void;
}

export type CrawlEvent =
  | { kind: "indexed"; url: string; depth: number; result: IngestResult }
  | { kind: "unchanged"; url: string; depth: number; result: IngestResult }
  | { kind: "failed"; url: string; depth: number; error: string }
  | { kind: "skipped"; url: string; depth: number; reason: string };

export interface CrawlSummary {
  visited: number;
  indexed: number;
  unchanged: number;
  failed: number;
  skipped: number;
}

export async function crawl(
  rootUrl: string,
  store: Store,
  opts: CrawlOptions = {},
): Promise<CrawlSummary> {
  const collection = opts.collection ?? DEFAULT_COLLECTION;
  const maxDepth = opts.maxDepth ?? 2;
  const maxPages = opts.maxPages ?? 50;
  const sameOrigin = opts.sameOrigin ?? true;
  const delayMs = opts.delayMs ?? 250;
  const onPage = opts.onPage ?? (() => {});

  const normalizedRoot = normalizeUrl(rootUrl, rootUrl);
  if (!normalizedRoot) {
    throw new Error(`Invalid URL: ${rootUrl}`);
  }
  const allowedOrigins = new Set<string>([new URL(normalizedRoot).origin]);

  const queue: { url: string; depth: number }[] = [
    { url: normalizedRoot, depth: 0 },
  ];
  const seen = new Set<string>([normalizedRoot]);
  const summary: CrawlSummary = {
    visited: 0,
    indexed: 0,
    unchanged: 0,
    failed: 0,
    skipped: 0,
  };

  while (queue.length > 0 && summary.visited < maxPages) {
    const { url, depth } = queue.shift()!;

    if (opts.include && !opts.include.test(url)) {
      summary.skipped++;
      onPage({ kind: "skipped", url, depth, reason: "include filter" });
      continue;
    }
    if (opts.exclude && opts.exclude.test(url)) {
      summary.skipped++;
      onPage({ kind: "skipped", url, depth, reason: "exclude filter" });
      continue;
    }

    summary.visited++;
    if (summary.visited > 1 && delayMs > 0) {
      await sleep(delayMs);
    }

    try {
      const fetched = await fetchArticle(url);
      try {
        allowedOrigins.add(new URL(fetched.url).origin);
      } catch {
        // ignore
      }
      const result = await ingestFetched(fetched, store, {
        collection,
        embedder: opts.embedder,
      });
      if (result.unchanged) {
        summary.unchanged++;
        onPage({ kind: "unchanged", url, depth, result });
      } else {
        summary.indexed++;
        onPage({ kind: "indexed", url, depth, result });
      }

      if (depth < maxDepth) {
        for (const link of fetched.links) {
          if (seen.has(link)) continue;
          if (sameOrigin) {
            try {
              if (!allowedOrigins.has(new URL(link).origin)) continue;
            } catch {
              continue;
            }
          }
          seen.add(link);
          queue.push({ url: link, depth: depth + 1 });
        }
      }
    } catch (e) {
      summary.failed++;
      onPage({
        kind: "failed",
        url,
        depth,
        error: e instanceof Error ? e.message : String(e),
      });
    }
  }

  return summary;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
