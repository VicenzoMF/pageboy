import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../dist/store.js";

async function withStore(fn) {
  const dir = await mkdtemp(join(tmpdir(), "pageboy-test-"));
  const store = new Store(join(dir, "test.db"));
  try {
    await fn(store);
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
}

test("upsertDoc inserts a doc and getDoc returns its chunks", async () => {
  await withStore((store) => {
    const r = store.upsertDoc({
      url: "https://example.com/a",
      title: "Doc A",
      byline: null,
      site_name: null,
      chunks: [
        { text: "alpha bravo charlie delta", section_path: null },
        { text: "echo foxtrot golf hotel", section_path: "Doc A > Section" },
      ],
    });
    assert.equal(r.unchanged, false);
    assert.equal(r.chunkCount, 2);

    const full = store.getDoc(r.docId);
    assert.ok(full);
    assert.equal(full.doc.title, "Doc A");
    assert.equal(full.chunks.length, 2);
    assert.equal(full.chunks[0].text, "alpha bravo charlie delta");
    assert.equal(full.chunks[1].section_path, "Doc A > Section");
  });
});

test("upsertDoc with identical content reports unchanged", async () => {
  await withStore((store) => {
    const chunks = [{ text: "same content here today", section_path: null }];
    const args = {
      url: "https://example.com/b",
      title: "Doc B",
      byline: null,
      site_name: null,
      chunks,
    };
    const r1 = store.upsertDoc(args);
    const r2 = store.upsertDoc(args);
    assert.equal(r1.unchanged, false);
    assert.equal(r2.unchanged, true);
    assert.equal(r2.docId, r1.docId);
  });
});

test("upsertDoc with different content replaces chunks in place", async () => {
  await withStore((store) => {
    const r1 = store.upsertDoc({
      url: "https://example.com/c",
      title: "Doc C",
      byline: null,
      site_name: null,
      chunks: [{ text: "original text alpha", section_path: null }],
    });
    const r2 = store.upsertDoc({
      url: "https://example.com/c",
      title: "Doc C",
      byline: null,
      site_name: null,
      chunks: [
        { text: "new text beta", section_path: null },
        { text: "new text gamma", section_path: null },
      ],
    });
    assert.equal(r2.unchanged, false);
    assert.equal(r2.docId, r1.docId);

    const full = store.getDoc(r2.docId);
    assert.equal(full.chunks.length, 2);
    assert.match(full.chunks[0].text, /beta/);
    assert.match(full.chunks[1].text, /gamma/);
  });
});

test("ftsSearch finds chunks by token", async () => {
  await withStore((store) => {
    store.upsertDoc({
      url: "https://example.com/d",
      title: "Doc D",
      byline: null,
      site_name: null,
      chunks: [
        {
          text: "the quick brown fox jumps over the lazy dog",
          section_path: null,
        },
        {
          text: "completely unrelated content about ferrets",
          section_path: null,
        },
      ],
    });
    const hits = store.ftsSearch("brown");
    assert.ok(hits.length >= 1);
    assert.match(hits[0].text, /brown/);
    assert.equal(hits[0].source, "fts");
  });
});

test("listCollections groups docs by collection", async () => {
  await withStore((store) => {
    const mk = (slug, collection) => ({
      url: `https://example.com/${slug}`,
      title: slug,
      byline: null,
      site_name: null,
      collection,
      chunks: [{ text: `body for ${slug}`, section_path: null }],
    });
    store.upsertDoc(mk("e1", "alpha"));
    store.upsertDoc(mk("e2", "alpha"));
    store.upsertDoc(mk("e3", "beta"));

    const cols = store.listCollections();
    const byName = Object.fromEntries(
      cols.map((c) => [c.collection, c.doc_count]),
    );
    assert.equal(byName.alpha, 2);
    assert.equal(byName.beta, 1);
  });
});
