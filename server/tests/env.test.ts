import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { loadEnvFiles, parseEnv } from "../src/env.js";

test("parseEnv handles comments, quotes, empty values, and invalid keys", () => {
  assert.deepEqual(
    parseEnv(`
# comment
AUTO_BANGUMI_URL=http://127.0.0.1:7892
SPACED = value with spaces # inline comment
HASH_IN_VALUE=https://example.test/path#anchor
DOUBLE_QUOTED="hello\\nworld # not comment"
SINGLE_QUOTED='raw # value'
EMPTY=
1INVALID=ignored
NO_SEPARATOR
`),
    {
      AUTO_BANGUMI_URL: "http://127.0.0.1:7892",
      SPACED: "value with spaces",
      HASH_IN_VALUE: "https://example.test/path#anchor",
      DOUBLE_QUOTED: "hello\nworld # not comment",
      SINGLE_QUOTED: "raw # value",
      EMPTY: ""
    }
  );
});

test("loadEnvFiles loads cwd and parent .env without overriding existing env vars", async () => {
  const parentDir = await mkdtemp(path.join(tmpdir(), "cluo-env-parent-"));
  const childDir = path.join(parentDir, "server");
  const previous = {
    CLUO_PARENT_ONLY: process.env.CLUO_PARENT_ONLY,
    CLUO_CHILD_ONLY: process.env.CLUO_CHILD_ONLY,
    CLUO_SHARED: process.env.CLUO_SHARED
  };

  try {
    await mkdir(childDir);
    await writeFile(path.join(parentDir, ".env"), "CLUO_PARENT_ONLY=parent\nCLUO_SHARED=parent\n");
    await writeFile(path.join(childDir, ".env"), "CLUO_CHILD_ONLY=child\nCLUO_SHARED=child\n");
  } catch (error) {
    await rm(parentDir, { recursive: true, force: true });
    throw error;
  }

  try {
    process.env.CLUO_SHARED = "system";
    delete process.env.CLUO_PARENT_ONLY;
    delete process.env.CLUO_CHILD_ONLY;

    const loaded = loadEnvFiles(childDir);

    assert.equal(loaded.loaded.length, 2);
    assert.equal(process.env.CLUO_CHILD_ONLY, "child");
    assert.equal(process.env.CLUO_PARENT_ONLY, "parent");
    assert.equal(process.env.CLUO_SHARED, "system");
  } finally {
    restoreEnv("CLUO_PARENT_ONLY", previous.CLUO_PARENT_ONLY);
    restoreEnv("CLUO_CHILD_ONLY", previous.CLUO_CHILD_ONLY);
    restoreEnv("CLUO_SHARED", previous.CLUO_SHARED);
    await rm(parentDir, { recursive: true, force: true });
  }
});

function restoreEnv(key: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[key];
  } else {
    process.env[key] = value;
  }
}
