import { deflateRawSync } from "node:zlib";

/**
 * A reply that has run away: the model keeps emitting the same thing — one symbol, a phrase,
 * a whole passage — instead of moving on. Judged by the shape of the output alone, never by
 * a model's tags or wording: thinking blocks, `<think>`-style tags in text and plain prose
 * all count, so the check holds for any model.
 *
 * Two measures, because they catch different loops:
 * - the recent output barely compresses down: a symbol or a phrase repeating (healthy
 *   reasoning in real sessions never went below 0.08 at this window; runaways sat near 0.01);
 * - the latest passage is already there, word for word, several times: a paragraph loop,
 *   whose period is too long for the compression window to see.
 */

/** Bytes of recent output the compression check looks at. */
const WINDOW = 4096;
/** Compressed size / raw size below this is a runaway. */
const MAX_RATIO = 0.05;
/** Length of the latest passage looked for earlier in the reply. */
const PASSAGE = 160;
/** Times that passage must be in the reply (the latest one included). */
const PASSAGE_REPEATS = 5;
/** Characters of the reply the passage check searches. */
const SEARCH = 32 * 1024;

export type RunawayKind = "low-variety" | "repeated-passage";

const squash = (s: string) => s.replace(/\s+/g, " ");

/** Why `text` (a reply so far) has run away, or null. */
export function runawayKind(text: string): RunawayKind | null {
  const bytes = Buffer.from(text, "utf8");
  if (bytes.length >= WINDOW) {
    const tail = bytes.subarray(bytes.length - WINDOW);
    if (deflateRawSync(tail).length / tail.length < MAX_RATIO) return "low-variety";
  }
  const recent = squash(text.slice(-SEARCH));
  if (recent.length >= PASSAGE * PASSAGE_REPEATS) {
    const passage = recent.slice(-PASSAGE);
    if (passage.trim().length >= PASSAGE / 2) {
      let count = 0;
      for (let at = recent.indexOf(passage); at >= 0; at = recent.indexOf(passage, at + PASSAGE)) {
        if (++count >= PASSAGE_REPEATS) return "repeated-passage";
      }
    }
  }
  return null;
}

/** Characters of new output between checks while a reply streams. */
export const CHECK_EVERY = 1024;

/** Characters per piece when finding where a runaway began. */
const PIECE = 128;
/** Recent output a piece is compared with: longer than any passage loop worth catching. */
const CONTEXT = 8192;
/** New compressed bytes per raw byte below which a piece only repeats what came before. */
const MAX_NOVELTY = 0.12;

/** How much of `piece` is new after `before`, as compressed bytes per raw byte. */
function novelty(before: string, piece: string): number {
  const base = deflateRawSync(Buffer.from(before, "utf8")).length;
  const both = deflateRawSync(Buffer.from(before + piece, "utf8")).length;
  return (both - base) / Buffer.byteLength(piece, "utf8");
}

/**
 * `text` with its runaway part removed: the reply is replayed the way it streamed to find
 * where the check fires, then walked back to where the repetition began — the first of the
 * pieces that add nothing new. Everything from there on goes. Null when nothing ran away.
 */
export function cutRunaway(text: string): string | null {
  let fired = -1;
  for (let end = CHECK_EVERY; end < text.length + CHECK_EVERY; end += CHECK_EVERY) {
    const upto = Math.min(end, text.length);
    if (runawayKind(text.slice(0, upto))) {
      fired = upto;
      break;
    }
  }
  if (fired < 0) return null;
  let start = fired;
  while (start - PIECE > 0) {
    const from = start - PIECE;
    if (novelty(text.slice(Math.max(0, from - CONTEXT), from), text.slice(from, start)) >= MAX_NOVELTY) break;
    start = from;
  }
  const keep = text.slice(0, start).trimEnd();
  return `${keep}\n\n[anti-loop: ${text.length - keep.length} characters of repeated output removed]`;
}
