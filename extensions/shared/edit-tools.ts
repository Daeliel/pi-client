import * as fs from "node:fs";

/**
 * Which tool calls count as file edits, and which edited files count as code.
 * Shared by every gate so they agree on what "the model changed something" means.
 */

const EDIT_TOOLS = new Set(["write", "edit", "create", "multiedit", "apply_patch", "str_replace"]);

export function isEditTool(toolName: string): boolean {
  return EDIT_TOOLS.has(toolName);
}

/**
 * A Git-Bash style path on Windows — `/d/work/x` — means `D:\work\x`. Pi's file tools accept
 * it; Node's path.resolve reads it as `C:\d\work\x`, so every gate would look in the wrong place.
 */
export function normalizeToolPath(p: string, platform: string = process.platform): string {
  if (platform !== "win32") return p;
  const m = p.match(/^\/([a-zA-Z])(\/.*)?$/);
  if (!m) return p;
  const drive = `${m[1]!.toUpperCase()}:`;
  try {
    if (!fs.existsSync(`${drive}\\`)) return p;
  } catch {
    return p;
  }
  return `${drive}${(m[2] ?? "/").replace(/\//g, "\\")}`;
}

/** Pull a file path out of an edit/write tool input, whatever the field is named. */
export function extractEditPath(input: unknown): string | null {
  if (!input || typeof input !== "object") return null;
  const obj = input as Record<string, unknown>;
  for (const key of ["path", "file_path", "filePath", "filename", "file"]) {
    const v = obj[key];
    if (typeof v === "string" && v.length > 0) return normalizeToolPath(v);
  }
  return null;
}

/** Prose, notes and binary assets: editing these never needs acceptance proof. */
const NON_CODE = /\.(md|mdx|markdown|txt|rst|adoc|log|csv|png|jpe?g|gif|webp|svg|ico|pdf|lock)$/i;
const NON_CODE_NAMES = /(^|\/)(license|licence|changelog|authors|notice)(\.[a-z]+)?$/i;

/**
 * True for files whose change can alter behaviour. Docs, notes, images and
 * lockfiles do not, so they must not trigger "define acceptance scenarios".
 */
export function isCodePath(filePath: string): boolean {
  const n = filePath.replace(/\\/g, "/");
  if (NON_CODE.test(n)) return false;
  if (NON_CODE_NAMES.test(n)) return false;
  return true;
}
