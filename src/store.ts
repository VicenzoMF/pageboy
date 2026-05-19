import Database from "better-sqlite3";
import * as sqliteVec from "sqlite-vec";
import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

export const DEFAULT_COLLECTION = "default";

export interface Doc {
  id: number;
  url: string;
  title: string;
  byline: string | null;
  site_name: string | null;
  collection: string;
  content_hash: string | null;
  fetched_at: string;
  chunk_count: number;
}

export interface Chunk {
  id: number;
  doc_id: number;
  idx: number;
  text: string;
  section_path: string | null;
}

export interface ChunkInput {
  text: string;
  section_path: string | null;
}

export interface SearchHit {
  chunk_id: number;
  doc_id: number;
  doc_title: string;
  doc_url: string;
  collection: string;
  idx: number;
  text: string;
  section_path: string | null;
  fts_score: number | null;
  vec_distance: number | null;
  fused_score: number;
  rerank_score?: number;
  source: "fts" | "vector" | "hybrid";
}

export interface UpsertResult {
  docId: number;
  chunkCount: number;
  unchanged: boolean;
}

export type SearchMode = "fts" | "vector" | "hybrid";

export class Store {
  readonly db: Database.Database;
  private vecLoaded = false;
  private vecDim: number | null = null;

  constructor(path: string) {
    mkdirSync(dirname(path), { recursive: true });
    this.db = new Database(path);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("synchronous = NORMAL");
    this.db.pragma("foreign_keys = ON");

    try {
      sqliteVec.load(this.db);
      this.vecLoaded = true;
    } catch (e) {
      console.error(
        "warning: sqlite-vec not loaded; semantic search disabled.",
        e instanceof Error ? e.message : e,
      );
    }

    this.migrate();
    const dim = this.getMeta("embedding_dim");
    if (dim && this.vecLoaded) {
      this.vecDim = parseInt(dim, 10);
      this.ensureVecTable();
    }
  }

  // ---------- migrations ----------

  private migrate() {
    const current = this.db.pragma("user_version", { simple: true }) as number;

    if (current < 1) {
      this.migrateToV1();
      this.db.pragma("user_version = 1");
    }
    if (current < 2) {
      this.migrateToV2();
      this.db.pragma("user_version = 2");
    }
    if (current < 3) {
      this.migrateToV3();
      this.db.pragma("user_version = 3");
    }
  }

