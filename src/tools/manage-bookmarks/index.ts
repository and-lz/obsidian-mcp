import type { ToolAnnotations } from "@modelcontextprotocol/server";
import * as z from "zod";

import type { Runtime } from "../../runtime.js";
import type { ToolDefinition } from "../../types.js";
import { ToolFailure } from "../../utils/errors.js";
import {
  etagSchema,
  nullableTransactionIdSchema,
  outputEtagSchema,
  outputPathSchema,
  relativePathSchema,
  vaultSchema
} from "../../utils/schemas.js";
import { assertIfMatch } from "../../utils/validation.js";
import { sha256 } from "../../utils/vault.js";

export const TOOL_NAME = "obsidian_manage_bookmarks";

const MAX_BOOKMARK_ITEMS = 10_000;
const MAX_GROUP_DEPTH = 32;

const BOOKMARKS: ToolAnnotations = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false
};

const ifMatchSchema = etagSchema.optional().meta({
  description: "Optional revision guard for .obsidian/bookmarks.json returned by a previous call"
});

const inputSchema = z.discriminatedUnion("operation", [
  z
    .object({
      operation: z.literal("list").meta({ description: "List bookmarked notes" }),
      vault: vaultSchema
    })
    .strict(),
  z
    .object({
      operation: z.literal("add").meta({ description: "Bookmark (favorite) a note" }),
      vault: vaultSchema,
      path: relativePathSchema.meta({
        description: "Vault-relative path of the note to bookmark",
        examples: ["Projects/Plan.md"]
      }),
      if_match: ifMatchSchema
    })
    .strict(),
  z
    .object({
      operation: z.literal("remove").meta({ description: "Remove a note's bookmark" }),
      vault: vaultSchema,
      path: relativePathSchema.meta({
        description: "Vault-relative path of the note to unbookmark",
        examples: ["Projects/Plan.md"]
      }),
      if_match: ifMatchSchema
    })
    .strict()
]);

const outputSchema = z
  .object({
    operation: z.enum(["list", "add", "remove"]),
    changed: z.boolean().meta({
      description: "Whether bookmarks.json was modified; false when already in the requested state"
    }),
    bookmarks: z.array(outputPathSchema).meta({
      description: "Bookmarked note paths after the operation, in file order"
    }),
    etag: outputEtagSchema.nullable().meta({
      description:
        "SHA-256 revision of bookmarks.json after the operation, or null if it does not exist"
    }),
    transaction_id: nullableTransactionIdSchema
  })
  .strict();

type BookmarkItem = Record<string, unknown>;

interface BookmarksFile {
  items: BookmarkItem[];
  [key: string]: unknown;
}

export function createManageBookmarksTool(
  runtime: Runtime
): ToolDefinition<typeof inputSchema, typeof outputSchema> {
  return {
    name: TOOL_NAME,
    title: "Manage Obsidian Bookmarks",
    description:
      "List, add, or remove Obsidian bookmarks (favorites) for notes by transactionally editing the core Bookmarks plugin file .obsidian/bookmarks.json, the only file under .obsidian that tools can touch. Requires an Obsidian vault root.",
    inputSchema,
    outputSchema,
    annotations: BOOKMARKS,
    execute: async (input) => {
      const service = runtime.forVault(input.vault);
      const target = await service.fs.resolveBookmarksFile();
      const current = target.exists ? await service.fs.readText(target) : undefined;
      const file = current === undefined ? { items: [] } : parseBookmarks(current.text);
      const bookmarks = collectPaths(file.items);

      if (input.operation === "list") {
        return {
          operation: "list",
          changed: false,
          bookmarks,
          etag: current?.etag ?? null,
          transaction_id: null
        };
      }

      if (current === undefined) {
        if (input.if_match !== undefined) {
          throw new ToolFailure(
            "REVISION_CONFLICT",
            "The bookmarks file does not exist, so the revision cannot match. Retry without if_match.",
            { retryable: true }
          );
        }
      } else {
        assertIfMatch(input.if_match, current.etag);
      }

      const note = await service.fs.resolveExisting(input.path, { markdown: true });
      const present = bookmarks.includes(note.relativePath);
      if (input.operation === "add" ? present : !present) {
        return {
          operation: input.operation,
          changed: false,
          bookmarks,
          etag: current?.etag ?? null,
          transaction_id: null
        };
      }

      const next = structuredClone(file);
      if (input.operation === "add") {
        if (bookmarks.length >= MAX_BOOKMARK_ITEMS) {
          throw new ToolFailure("INPUT_TOO_LARGE", "The bookmarks file has too many entries.");
        }
        next.items.push({ type: "file", ctime: Date.now(), path: note.relativePath, title: "" });
      } else {
        removePath(next.items, note.relativePath);
      }
      const data = Buffer.from(`${JSON.stringify(next, null, 2)}\n`, "utf8");
      const transactionId = await service.transactions.run([
        {
          kind: "write",
          path: target.absolutePath,
          data,
          ...(current === undefined ? { requireMissing: true } : { expectedEtag: current.etag })
        }
      ]);
      return {
        operation: input.operation,
        changed: true,
        bookmarks: collectPaths(next.items),
        etag: sha256(data),
        transaction_id: transactionId
      };
    }
  };
}

function parseBookmarks(text: string): BookmarksFile {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new ToolFailure("INVALID_ARGUMENT", ".obsidian/bookmarks.json is not valid JSON.", {
      cause: error
    });
  }
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    Array.isArray(parsed) ||
    !("items" in parsed) ||
    !Array.isArray(parsed.items)
  ) {
    throw new ToolFailure(
      "INVALID_ARGUMENT",
      ".obsidian/bookmarks.json does not have the expected { items: [] } shape."
    );
  }
  const file = parsed as BookmarksFile;
  assertWithinLimits(file.items);
  return file;
}

function assertWithinLimits(items: readonly unknown[]): void {
  let count = 0;
  const visit = (list: readonly unknown[], depth: number): void => {
    if (depth > MAX_GROUP_DEPTH) {
      throw new ToolFailure("INVALID_ARGUMENT", "Bookmark groups are nested too deeply.");
    }
    for (const item of list) {
      count += 1;
      if (count > MAX_BOOKMARK_ITEMS) {
        throw new ToolFailure("INPUT_TOO_LARGE", "The bookmarks file has too many entries.");
      }
      const children = groupItems(item);
      if (children !== undefined) visit(children, depth + 1);
    }
  };
  visit(items, 1);
}

function groupItems(item: unknown): readonly unknown[] | undefined {
  if (typeof item !== "object" || item === null) return undefined;
  const record = item as BookmarkItem;
  return record.type === "group" && Array.isArray(record.items) ? record.items : undefined;
}

function collectPaths(items: readonly unknown[]): string[] {
  const output: string[] = [];
  for (const item of items) {
    if (typeof item !== "object" || item === null) continue;
    const record = item as BookmarkItem;
    if (record.type === "file" && typeof record.path === "string") output.push(record.path);
    const children = groupItems(item);
    if (children !== undefined) output.push(...collectPaths(children));
  }
  return output;
}

function removePath(items: unknown[], notePath: string): void {
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index];
    if (typeof item !== "object" || item === null) continue;
    const record = item as BookmarkItem;
    if (record.type === "file" && record.path === notePath) {
      items.splice(index, 1);
    } else if (record.type === "group" && Array.isArray(record.items)) {
      removePath(record.items, notePath);
    }
  }
}
