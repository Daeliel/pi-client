/**
 * Keep the images sent with one request under a byte budget. Pi sends the whole
 * conversation every time, so screenshots from scenario runs pile up until the server
 * refuses the request (413). The newest images are kept; older ones are replaced, in
 * what is sent only, by a one-line note. The session file keeps every image.
 */

export const DROPPED_NOTE = "[older image left out of this request to keep it small — take a new screenshot if you need to see it again]";

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

/** The messages with older images dropped beyond `budget` bytes, or null when nothing had to go. */
export function trimImages<M>(messages: M[], budget: number): { messages: M[]; dropped: number; keptBytes: number } | null {
  if (!(budget > 0)) return null;
  let used = 0;
  let dropped = 0;
  const out = [...messages];
  // Newest first: the latest screenshots are the ones that matter.
  for (let i = out.length - 1; i >= 0; i--) {
    const msg = out[i] as { content?: unknown };
    if (!msg || !Array.isArray(msg.content) || !msg.content.some(isImage)) continue;
    let changed = false;
    const content = msg.content.map((part) => {
      if (!isImage(part)) return part;
      const n = size(part);
      if (used + n <= budget) {
        used += n;
        return part;
      }
      dropped++;
      changed = true;
      return { type: "text", text: DROPPED_NOTE };
    });
    if (changed) out[i] = { ...msg, content } as M;
  }
  return dropped ? { messages: out, dropped, keptBytes: used } : null;
}