  private migrateToV1() {
    const tables = this.db
      .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='docs'`)
      .get() as { name: string } | undefined;

    if (!tables) {
      this.db.exec(`
        CREATE TABLE docs (
          id           INTEGER PRIMARY KEY,
          url          TEXT NOT NULL,
          title        TEXT NOT NULL,
          byline       TEXT,
          site_name    TEXT,
          collection   TEXT NOT NULL DEFAULT '${DEFAULT_COLLECTION}',
          content_hash TEXT,
          fetched_at   TEXT NOT NULL,
          UNIQUE(url, collection)
        );

        CREATE TABLE chunks (
          id     INTEGER PRIMARY KEY,
          doc_id INTEGER NOT NULL REFERENCES docs(id) ON DELETE CASCADE,
          idx    INTEGER NOT NULL,
          text   TEXT NOT NULL
        );
        CREATE INDEX idx_chunks_doc ON chunks(doc_id);

        CREATE VIRTUAL TABLE chunks_fts USING fts5(
          text,
          content='chunks',
          content_rowid='id',
          tokenize='unicode61 remove_diacritics 2'
        );

        CREATE TRIGGER chunks_ai AFTER INSERT ON chunks BEGIN
          INSERT INTO chunks_fts(rowid, text) VALUES (new.id, new.text);
        END;
        CREATE TRIGGER chunks_ad AFTER DELETE ON chunks BEGIN
          INSERT INTO chunks_fts(chunks_fts, rowid, text) VALUES('delete', old.id, old.text);
        END;
        CREATE TRIGGER chunks_au AFTER UPDATE ON chunks BEGIN
          INSERT INTO chunks_fts(chunks_fts, rowid, text) VALUES('delete', old.id, old.text);
          INSERT INTO chunks_fts(rowid, text) VALUES (new.id, new.text);
        END;
      `);
      return;
    }

    const cols = this.db.prepare(`PRAGMA table_info(docs)`).all() as {
      name: string;
    }[];
    const hasCollection = cols.some((c) => c.name === "collection");
    if (hasCollection) return;

    this.db.exec(`
      PRAGMA foreign_keys = OFF;
      CREATE TABLE docs_new (
        id           INTEGER PRIMARY KEY,
        url          TEXT NOT NULL,
        title        TEXT NOT NULL,
        byline       TEXT,
        site_name    TEXT,
        collection   TEXT NOT NULL DEFAULT '${DEFAULT_COLLECTION}',
        content_hash TEXT,
        fetched_at   TEXT NOT NULL,
        UNIQUE(url, collection)
      );
      INSERT INTO docs_new (id, url, title, byline, site_name, fetched_at)
        SELECT id, url, title, byline, site_name, fetched_at FROM docs;
      DROP TABLE docs;
      ALTER TABLE docs_new RENAME TO docs;
      PRAGMA foreign_keys = ON;
    `);
  }

  private migrateToV2() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS meta (
        key   TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
    `);
  }

  private migrateToV3() {
    const cols = this.db.prepare(`PRAGMA table_info(chunks)`).all() as {
      name: string;
    }[];
    if (!cols.some((c) => c.name === "section_path")) {
      this.db.exec(`ALTER TABLE chunks ADD COLUMN section_path TEXT`);
    }
  }

  // ---------- meta ----------

  private getMeta(key: string): string | null {
    const row = this.db
      .prepare(`SELECT value FROM meta WHERE key = ?`)
      .get(key) as { value: string } | undefined;
    return row?.value ?? null;
  }

  private setMeta(key: string, value: string) {
    this.db
      .prepare(
        `INSERT INTO meta(key, value) VALUES(?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      )
      .run(key, value);
  }

  // ---------- vec setup ----------

  private ensureVecTable() {
    if (!this.vecLoaded || !this.vecDim) return;
    this.db.exec(
      `CREATE VIRTUAL TABLE IF NOT EXISTS vec_chunks USING vec0(
         chunk_id INTEGER PRIMARY KEY,
         embedding FLOAT[${this.vecDim}]
       )`,
    );
  }

  initEmbeddings(dim: number, model: string) {
    if (!this.vecLoaded) {
      throw new Error("sqlite-vec extension is not loaded");
    }
    if (this.vecDim && this.vecDim !== dim) {
      throw new Error(
        `Embedding dim mismatch: store uses ${this.vecDim}, got ${dim}. Use a different DB or wipe vec_chunks/meta.`,
      );
    }
    if (!this.vecDim) {
      this.vecDim = dim;
      this.setMeta("embedding_dim", String(dim));
      this.setMeta("embedding_model", model);
      this.ensureVecTable();
    }
  }

  hasEmbeddings(): boolean {
    return this.vecLoaded && this.vecDim !== null;
  }

  embeddingModel(): string | null {
    return this.getMeta("embedding_model");
  }

  embeddingDim(): number | null {
    return this.vecDim;
  }

  // ---------- writes ----------

  upsertDoc(input: {
    url: string;
    title: string;
    byline: string | null;
    site_name: string | null;
    collection?: string;
    chunks: ChunkInput[];
  }): UpsertResult {
    const collection = input.collection ?? DEFAULT_COLLECTION;
    const fetched_at = new Date().toISOString();
    const content_hash = hashChunks(input.chunks);

    const existing = this.db
      .prepare(`SELECT id, content_hash FROM docs WHERE url = ? AND collection = ?`)
      .get(input.url, collection) as
      | { id: number; content_hash: string | null }
      | undefined;

    if (existing && existing.content_hash === content_hash) {
      this.db
        .prepare(`UPDATE docs SET fetched_at = ? WHERE id = ?`)
        .run(fetched_at, existing.id);
      const chunkCount = this.db
        .prepare(`SELECT COUNT(*) AS n FROM chunks WHERE doc_id = ?`)
        .get(existing.id) as { n: number };
      return { docId: existing.id, chunkCount: chunkCount.n, unchanged: true };
    }

    const insertChunk = this.db.prepare(
      `INSERT INTO chunks (doc_id, idx, text, section_path) VALUES (?, ?, ?, ?)`,
    );

    const tx = this.db.transaction(() => {
      let docId: number;
      if (existing) {
        this.deleteChunksForDoc(existing.id);
        this.db
          .prepare(
            `UPDATE docs SET title = ?, byline = ?, site_name = ?,
             content_hash = ?, fetched_at = ? WHERE id = ?`,
          )
          .run(
            input.title,
            input.byline,
            input.site_name,
            content_hash,
            fetched_at,
            existing.id,
          );
        docId = existing.id;
      } else {
        const info = this.db
          .prepare(
            `INSERT INTO docs (url, title, byline, site_name, collection, content_hash, fetched_at)
             VALUES (?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            input.url,
            input.title,
            input.byline,
            input.site_name,
            collection,
            content_hash,
            fetched_at,
          );
        docId = Number(info.lastInsertRowid);
      }
      input.chunks.forEach((c, i) =>
        insertChunk.run(docId, i, c.text, c.section_path),
      );
      return docId;
    });

    const docId = tx();
    return { docId, chunkCount: input.chunks.length, unchanged: false };
  }

  private deleteChunksForDoc(docId: number) {
    if (this.vecLoaded && this.vecDim) {
      this.db
        .prepare(
          `DELETE FROM vec_chunks
           WHERE chunk_id IN (SELECT id FROM chunks WHERE doc_id = ?)`,
        )
        .run(docId);
    }
    this.db.prepare(`DELETE FROM chunks WHERE doc_id = ?`).run(docId);
  }

  storeEmbeddings(chunkIds: number[], vectors: Float32Array[]) {
    if (!this.vecLoaded || !this.vecDim) {
      throw new Error("Embeddings not initialized; call initEmbeddings first.");
    }
    if (chunkIds.length !== vectors.length) {
      throw new Error("chunkIds and vectors length mismatch");
    }
    const del = this.db.prepare(`DELETE FROM vec_chunks WHERE chunk_id = ?`);
    const ins = this.db.prepare(
      `INSERT INTO vec_chunks(chunk_id, embedding) VALUES (?, ?)`,
    );
    const tx = this.db.transaction(() => {
      for (let i = 0; i < chunkIds.length; i++) {
        const id = BigInt(chunkIds[i]);
        del.run(id);
        ins.run(id, Buffer.from(vectors[i].buffer));
      }
    });
    tx();
  }

  chunksWithoutEmbeddings(collection?: string, limit = 1000): Chunk[] {
    if (!this.vecLoaded) return [];
    const params: unknown[] = [];
    let where = "";
    if (collection) {
      where = " AND d.collection = ?";
      params.push(collection);
    }
    params.push(limit);
    return this.db
      .prepare(
        `SELECT c.id, c.doc_id, c.idx, c.text, c.section_path
         FROM chunks c
         JOIN docs d ON d.id = c.doc_id
         WHERE NOT EXISTS (SELECT 1 FROM vec_chunks v WHERE v.chunk_id = c.id)${where}
         ORDER BY c.id
         LIMIT ?`,
      )
      .all(...params) as Chunk[];
  }

  // ---------- reads ----------

  listCollections(): { collection: string; doc_count: number }[] {
    return this.db
      .prepare(
        `SELECT collection, COUNT(*) AS doc_count
         FROM docs
         GROUP BY collection
         ORDER BY collection`,
      )
      .all() as { collection: string; doc_count: number }[];
  }

  listDocs(collection?: string): Doc[] {
    const where = collection ? `WHERE d.collection = ?` : "";
    const stmt = this.db.prepare(
      `SELECT d.*, (SELECT COUNT(*) FROM chunks c WHERE c.doc_id = d.id) AS chunk_count
       FROM docs d
       ${where}
       ORDER BY d.fetched_at DESC`,
    );
    return (collection ? stmt.all(collection) : stmt.all()) as Doc[];
  }

  getDoc(id: number): { doc: Doc; chunks: Chunk[] } | null {
    const doc = this.db
      .prepare(
        `SELECT d.*, (SELECT COUNT(*) FROM chunks c WHERE c.doc_id = d.id) AS chunk_count
         FROM docs d WHERE d.id = ?`,
      )
      .get(id) as Doc | undefined;
    if (!doc) return null;
    const chunks = this.db
      .prepare(
        `SELECT id, doc_id, idx, text, section_path
         FROM chunks WHERE doc_id = ? ORDER BY idx`,
      )
      .all(id) as Chunk[];
    return { doc, chunks };
  }

  // ---------- search ----------

  ftsSearch(query: string, opts: { collection?: string; limit?: number } = {}): SearchHit[] {
    const limit = opts.limit ?? 10;
    const fts = toFtsQuery(query);
    if (!fts) return [];
    const params: unknown[] = [fts];
    let where = "";
    if (opts.collection) {
      where = " AND d.collection = ?";
      params.push(opts.collection);
    }
    params.push(limit);
    const rows = this.db
      .prepare(
        `SELECT
           c.id AS chunk_id,
           c.doc_id, d.title AS doc_title, d.url AS doc_url, d.collection AS collection,
           c.idx, c.text, c.section_path,
           bm25(chunks_fts) AS fts_score
         FROM chunks_fts
         JOIN chunks c ON c.id = chunks_fts.rowid
         JOIN docs   d ON d.id = c.doc_id
         WHERE chunks_fts MATCH ?${where}
         ORDER BY fts_score
         LIMIT ?`,
      )
      .all(...params) as Array<Omit<SearchHit, "vec_distance" | "fused_score" | "source">>;
    return rows.map((r) => ({
      ...r,
      vec_distance: null,
      fused_score: 0,
      source: "fts",
    }));
  }

  vectorSearch(
    queryEmbedding: Float32Array,
    opts: { collection?: string; limit?: number } = {},
  ): SearchHit[] {
    if (!this.hasEmbeddings()) return [];
    const limit = opts.limit ?? 10;
    const overFetch = Math.max(limit * 5, 50);
    const params: unknown[] = [Buffer.from(queryEmbedding.buffer), overFetch];
    let where = "";
    if (opts.collection) {
      where = " AND d.collection = ?";
      params.push(opts.collection);
    }
    params.push(limit);
    const rows = this.db
      .prepare(
        `WITH vr AS (
           SELECT chunk_id, distance FROM vec_chunks
           WHERE embedding MATCH ?
           ORDER BY distance LIMIT ?
         )
         SELECT
           vr.chunk_id, vr.distance AS vec_distance,
           c.doc_id, d.title AS doc_title, d.url AS doc_url, d.collection AS collection,
           c.idx, c.text, c.section_path
         FROM vr
         JOIN chunks c ON c.id = vr.chunk_id
         JOIN docs   d ON d.id = c.doc_id
         WHERE 1=1${where}
         ORDER BY vr.distance
         LIMIT ?`,
      )
      .all(...params) as Array<Omit<SearchHit, "fts_score" | "fused_score" | "source">>;
    return rows.map((r) => ({
      ...r,
      fts_score: null,
      fused_score: 0,
      source: "vector",
    }));
  }

  hybridSearch(
    query: string,
    queryEmbedding: Float32Array,
    opts: { collection?: string; limit?: number } = {},
  ): SearchHit[] {
    const limit = opts.limit ?? 10;
    const candidatesEach = Math.max(limit * 3, 20);
    const ftsHits = this.ftsSearch(query, {
      collection: opts.collection,
      limit: candidatesEach,
    });
    const vecHits = this.vectorSearch(queryEmbedding, {
      collection: opts.collection,
      limit: candidatesEach,
    });
    return rrfFuse(ftsHits, vecHits, limit);
  }

  close() {
    this.db.close();
  }
}

