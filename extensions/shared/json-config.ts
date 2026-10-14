import * as fs from "node:fs";

/**
 * Reading pi-client JSON config files without silent failure.
 *
 * Every extension used to wrap JSON.parse in try/catch → null, so one typo (or the
 * UTF-8 byte-order mark PowerShell 5 and some editors write) made the whole file
 * disappear and the gates quietly ran on defaults. Errors are now remembered and
 * shown to the user once per file and message.
 */

interface ErrorState {
  /** file → error message, for files that currently fail to load. */
  failing: Map<string, string>;
  /** "file|message" already shown to the user. */
  reported: Set<string>;
}

// Shared across extensions: pi loads each extension with its own module instance.
const STATE_KEY = Symbol.for("pi-client.json-config-errors");
function state(): ErrorState {
  const g = globalThis as typeof globalThis & { [STATE_KEY]?: ErrorState };
  if (!g[STATE_KEY]) g[STATE_KEY] = { failing: new Map(), reported: new Set() };
  return g[STATE_KEY];
}

/** Parse a JSON object config file. Missing file → null. Broken file → null, and remembered. */
export function readJsonConfig<T extends object>(file: string): Partial<T> | null {
  if (!fs.existsSync(file)) {
    state().failing.delete(file);
    return null;
  }
  try {
    const raw = fs.readFileSync(file, "utf8").replace(/^﻿/, "");
    const value: unknown = JSON.parse(raw);
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("expected a JSON object { … }");
    state().failing.delete(file);
    return value as Partial<T>;
  } catch (e) {
    state().failing.set(file, e instanceof Error ? e.message : String(e));
    return null;
  }
}

/** Failing config files not yet shown to the user (each is returned once). */
export function takeUnreportedConfigErrors(): string[] {
  const s = state();
  const out: string[] = [];
  for (const [file, message] of s.failing) {
    const key = `${file}|${message}`;
    if (s.reported.has(key)) continue;
    s.reported.add(key);
    out.push(`${file}: ${message}`);
  }
  return out;
}

/** Show broken config files once. Call after an extension (re)loads its config. */
export function reportConfigErrors(ctx: { hasUI: boolean; ui: { notify(message: string, type?: "info" | "warning" | "error"): void } }): void {
  const errors = takeUnreportedConfigErrors();
  if (errors.length === 0 || !ctx.hasUI) return;
  ctx.ui.notify(
    `pi-client: ignoring config file(s) that are not valid JSON — other layers and defaults apply until fixed:\n${errors.map((e) => `  - ${e}`).join("\n")}`,
    "error",
  );
}
