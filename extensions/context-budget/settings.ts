/**
 * Compaction settings for small windows. Pi keeps the last 20K tokens and compacts with 16K
 * left: on a 32K window that leaves nothing to summarize, so compaction silently never runs and
 * the request ends up with no room for a reply. Sized to the window instead, a quarter each.
 */

/** Windows up to this size get their own compaction settings. */
export const SMALL_WINDOW = 65_536;

export interface CompactionOverride {
  reserveTokens: number;
  keepRecentTokens: number;
}

export function compactionFor(contextWindow: number): CompactionOverride | null {
  if (!(contextWindow > 0) || contextWindow > SMALL_WINDOW) return null;
  const quarter = Math.floor(contextWindow / 4);
  return { reserveTokens: quarter, keepRecentTokens: quarter };
}

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/**
 * `settings` with the compaction override for `key` (`provider/modelId`) brought in line with the
 * model's window, or null when nothing changes. `mine` is what this extension wrote for `key`
 * before: only that entry is updated (the window grew or shrank) or removed (the window is no
 * longer small). An entry that differs from it is the user's own and is never touched.
 */
export function reconcileCompaction(
  settings: unknown,
  key: string,
  wanted: CompactionOverride | null,
  mine: CompactionOverride | undefined,
): { settings: Record<string, unknown>; mine: CompactionOverride | null } | null {
  if (!settings || typeof settings !== "object" || Array.isArray(settings)) return null;
  const s = settings as Record<string, unknown>;
  const compaction = (s.compaction && typeof s.compaction === "object" ? s.compaction : {}) as Record<string, unknown>;
  const overrides = (compaction.modelOverrides && typeof compaction.modelOverrides === "object" ? compaction.modelOverrides : {}) as Record<string, unknown>;
  const existing = overrides[key];
  if (existing !== undefined && !(mine && same(existing, mine))) return null;
  if (existing === undefined && mine) return null; // the user removed it: leave it out
  if (same(existing, wanted ?? undefined)) return null;
  const next = { ...overrides };
  if (wanted) next[key] = { ...wanted };
  else delete next[key];
  return { settings: { ...s, compaction: { ...compaction, modelOverrides: next } }, mine: wanted };
}