// ---------- helpers ----------

function hashChunks(chunks: ChunkInput[]): string {
  const h = createHash("sha256");
  for (const c of chunks) {
    h.update(c.text);
    h.update("\x00");
    h.update(c.section_path ?? "");
    h.update(" ");
  }
  return h.digest("hex");
}

function toFtsQuery(raw: string): string {
  const tokens = raw
    .toLowerCase()
    .replace(/["'`]/g, " ")
    .split(/\s+/)
    .filter((t) => t.length > 1)
    .map((t) => t.replace(/[^a-z0-9_]/gi, ""))
    .filter((t) => t.length > 3)
    .map((t) => `"${t}"*`);
  return tokens.join(" OR ");
}

function rrfFuse(
  ftsHits: SearchHit[],
  vecHits: SearchHit[],
  limit: number,
  k = 60,
): SearchHit[] {
  const byId = new Map<number, SearchHit>();
  ftsHits.forEach((h, i) => {
    const score = 1 / (k + i + 1);
    byId.set(h.chunk_id, { ...h, fused_score: score, source: "hybrid" });
  });
  vecHits.forEach((h, i) => {
    const score = 1 / (k + i + 1);
    const prev = byId.get(h.chunk_id);
    if (prev) {
      byId.set(h.chunk_id, {
        ...prev,
        vec_distance: h.vec_distance,
        fused_score: prev.fused_score + score,
      });
    } else {
      byId.set(h.chunk_id, { ...h, fused_score: score, source: "hybrid" });
    }
  });
  return Array.from(byId.values())
    .sort((a, b) => b.fused_score - a.fused_score)
    .slice(0, limit);
}
