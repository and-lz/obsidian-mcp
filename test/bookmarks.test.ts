import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";
import test from "node:test";

import { Runtime } from "../src/runtime.js";
import { createManageBookmarksTool } from "../src/tools/manage-bookmarks/index.js";
import { Logger } from "../src/utils/logger.js";
import { VaultRegistry } from "../src/utils/vault.js";
import { createVault } from "./helpers.js";

async function setup(initial?: unknown) {
  const root = await createVault("obsidian-mcp-bookmarks-");
  await fs.mkdir(path.join(root, "Notes"));
  await fs.writeFile(path.join(root, "Notes", "A.md"), "a");
  await fs.writeFile(path.join(root, "Notes", "B.md"), "b");
  const file = path.join(root, ".obsidian", "bookmarks.json");
  if (initial !== undefined) await fs.writeFile(file, JSON.stringify(initial));
  const runtime = new Runtime(
    await VaultRegistry.create([{ id: "test", root }]),
    { recoveryDays: 30, recoveryMaxBytes: 1024 * 1024 },
    new Logger("error")
  );
  await runtime.initialize();
  return { tool: createManageBookmarksTool(runtime), file };
}

test("add creates bookmarks.json, is idempotent, and list reflects it", async () => {
  const { tool, file } = await setup();
  const added = await tool.execute({ operation: "add", vault: "test", path: "Notes/A.md" }, ctx());
  assert.equal(added.changed, true);
  assert.deepEqual(added.bookmarks, ["Notes/A.md"]);
  const again = await tool.execute({ operation: "add", vault: "test", path: "Notes/A" }, ctx());
  assert.equal(again.changed, false);
  assert.equal(again.transaction_id, null);
  const saved = JSON.parse(await fs.readFile(file, "utf8")) as { items: { path: string }[] };
  assert.equal(saved.items.length, 1);
  const listed = await tool.execute({ operation: "list", vault: "test" }, ctx());
  assert.deepEqual(listed.bookmarks, ["Notes/A.md"]);
});

test("existing items, groups, and unknown keys are preserved; remove reaches into groups", async () => {
  const { tool, file } = await setup({
    extra: 1,
    items: [
      { type: "search", query: "x", title: "" },
      { type: "group", title: "g", items: [{ type: "file", path: "Notes/B.md", title: "" }] }
    ]
  });
  await tool.execute({ operation: "add", vault: "test", path: "Notes/A.md" }, ctx());
  let saved = JSON.parse(await fs.readFile(file, "utf8")) as Record<string, unknown>;
  assert.equal(saved.extra, 1);
  assert.equal((saved.items as unknown[]).length, 3);
  const removed = await tool.execute(
    { operation: "remove", vault: "test", path: "Notes/B.md" },
    ctx()
  );
  assert.equal(removed.changed, true);
  assert.deepEqual(removed.bookmarks, ["Notes/A.md"]);
  saved = JSON.parse(await fs.readFile(file, "utf8")) as Record<string, unknown>;
  assert.equal((saved.items as unknown[]).length, 3);
});

test("missing note and malformed file are rejected", async () => {
  const missing = await setup();
  await assert.rejects(
    missing.tool.execute({ operation: "add", vault: "test", path: "Nope.md" }, ctx()),
    { code: "NOTE_NOT_FOUND" }
  );
  const bad = await setup({ nope: true });
  await assert.rejects(bad.tool.execute({ operation: "list", vault: "test" }, ctx()), {
    code: "INVALID_ARGUMENT"
  });
});

function ctx() {
  return { signal: new AbortController().signal };
}
