/**
 * One-shot prompt modifiers for the /once command.
 *
 *   /once ultimate build me a snake game
 *   /once <modifier> [<modifier> ...] <prompt>
 *
 * Any foundation extension can register modifiers from its factory; the /once
 * command (extensions/once) resolves them and sends the remaining text as the
 * user prompt. A modifier lives for exactly that task and its follow-up passes —
 * whatever "lives" means is up to the extension that registered it.
 */

export interface OnceModifier {
  /** Word the user types after /once (lowercase, no spaces). */
  name: string;
  /** One line shown in /once help and autocomplete. */
  description: string;
  /** Owning extension, for help grouping. */
  owner: string;
  /** Arm the modifier for the prompt about to be sent. */
  apply: () => void;
  /** Optionally rewrite the prompt text before it is sent (applied in modifier order). */
  transform?: (prompt: string) => string;
}

/**
 * pi loads every extension through its own jiti instance with moduleCache off, so a
 * plain module-level Map would be a different Map in each extension. The registry
 * must live on globalThis to be shared between the /once command and the extensions
 * that register modifiers.
 */
const REGISTRY_KEY = Symbol.for("pi-client.once.modifiers");
type GlobalWithRegistry = typeof globalThis & { [REGISTRY_KEY]?: Map<string, OnceModifier> };

function registry(): Map<string, OnceModifier> {
  const g = globalThis as GlobalWithRegistry;
  if (!g[REGISTRY_KEY]) g[REGISTRY_KEY] = new Map<string, OnceModifier>();
  return g[REGISTRY_KEY];
}

export function registerOnceModifier(mod: OnceModifier): void {
  registry().set(mod.name.toLowerCase(), mod);
}

export function getOnceModifier(name: string): OnceModifier | undefined {
  return registry().get(name.toLowerCase());
}

export function listOnceModifiers(): OnceModifier[] {
  return [...registry().values()].sort((a, b) => a.owner.localeCompare(b.owner) || a.name.localeCompare(b.name));
}

export interface ParsedOnce {
  modifiers: OnceModifier[];
  /** First word that was not a known modifier (and everything after it). */
  prompt: string;
  /** True when the first word is unknown — nothing could be applied. */
  unknownFirst: string | null;
}

/** Peel known modifier words off the front; the rest is the prompt. */
export function parseOnceArgs(args: string): ParsedOnce {
  const words = args.trim().split(/\s+/).filter(Boolean);
  const found: OnceModifier[] = [];
  let i = 0;
  while (i < words.length) {
    const mod = getOnceModifier(words[i]!);
    if (!mod) break;
    if (!found.includes(mod)) found.push(mod);
    i += 1;
  }
  const prompt = words.slice(i).join(" ");
  const unknownFirst = found.length === 0 && words.length > 0 ? words[0]! : null;
  return { modifiers: found, prompt, unknownFirst };
}

/** Tests / reloads. */
export function clearOnceModifiers(): void {
  registry().clear();
}
