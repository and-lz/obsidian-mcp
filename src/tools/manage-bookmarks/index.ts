import { promises as fs } from "node:fs";
import path from "node:path";

import * as z from "zod";

import type { Runtime } from "../../runtime.js";
import type { ToolDefinition } from "../../types.js";
import { isNodeError, ToolFailure } from "../../utils/errors.js";
import {
  nullableTransactionIdSchema,
  outputPathSchema,
  relativePathSchema,
  vaultSchema
} from "../../utils/schemas.js";
import { MUTATE } from "../../utils/tool-factory.js";
import { sha256 } from "../../utils/vault.js";

export const TOOL_NAME = "obsidian_manage_bookmarks";

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
      })
    })
    .strict(),
  z
    .object({
      operation: z.literal("remove").meta({ description: "Remove a note's bookmark" }),
      vault: vaultSchema,
      path: relativePathSchema.meta({
        description: "Vault-relative path of the note to unbookmark",
        examples: ["Projects/Plan.md"]
      })
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
    transaction_id: nullableTransactionIdSchema
  })
  .strict();

interface BookmarkItem {
  type?: unknown;
  path?: unknown;
  items?: unknown;
  [key: string]: unknown;
}

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
      "List, add, or remove Obsidian bookmarks (favorites) for notes by editing the core Bookmarks plugin file transactionally. Requires the vault to be an Obsidian vault with a .obsidian directory.",
    inputSchema,
    outputSchema,
    annotations: MUTATE,
    execute: async (input) => {
      const service = runtime.forVault(input.vault);
      const target = path.join(service.vault.root, ".obsidian", "bookmarks.json");
      const current = await readBookmarks(target);

      if (input.operation === "list") {
        return {
          operation: "list",
          changed: false,
          bookmarks: collectPaths(current.file.items),
          transaction_id: null
        };
      }

      const note = await service.fs.resolveExisting(input.path, { markdown: true });
      const present = collectPaths(current.file.items).includes(note.relativePath);
      if (input.operation === "add" ? present : !present) {
        return {
          operation: input.operation,
          changed: false,
          bookmarks: collectPaths(current.file.items),
          transaction_id: null
        };
      }

      const file = structuredClone(current.file);
      if (input.operation === "add") {
        file.items.push({ type: "file", ctime: Date.now(), path: note.relativePath, title: "" });
      } else {
        removePath(file.items, note.relativePath);
      }
      const transactionId = await service.transactions.run([
        {
          kind: "write",
          path: target,
          data: Buffer.from(`${JSON.stringify(file, null, 2)}\n`, "utf8"),
          ...(current.raw === undefined
            ? { requireMissing: true }
            : { expectedEtag: sha256(current.raw) })
        }
      ]);
      return {
        operation: input.operation,
        changed: true,
        bookmarks: collectPaths(file.items),
        transaction_id: transactionId
      };
    }
  };
}

async function readBookmarks(
  target: string
): Promise<{ file: BookmarksFile; raw: Buffer | undefined }> {
  const configDirectory = path.dirname(target);
  try {
    if (!(await fs.stat(configDirectory)).isDirectory()) throw new Error("not a directory");
  } catch {
    throw new ToolFailure(
      "NOTE_NOT_FOUND",
      "The vault has no .obsidian directory; bookmarks need an Obsidian vault root."
    );
  }
  let raw: Buffer;
  try {
    raw = await fs.readFile(target);
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return { file: { items: [] }, raw: undefined };
    }
    throw new ToolFailure("FILESYSTEM_ERROR", "Could not read .obsidian/bookmarks.json.", {
      cause: error
    });
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.toString("utf8"));
  } catch (error) {
    throw new ToolFailure("INVALID_ARGUMENT", ".obsidian/bookmarks.json is not valid JSON.", {
      cause: error
    });
  }
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    !("items" in parsed) ||
    !Array.isArray(parsed.items)
  ) {
    throw new ToolFailure(
      "INVALID_ARGUMENT",
      ".obsidian/bookmarks.json does not have the expected { items: [] } shape."
    );
  }
  return { file: parsed as BookmarksFile, raw };
}

function collectPaths(items: readonly BookmarkItem[]): string[] {
  const output: string[] = [];
  for (const item of items) {
    if (item.type === "file" && typeof item.path === "string") output.push(item.path);
    if (item.type === "group" && Array.isArray(item.items)) {
      output.push(...collectPaths(item.items as BookmarkItem[]));
    }
  }
  return output;
}

function removePath(items: BookmarkItem[], notePath: string): void {
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index];
    if (item === undefined) continue;
    if (item.type === "file" && item.path === notePath) {
      items.splice(index, 1);
    } else if (item.type === "group" && Array.isArray(item.items)) {
      removePath(item.items as BookmarkItem[], notePath);
    }
  }
}
