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

test(".obsidian or bookmarks.json as a symlink is rejected without reading the target", async () => {
  const linkedFile = await setup();
  const outside = path.join(path.dirname(linkedFile.file), "..", "outside.json");
  await fs.writeFile(outside, JSON.stringify({ items: [{ type: "file", path: "Secret.md" }] }));
  await fs.symlink(outside, linkedFile.file);
  await assert.rejects(linkedFile.tool.execute({ operation: "list", vault: "test" }, ctx()), {
    code: "SYMLINK_NOT_ALLOWED"
  });

  const linkedDirectory = await setup();
  const realConfig = path.join(path.dirname(linkedDirectory.file), "..", "real-config");
  await fs.rename(path.dirname(linkedDirectory.file), realConfig);
  await fs.symlink(realConfig, path.dirname(linkedDirectory.file));
  await assert.rejects(
    linkedDirectory.tool.execute({ operation: "add", vault: "test", path: "Notes/A.md" }, ctx()),
    { code: "SYMLINK_NOT_ALLOWED" }
  );
});

test("missing .obsidian directory gives an actionable error", async () => {
  const { tool, file } = await setup();
  await fs.rm(path.dirname(file), { recursive: true });
  await assert.rejects(tool.execute({ operation: "list", vault: "test" }, ctx()), {
    code: "NOTE_NOT_FOUND"
  });
});

test("oversized files and over-nested groups are rejected", async () => {
  const big = await setup();
  await fs.writeFile(big.file, " ".repeat(5 * 1024 * 1024 + 1));
  await assert.rejects(big.tool.execute({ operation: "list", vault: "test" }, ctx()), {
    code: "INPUT_TOO_LARGE"
  });

  let nested: Record<string, unknown> = { type: "file", path: "Notes/A.md" };
  for (let depth = 0; depth < 40; depth += 1) {
    nested = { type: "group", title: "g", items: [nested] };
  }
  const deep = await setup({ items: [nested] });
  await assert.rejects(deep.tool.execute({ operation: "list", vault: "test" }, ctx()), {
    code: "INVALID_ARGUMENT"
  });
});

test("if_match guards against stale revisions", async () => {
  const { tool } = await setup();
  const first = await tool.execute({ operation: "add", vault: "test", path: "Notes/A.md" }, ctx());
  assert.match(first.etag ?? "", /^[a-f0-9]{64}$/u);
  await assert.rejects(
    tool.execute(
      { operation: "add", vault: "test", path: "Notes/B.md", if_match: "0".repeat(64) },
      ctx()
    ),
    { code: "REVISION_CONFLICT" }
  );
  const second = await tool.execute(
    { operation: "add", vault: "test", path: "Notes/B.md", if_match: first.etag ?? "" },
    ctx()
  );
  assert.equal(second.changed, true);
  const fresh = await setup();
  await assert.rejects(
    fresh.tool.execute(
      { operation: "add", vault: "test", path: "Notes/A.md", if_match: "0".repeat(64) },
      ctx()
    ),
    { code: "REVISION_CONFLICT" }
  );
});

test("note paths cannot escape the vault or target reserved roots", async () => {
  const { tool } = await setup();
  for (const bad of ["../x.md", "/etc/passwd", ".obsidian/bookmarks.json", "Notes/../../x.md"]) {
    await assert.rejects(tool.execute({ operation: "add", vault: "test", path: bad }, ctx()), {
      code: "PATH_REJECTED"
    });
  }
});

function ctx() {
  return { signal: new AbortController().signal };
}
