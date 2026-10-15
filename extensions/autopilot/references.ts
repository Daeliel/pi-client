import * as fs from "node:fs";
import * as path from "node:path";
import type { ResearchConfig } from "../research/config";
import { resolveApiKey } from "../research/config";

/**
 * Reference images for a blueprint. Autopilot brings no search account of its own:
 * an image-search tool already in the session comes first (the model uses it and saves
 * results here), then the research extension's Brave key, if its plan covers images.
 * Saved images are reference only — kept local, never copied into the app.
 */

export interface ImageHit {
  title: string;
  /** Full image URL. */
  imageUrl: string;
  /** Page the image is on. */
  pageUrl: string;
}

const IMAGE_EXT: Record<string, string> = {
  "image/png": ".png",
  "image/jpeg": ".jpg",
  "image/webp": ".webp",
  "image/gif": ".gif",
};
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;

export async function braveImageSearch(
  query: string,
  count: number,
  config: ResearchConfig,
  signal?: AbortSignal,
): Promise<ImageHit[]> {
  const key = resolveApiKey(config);
  if (!key) throw new Error("NO_API_KEY");
  const params = new URLSearchParams({ q: query, count: String(Math.min(Math.max(count, 1), 20)) });
  const response = await fetch(`https://api.search.brave.com/res/v1/images/search?${params.toString()}`, {
    headers: { Accept: "application/json", "X-Subscription-Token": key },
    signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(config.fetchTimeoutMs)]) : AbortSignal.timeout(config.fetchTimeoutMs),
  });
  if (response.status === 401 || response.status === 403 || response.status === 422) {
    // Brave answers 422 when the key's plan does not include the images endpoint.
    throw new Error("NO_IMAGE_PLAN");
  }
  if (!response.ok) throw new Error(`Brave image search HTTP ${response.status}`);
  const data = (await response.json()) as {
    results?: Array<{ title?: string; url?: string; properties?: { url?: string }; thumbnail?: { src?: string } }>;
  };
  return (data.results ?? [])
    .map((r) => ({ title: r.title ?? "", imageUrl: r.properties?.url ?? r.thumbnail?.src ?? "", pageUrl: r.url ?? "" }))
    .filter((r) => r.imageUrl);
}

function uniqueName(dir: string, base: string, ext: string): string {
  const stem = base.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48) || "ref";
  let name = `${stem}${ext}`;
  for (let n = 2; fs.existsSync(path.join(dir, name)); n++) name = `${stem}-${n}${ext}`;
  return name;
}

export interface SavedRef {
  /** Path relative to cwd, posix. */
  file: string;
  source: string;
}

/** Download an image URL, or copy a local image, into the refs dir. */
export async function saveReference(
  cwd: string,
  refsDir: string,
  source: string,
  name: string,
  signal?: AbortSignal,
): Promise<SavedRef> {
  const dir = path.resolve(cwd, refsDir);
  fs.mkdirSync(dir, { recursive: true });

  if (/^https?:\/\//i.test(source)) {
    const response = await fetch(source, { signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(20_000)]) : AbortSignal.timeout(20_000) });
    if (!response.ok) throw new Error(`download failed: HTTP ${response.status}`);
    const type = (response.headers.get("content-type") ?? "").split(";")[0]!.trim().toLowerCase();
    const ext = IMAGE_EXT[type];
    if (!ext) throw new Error(`not a supported image (content-type ${type || "unknown"})`);
    const buf = Buffer.from(await response.arrayBuffer());
    if (buf.length > MAX_IMAGE_BYTES) throw new Error("image is larger than 8 MB");
    const file = path.join(dir, uniqueName(dir, name, ext));
    fs.writeFileSync(file, buf);
    return { file: path.relative(cwd, file).replace(/\\/g, "/"), source };
  }

  const abs = path.resolve(cwd, source);
  if (!fs.existsSync(abs)) throw new Error(`no such file: ${source}`);
  const ext = path.extname(abs).toLowerCase();
  if (!Object.values(IMAGE_EXT).includes(ext === ".jpeg" ? ".jpg" : ext)) throw new Error(`not an image file: ${source}`);
  if (fs.statSync(abs).size > MAX_IMAGE_BYTES) throw new Error("image is larger than 8 MB");
  // Already inside the refs dir: keep it where it is.
  if (path.dirname(abs) === dir) return { file: path.relative(cwd, abs).replace(/\\/g, "/"), source };
  const file = path.join(dir, uniqueName(dir, name || path.basename(abs, ext), ext));
  fs.copyFileSync(abs, file);
  return { file: path.relative(cwd, file).replace(/\\/g, "/"), source: path.relative(cwd, abs).replace(/\\/g, "/") };
}

/** Image files a blueprint item's REF entries point at, for re-attaching while it is built. */
export function refImagesFor(cwd: string, blueprintText: string, itemId: string): string[] {
  const out: string[] = [];
  for (const line of blueprintText.split(/\r?\n/)) {
    if (!/\*\*REF-\d+\*\*/.test(line)) continue;
    if (!new RegExp(`\\b${itemId}\\b`).test(line)) continue;
    const m = line.match(/([\w./\\-]+\.(?:png|jpe?g|webp|gif))/i);
    if (!m) continue;
    const rel = m[1]!;
    const candidates = [path.resolve(cwd, rel), path.resolve(cwd, ".pi/blueprint", rel)];
    const hit = candidates.find((c) => fs.existsSync(c));
    if (hit && !out.includes(hit)) out.push(hit);
  }
  return out;
}
