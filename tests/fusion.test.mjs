import { test } from "node:test";
import assert from "node:assert/strict";
import { rrfFuse } from "../dist/store.js";

const ftsHit = (chunk_id, idx) => ({
  chunk_id,
  doc_id: 1,
  doc_title: "t",
  doc_url: "u",
  collection: "default",
  idx,
  text: "",
  section_path: null,
  fts_score: -idx,
  vec_distance: null,
  fused_score: 0,
  source: "fts",
});
const vecHit = (chunk_id, idx) => ({
  chunk_id,
  doc_id: 1,
  doc_title: "t",
  doc_url: "u",
  collection: "default",
  idx,
  text: "",
  section_path: null,
  fts_score: null,
  vec_distance: idx,
  fused_score: 0,
  source: "vector",
});

test("rrfFuse sums scores when a chunk appears in both lists", () => {
  const out = rrfFuse([ftsHit(1, 0)], [vecHit(1, 0)], 10);
  assert.equal(out.length, 1);
  assert.ok(Math.abs(out[0].fused_score - 2 / 61) < 1e-9);
  assert.equal(out[0].source, "hybrid");
});

test("rrfFuse ranks higher fused score first", () => {
  const fts = [ftsHit(1, 0), ftsHit(2, 1), ftsHit(3, 2)];
  const vec = [vecHit(2, 0), vecHit(3, 1)];
  const out = rrfFuse(fts, vec, 10);
  assert.equal(out[0].chunk_id, 2);
});

test("rrfFuse respects the limit", () => {
  const fts = Array.from({ length: 5 }, (_, i) => ftsHit(i + 1, i));
  const out = rrfFuse(fts, [], 3);
  assert.equal(out.length, 3);
});

test("rrfFuse preserves vec_distance when fusing", () => {
  const out = rrfFuse([ftsHit(1, 0)], [vecHit(1, 0.42)], 10);
  assert.equal(out[0].vec_distance, 0.42);
});
