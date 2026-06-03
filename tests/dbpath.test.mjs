import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";
import { resolveDefaultDb } from "../dist/dbpath.js";

function tempRoot() {
  return mkdtempSync(join(tmpdir(), "pageboy-dbpath-"));
}

const NO_ENV = {}; // no PAGEBOY_DB

test("PAGEBOY_DB env always wins", () => {
  const got = resolveDefaultDb("/whatever/cwd", { PAGEBOY_DB: "/abs/custom.db" });
  assert.equal(got, "/abs/custom.db");
});

test("reuses an existing data/pageboy.db in the cwd", () => {
  const root = tempRoot();
  try {
    mkdirSync(join(root, "data"), { recursive: true });
    writeFileSync(join(root, "data", "pageboy.db"), "");
    assert.equal(resolveDefaultDb(root, NO_ENV), join(root, "data", "pageboy.db"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("finds the project DB from a nested subdirectory", () => {
  const root = tempRoot();
  try {
    mkdirSync(join(root, "data"), { recursive: true });
    writeFileSync(join(root, "data", "pageboy.db"), "");
    const deep = join(root, "src", "a", "b");
    mkdirSync(deep, { recursive: true });
    assert.equal(resolveDefaultDb(deep, NO_ENV), join(root, "data", "pageboy.db"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("anchors a fresh project to the git repo root", () => {
  const root = tempRoot();
  try {
    mkdirSync(join(root, ".git"), { recursive: true });
    const deep = join(root, "packages", "x");
    mkdirSync(deep, { recursive: true });
    assert.equal(resolveDefaultDb(deep, NO_ENV), join(root, "data", "pageboy.db"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("falls back to the per-user home DB outside any project", () => {
  const root = tempRoot();
  try {
    // bare temp dir: no data/pageboy.db and no .git in it or its temp ancestors
    assert.equal(
      resolveDefaultDb(root, NO_ENV),
      join(homedir(), ".pageboy", "pageboy.db"),
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
