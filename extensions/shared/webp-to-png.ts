/**
 * WebP images become PNG before any request leaves Pi.
 *
 * llama.cpp cannot decode WebP: a request carrying one fails as a whole ("400 Failed to
 * load image or audio file", measured on a llama.cpp server 2026-11-05), and since every
 * request resends the conversation, so does every request after it. Every server reads
 * PNG, so converting needs no guess about which server is behind a model, and covers
 * images from `read`, from other tools, pasted ones, and ones already in a session.
 *
 * Decoding is WebAssembly (@jsquash/webp) and encoding pure JS (fast-png): no native build,
 * the same on every platform. A picture is converted once and kept, so the requests that
 * resend it cost nothing.
 */

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";

export const UNREADABLE_WEBP = "[a WebP image could not be converted to PNG and was left out of this request]";

interface ImagePart {
  type: "image";
  data?: string;
  mimeType?: string;
}

function isImage(part: unknown): part is ImagePart {
  return typeof part === "object" && part !== null && (part as { type?: unknown }).type === "image";
}

/** By its type, or by its bytes: "RIFF" .... "WEBP" (a mislabelled .png can still be WebP). */
export function isWebp(part: { data?: string; mimeType?: string }): boolean {
  if (String(part.mimeType || "").toLowerCase() === "image/webp") return true;
  if (typeof part.data !== "string" || part.data.length < 16) return false;
  const head = Buffer.from(part.data.slice(0, 16), "base64");
  return head.length >= 12 && head.toString("latin1", 0, 4) === "RIFF" && head.toString("latin1", 8, 12) === "WEBP";
}

type Decoded = { width: number; height: number; data: Uint8ClampedArray };
type Decode = (buffer: ArrayBuffer) => Promise<Decoded>;
type Encode = (image: { width: number; height: number; data: Uint8Array; channels: number; depth: number }) => Uint8Array;

let codecs: Promise<{ decode: Decode; encode: Encode }> | null = null;

function loadCodecs() {
  if (!codecs) {
    codecs = (async () => {
      // The decoder builds a browser ImageData; Node has none, and only the fields are read.
      const g = globalThis as { ImageData?: unknown };
      if (typeof g.ImageData === "undefined") {
        g.ImageData = class ImageData {
          constructor(public data: Uint8ClampedArray, public width: number, public height: number) {}
        };
      }
      const require = createRequire(import.meta.url);
      const dec = (await import(pathToFileURL(require.resolve("@jsquash/webp/decode.js")).href)) as {
        init: (module: WebAssembly.Module) => Promise<void>;
        default: Decode;
      };
      // In Node the decoder cannot fetch its .wasm: hand it the compiled module.
      await dec.init(await WebAssembly.compile(readFileSync(require.resolve("@jsquash/webp/codec/dec/webp_dec.wasm"))));
      const png = (await import("fast-png")) as unknown as { encode: Encode };
      return { decode: dec.default, encode: png.encode };
    })();
    codecs.catch(() => {
      codecs = null; // try again next time rather than failing every request
    });
  }
  return codecs;
}

const done = new Map<string, string | null>();
const KEEP = 256;

/** The picture as PNG (base64), or null when it cannot be decoded. Kept per picture. */
export async function webpToPng(base64: string): Promise<string | null> {
  const key = createHash("sha1").update(base64).digest("hex");
  if (done.has(key)) return done.get(key)!;
  let out: string | null = null;
  try {
    const { decode, encode } = await loadCodecs();
    const bytes = Buffer.from(base64, "base64");
    const image = await decode(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer);
    const png = encode({
      width: image.width,
      height: image.height,
      data: new Uint8Array(image.data.buffer, image.data.byteOffset, image.data.byteLength),
      channels: 4,
      depth: 8,
    });
    out = Buffer.from(png).toString("base64");
  } catch {
    out = null;
  }
  if (done.size >= KEEP) done.delete(done.keys().next().value as string);
  done.set(key, out);
  return out;
}

/** An image part as PNG; a WebP that cannot be decoded becomes a one-line note. */
export async function pngPart<P extends ImagePart>(part: P): Promise<P | { type: "text"; text: string }> {
  if (!isWebp(part) || typeof part.data !== "string") return part;
  const png = await webpToPng(part.data);
  return png ? { ...part, mimeType: "image/png", data: png } : { type: "text", text: UNREADABLE_WEBP };
}

/** Every WebP image in the messages as PNG. Null when there is none. */
export async function convertWebpImages<M>(messages: M[]): Promise<{ messages: M[]; converted: number } | null> {
  let converted = 0;
  const out: M[] = [];
  for (const msg of messages) {
    const content = (msg as { content?: unknown })?.content;
    if (!Array.isArray(content) || !content.some((p) => isImage(p) && isWebp(p))) {
      out.push(msg);
      continue;
    }
    const parts = [];
    for (const part of content) {
      if (isImage(part) && isWebp(part)) {
        converted++;
        parts.push(await pngPart(part));
      } else {
        parts.push(part);
      }
    }
    out.push({ ...msg, content: parts } as M);
  }
  return converted ? { messages: out, converted } : null;
}
