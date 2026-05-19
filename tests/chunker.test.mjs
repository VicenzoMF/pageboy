import { test } from "node:test";
import assert from "node:assert/strict";
import { chunkText, walkSections, buildChunks } from "../dist/ingest.js";

test("chunkText keeps short text as a single chunk", () => {
  const out = chunkText("short paragraph one.\n\nshort paragraph two.");
  assert.equal(out.length, 1);
});

test("chunkText splits when accumulated text exceeds the soft target", () => {
  const para = "lorem ipsum ".repeat(60).trim(); // ~720 chars
  const text = `${para}\n\n${para}\n\n${para}\n\n${para}`;
  const out = chunkText(text);
  assert.ok(out.length >= 2, `expected >=2 chunks, got ${out.length}`);
});

test("chunkText sentence-splits a single very long paragraph", () => {
  const sentence = "This is a complete sentence with several words. ";
  const text = sentence.repeat(80).trim(); // ~3800 chars, no paragraph breaks
  const out = chunkText(text);
  assert.ok(out.length >= 2, `expected sentence splits, got ${out.length}`);
});

test("walkSections tracks H1/H2/H3 path and captures content per section", () => {
  const html = `
    <h1>Introduction</h1>
    <p>Intro body text.</p>
    <h2>Setup</h2>
    <p>Setup body.</p>
    <h3>Linux</h3>
    <p>Linux body.</p>
    <h2>Usage</h2>
    <p>Usage body.</p>
  `;
  const sections = walkSections(html, "Doc Title");
  assert.equal(sections.length, 4);

  const paths = sections.map((s) => s.path.filter(Boolean).join(" > "));
  assert.deepEqual(paths, [
    "Doc Title > Introduction",
    "Doc Title > Introduction > Setup",
    "Doc Title > Introduction > Setup > Linux",
    "Doc Title > Introduction > Usage",
  ]);
  assert.equal(sections[2].text, "Linux body.");
});

test("buildChunks prefixes each chunk with its section path", () => {
  const chunks = buildChunks({
    url: "https://example.com/x",
    html: "",
    title: "Doc Title",
    byline: null,
    site_name: null,
    content_html: "<h2>API</h2><p>Body text here.</p>",
    text_content: "API\n\nBody text here.",
    links: [],
  });
  assert.ok(chunks.length >= 1);
  assert.equal(chunks[0].section_path, "Doc Title > API");
  assert.match(chunks[0].text, /^Doc Title > API\n\nBody text here\./);
});
