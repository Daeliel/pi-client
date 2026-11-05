/**
 * Keep the images sent with one request under a byte budget. Pi sends the whole
 * conversation every time, so screenshots from scenario runs pile up until the server
 * refuses the request (413). Older images are replaced, in what is sent only, by a
 * one-line note. The session file keeps every image.
 *
 * Servers reuse the part of a request they have already read (llama.cpp, LM Studio,
 * Ollama, vLLM all cache the prefix). Dropping one more old image for every new one
 * changed the start of the conversation on every screenshot, and the server re-read
 * all of it: 15 to 30 minutes per request on a 340K-token session (2026-11-05). So once
 * over the budget, old images go in one batch, down to `keepShare` of it, and a dropped
 * image stays dropped. The start of the conversation then changes once every few dozen
 * screenshots, not every time.
 */

import { createHash } from "node:crypto";

export const DROPPED_NOTE = "[older image left out of this request to keep it small — take a new screenshot if you need to see it again]";

/** Once over the budget, images are dropped until this share of it is left. */
export const KEEP_SHARE = 0.5;

interface ImagePart {
  type: "image";
  data?: string;
}

function isImage(part: unknown): part is ImagePart {
  return typeof part === "object" && part !== null && (part as { type?: unknown }).type === "image";
}

function size(part: ImagePart): number {
  return typeof part.data === "string" ? part.data.length : 0;
}

/** The same picture gets the same key in every request, wherever it sits. */
export function imageKey(part: ImagePart): string {
  return createHash("sha1").update(typeof part.data === "string" ? part.data : "").digest("hex");
}

/**
 * The messages with older images dropped, or null when nothing is dropped. `dropped`
 * carries the images already left out by earlier requests of this session; it is
 * updated in place, and those images stay out.
 */
export function trimImages<M>(
  messages: M[],
  budget: number,
  dropped: Set<string> = new Set(),
  keepShare = KEEP_SHARE,
): { messages: M[]; dropped: number; keptBytes: number } | null {
  if (!(budget > 0)) return null;
  const found: { i: number; key: string; bytes: number }[] = [];
  const keys = new Map<unknown, string>();
  // The same screenshot twice (nothing changed on screen) is two images: numbered in
  // order, so leaving out the old copy never leaves out the new one.
  const copies = new Map<string, number>();
  let newest = -1;
  messages.forEach((msg, i) => {
    const content = (msg as { content?: unknown })?.content;
    if (!Array.isArray(content)) return;
    for (const part of content) {
      if (!isImage(part)) continue;
      const hash = imageKey(part);
      const nth = (copies.get(hash) ?? 0) + 1;
      copies.set(hash, nth);
      const key = `${hash}#${nth}`;
      keys.set(part, key);
      found.push({ i, key, bytes: size(part) });
      newest = i;
    }
  });
  if (found.length === 0) return null;

  let used = found.filter((f) => !dropped.has(f.key)).reduce((n, f) => n + f.bytes, 0);
  if (used > budget) {
    // Oldest first, in one batch; the newest message's own images always go through.
    for (const f of found) {
      if (used <= budget * keepShare) break;
      if (f.i === newest || dropped.has(f.key)) continue;
      dropped.add(f.key);
      used -= f.bytes;
    }
  }

  let count = 0;
  const out = messages.map((msg) => {
    const content = (msg as { content?: unknown })?.content;
    const leftOut = (p: unknown) => isImage(p) && dropped.has(keys.get(p) ?? "");
    if (!Array.isArray(content) || !content.some(leftOut)) return msg;
    return {
      ...msg,
      content: content.map((part) => {
        if (!leftOut(part)) return part;
        count++;
        return { type: "text", text: DROPPED_NOTE };
      }),
    } as M;
  });
  return count ? { messages: out, dropped: count, keptBytes: used } : null;
}
