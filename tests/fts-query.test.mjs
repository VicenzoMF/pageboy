import { test } from "node:test";
import assert from "node:assert/strict";
import { toFtsQuery } from "../dist/store.js";

test("toFtsQuery wraps each long-enough token as a prefix match", () => {
  assert.equal(toFtsQuery("hello world"), '"hello"* OR "world"*');
});

test("toFtsQuery drops tokens of 3 chars or fewer", () => {
  const q = toFtsQuery("the quick brown fox");
  assert.ok(q.includes('"quick"*'));
  assert.ok(q.includes('"brown"*'));
  assert.ok(!q.includes('"the"'));
  assert.ok(!q.includes('"fox"'));
});

test("toFtsQuery strips surrounding quotes", () => {
  assert.equal(toFtsQuery(`"hello" 'world'`), '"hello"* OR "world"*');
});

test("toFtsQuery returns empty string when no usable tokens remain", () => {
  assert.equal(toFtsQuery("a an of the"), "");
});
