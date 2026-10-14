import type { ResearchConfig } from "./config";
import { resolveApiKey } from "./config";

export interface SearchResult {
  title: string;
  link: string;
  snippet: string;
  age?: string;
  content?: string;
}

export interface SearchOptions {
  maxResults?: number;
  includeContent?: boolean;
  country?: string;
  freshness?: string;
}

const ENTITIES: Record<string, string> = { nbsp: " ", amp: "&", lt: "<", gt: ">", quot: '"', "#39": "'", apos: "'" };

/**
 * Readable text from HTML. Prefers the page's <main>/<article> so navigation, cookie
 * banners and footers do not eat the character budget, and keeps line structure and
 * headings — one giant run-on line is hard for a small model to skim.
 */
export function htmlToText(html: string, maxChars: number): string {
  const main = /<main[\s>][\s\S]*?<\/main>/i.exec(html)?.[0] ?? /<article[\s>][\s\S]*?<\/article>/i.exec(html)?.[0] ?? html;
  const text = main
    .replace(/<(script|style|noscript|svg|nav|header|footer|aside|form)[\s>][\s\S]*?<\/\1>/gi, " ")
    .replace(/<h([1-4])[^>]*>/gi, (_m, n: string) => `\n${"#".repeat(Number(n))} `)
    .replace(/<li[^>]*>/gi, "\n- ")
    .replace(/<(br|\/p|\/div|\/h[1-6]|\/li|\/tr|\/pre|\/section|\/table)[^>]*>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&(#?\w+);/g, (m, name: string) => ENTITIES[name.toLowerCase()] ?? m)
    .split("\n")
    .map((line) => line.replace(/[ \t]+/g, " ").trim())
    .filter((line, i, lines) => line.length > 0 || (i > 0 && lines[i - 1]!.length > 0))
    .join("\n")
    .trim();
  return text.length > maxChars ? `${text.slice(0, maxChars)}…` : text;
}

/** Tool abort (Esc) AND a timeout — `signal ?? timeout` dropped the timeout whenever a signal existed. */
function withTimeout(signal: AbortSignal | undefined, ms: number): AbortSignal {
  const timeout = AbortSignal.timeout(ms);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

export async function fetchPageContent(
  url: string,
  config: ResearchConfig,
  signal?: AbortSignal,
  maxChars: number = config.maxPageChars,
): Promise<string> {
  const response = await fetch(url, {
    headers: {
      "User-Agent": "Mozilla/5.0 (compatible; pi-client-research/1.0)",
      Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    },
    signal: withTimeout(signal, config.fetchTimeoutMs),
  });

  if (!response.ok) {
    return `(HTTP ${response.status} ${response.statusText})`;
  }

  const contentType = response.headers.get("content-type") ?? "";
  if (!contentType.includes("html") && !contentType.includes("text")) {
    return `(Non-HTML content-type: ${contentType})`;
  }

  const body = await response.text();
  const text = contentType.includes("html") ? htmlToText(body, maxChars) : body.slice(0, maxChars);
  return text.length > 0 ? text : "(Could not extract readable text)";
}

export async function braveWebSearch(
  query: string,
  config: ResearchConfig,
  options: SearchOptions = {},
  signal?: AbortSignal,
): Promise<SearchResult[]> {
  const apiKey = resolveApiKey(config);
  if (!apiKey) {
    throw new Error("NO_API_KEY");
  }

  const maxResults = Math.min(Math.max(options.maxResults ?? config.maxResults, 1), 20);
  const params = new URLSearchParams({
    q: query,
    count: String(maxResults),
    country: (options.country ?? config.defaultCountry).toUpperCase(),
  });
  if (options.freshness) params.append("freshness", options.freshness);

  const response = await fetch(`https://api.search.brave.com/res/v1/web/search?${params.toString()}`, {
    headers: {
      Accept: "application/json",
      "Accept-Encoding": "gzip",
      "X-Subscription-Token": apiKey,
    },
    signal: withTimeout(signal, config.fetchTimeoutMs),
  });

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    if (response.status === 401 || response.status === 403) {
      throw new Error("INVALID_API_KEY");
    }
    throw new Error(`Brave Search HTTP ${response.status}: ${body || response.statusText}`);
  }

  const data = (await response.json()) as {
    web?: { results?: Array<{ title?: string; url?: string; description?: string; age?: string; page_age?: string }> };
  };

  const results: SearchResult[] = [];
  for (const row of data.web?.results ?? []) {
    if (results.length >= maxResults) break;
    results.push({
      title: row.title ?? "",
      link: row.url ?? "",
      snippet: row.description ?? "",
      age: row.age ?? row.page_age ?? "",
    });
  }

  // Page text only for the top few results, fetched in parallel: five full pages per
  // search used to cost ~25k characters of a small model's context.
  const includeContent = options.includeContent ?? config.includeContentDefault;
  if (includeContent) {
    const top = results.slice(0, Math.max(0, config.contentResults)).filter((r) => r.link);
    await Promise.all(
      top.map(async (result) => {
        try {
          result.content = await fetchPageContent(result.link, config, signal, config.maxContentChars);
        } catch (e: unknown) {
          result.content = `(Error fetching page: ${(e as Error).message ?? "unknown"})`;
        }
      }),
    );
  }

  return results;
}

export function formatSearchResults(results: SearchResult[]): string {
  if (results.length === 0) return "No results found.";
  const blocks: string[] = [];
  for (let i = 0; i < results.length; i++) {
    const r = results[i];
    const lines = [`--- Result ${i + 1} ---`, `Title: ${r.title}`, `Link: ${r.link}`];
    if (r.age) lines.push(`Age: ${r.age}`);
    lines.push(`Snippet: ${r.snippet}`);
    if (r.content) lines.push(`Content:\n${r.content}`);
    blocks.push(lines.join("\n"));
  }
  return blocks.join("\n\n");
}

export const SETUP_HELP = `Web research (Brave Search) is not configured yet.

1. Create a free API key: https://api-dashboard.search.brave.com/register
   (Free "Search" plan — card required, not charged on free tier.)
2. In Pi, run:  /research key YOUR_API_KEY_HERE
   Saves to ~/.pi/research.config.json on this PC (not committed to git.)
3. Or set env var BRAVE_API_KEY (overrides the saved key.)
4. Check:  /research status

Then the agent can call web_search and fetch_web_page.`;

export function formatKeyError(kind: "missing" | "invalid"): string {
  if (kind === "missing") return SETUP_HELP;
  return `Brave API key was rejected (401/403). Run /research key with a new key from https://api-dashboard.search.brave.com/app/keys\n\n${SETUP_HELP}`;
}
