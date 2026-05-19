import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizeUrl } from "../dist/ingest.js";

test("normalizeUrl resolves relative paths against the base", () => {
  assert.equal(
    normalizeUrl("/foo/bar", "https://example.com/docs"),
    "https://example.com/foo/bar",
  );
});

test("normalizeUrl strips the fragment", () => {
  assert.equal(
    normalizeUrl("https://example.com/page#section", "https://example.com/"),
    "https://example.com/page",
  );
});

test("normalizeUrl lowercases the hostname", () => {
  assert.equal(
    normalizeUrl("https://EXAMPLE.com/page", "https://example.com/"),
    "https://example.com/page",
  );
});

test("normalizeUrl rejects non-http(s) schemes", () => {
  assert.equal(normalizeUrl("mailto:a@b.com", "https://example.com/"), null);
  assert.equal(
    normalizeUrl("javascript:void(0)", "https://example.com/"),
    null,
  );
  assert.equal(
    normalizeUrl("ftp://example.com/file", "https://example.com/"),
    null,
  );
});

test("normalizeUrl rejects asset extensions (case-insensitive)", () => {
  assert.equal(
    normalizeUrl("https://example.com/x.png", "https://example.com/"),
    null,
  );
  assert.equal(
    normalizeUrl("https://example.com/x.PDF", "https://example.com/"),
    null,
  );
});

test("normalizeUrl returns null for malformed input", () => {
  assert.equal(normalizeUrl("::: not a url", "also not a base"), null);
});
