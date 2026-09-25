import type { BrowserConsoleConfig } from "./config";
import type { ConsoleEntry, ConsoleLevel, NetworkFailure, PageTarget, BrowserStatus } from "./types";

const WEB_EXT = /\.(html?|js|mjs|cjs|jsx|ts|tsx|css|vue|svelte)$/i;

export interface FormatReportOptions {
  maxGroups?: number;
  maxChars?: number;
  maxStackLines?: number;
}

function normalizeMessageForFingerprint(message: string): string {
  return message
    .replace(/Instance of 'minified:[^']+'/gi, "Instance of 'minified:*'")
    .replace(/Another exception was thrown:\s*/gi, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 240);
}

function stackTopLine(stack: string | undefined): string {
  if (!stack) return "";
  return stack.split("\n")[0]?.trim() ?? "";
}

/** Group key for collapsing Flutter/minified repeat spam. */
export function consoleFingerprint(entry: Pick<ConsoleEntry, "type" | "message" | "stack" | "source">): string {
  return [
    entry.type,
    entry.source ?? "",
    normalizeMessageForFingerprint(entry.message),
    stackTopLine(entry.stack),
  ].join("|");
}

function entryEventCount(entry: ConsoleEntry): number {
  return entry.repeatCount ?? 1;
}

function truncateStack(stack: string, maxLines: number): string {
  const lines = stack.split("\n");
  if (lines.length <= maxLines) {
    return `\n    ${stack.replace(/\n/g, "\n    ")}`;
  }
  const head = lines.slice(0, maxLines).join("\n    ");
  return `\n    ${head}\n    … (${lines.length - maxLines} more stack frame(s) omitted)`;
}

export function isWebFile(path: string): boolean {
  return WEB_EXT.test(path.replace(/\\/g, "/"));
}

export function urlMatches(url: string, patterns: string[]): boolean {
  if (patterns.length === 0) return true;
  const lower = url.toLowerCase();
  return patterns.some((p) => p.length > 0 && lower.includes(p.toLowerCase()));
}

export function pickPageTarget(pages: PageTarget[], patterns: string[]): PageTarget | null {
  const pageTabs = pages.filter((p) => p.webSocketDebuggerUrl);
  if (pageTabs.length === 0) return null;
  if (patterns.length === 0) return pageTabs[0];
  const matched = pageTabs.find((p) => urlMatches(p.url, patterns));
  return matched ?? pageTabs[0];
}

export function isFailureEntry(entry: ConsoleEntry, includeWarnings: boolean): boolean {
  if (entry.type === "error" || entry.type === "rejection") return true;
  if (includeWarnings && entry.type === "warn") return true;
  return false;
}

export function formatReport(
  entries: ConsoleEntry[],
  header?: string,
  options?: FormatReportOptions,
): string {
  if (entries.length === 0) return header ? `${header}\n(no console issues)` : "(no console issues)";

  const maxGroups = options?.maxGroups ?? 20;
  const maxChars = options?.maxChars ?? 12_000;
  const maxStackLines = options?.maxStackLines ?? 4;

  const totalEvents = entries.reduce((sum, e) => sum + entryEventCount(e), 0);
  const lines: string[] = [];
  let chars = 0;
  let shownEvents = 0;
  let omittedGroups = 0;
  let omittedEvents = 0;

  for (let i = 0; i < entries.length && lines.length < maxGroups; i++) {
    const e = entries[i]!;
    const events = entryEventCount(e);
    const loc = e.url ? ` @ ${e.url}` : "";
    const src = e.source ? ` (${e.source})` : "";
    const repeat =
      events > 1
        ? ` (×${events}${e.lastTimestamp && e.lastTimestamp !== e.timestamp ? `, last ${e.lastTimestamp}` : ""})`
        : "";
    const stack = e.stack ? truncateStack(e.stack, maxStackLines) : "";
    const line = `- [${e.type}] ${e.message}${repeat}${src}${loc}${stack}`;

    if (chars + line.length > maxChars) {
      omittedGroups = entries.length - i;
      omittedEvents = entries.slice(i).reduce((sum, x) => sum + entryEventCount(x), 0);
      break;
    }

    lines.push(line);
    chars += line.length;
    shownEvents += events;
  }

  if (omittedGroups === 0 && entries.length > lines.length) {
    omittedGroups = entries.length - lines.length;
    omittedEvents = entries.slice(lines.length).reduce((sum, x) => sum + entryEventCount(x), 0);
  }

  const prefix = header ? `${header}\n` : "";
  const summary =
    totalEvents > shownEvents || omittedGroups > 0
      ? `\n\nSummary: ${totalEvents} console event(s), ${entries.length} unique — showing ${Math.min(lines.length, entries.length)} group(s) (${shownEvents} event(s)).`
      : "";
  const omitted =
    omittedGroups > 0
      ? `\n… ${omittedGroups} more unique error group(s) (${omittedEvents} event(s) omitted — fix the first error above; repeats often share one root cause).`
      : "";

  return `${prefix}${lines.join("\n")}${summary}${omitted}`;
}

export function formatReportForConfig(
  entries: ConsoleEntry[],
  header: string | undefined,
  config: BrowserConsoleConfig,
): string {
  return formatReport(entries, header, {
    maxGroups: config.maxReportGroups,
    maxChars: config.maxReportChars,
    maxStackLines: config.maxStackLinesInReport,
  });
}

export function formatNetworkReport(failures: NetworkFailure[], header?: string): string {
  if (failures.length === 0) {
    return header ? `${header}\n(no failed network requests)` : "(no failed network requests)";
  }
  const lines = failures.map((f) => {
    const status = f.status !== undefined ? ` HTTP ${f.status}` : "";
    const err = f.errorText ? ` — ${f.errorText}` : "";
    const kind = f.resourceType ? ` (${f.resourceType})` : "";
    return `- ${f.url}${status}${kind}${err}`;
  });
  const prefix = header ? `${header}\n` : "";
  return `${prefix}${lines.join("\n")}`;
}

function isTrackableNetworkUrl(url: string): boolean {
  return /^https?:\/\//i.test(url) && !url.startsWith("chrome-extension://");
}

export function formatStatus(status: BrowserStatus): string {
  if (!status.connected) {
    return "Browser console: not connected. Start Chrome with --remote-debugging-port=9222, open your app, then /browser connect";
  }
  const tab = status.targetTitle ? `${status.targetTitle} — ${status.targetUrl}` : status.targetUrl ?? "tab";
  const uniqueNote =
    status.buffered > 0 && (status.errorCount > status.buffered || status.warningCount > status.buffered)
      ? " (counts include collapsed repeats)"
      : "";
  return (
    `Browser console: connected to ${tab}\n` +
    `  CDP ${status.host}:${status.port} · unique buffered ${status.buffered} · errors ${status.errorCount} · warnings ${status.warningCount} · network failures ${status.networkFailureCount}${uniqueNote}`
  );
}

function formatCdpArg(arg: Record<string, unknown>): string {
  if (arg.type === "string") return String(arg.value ?? "");
  if (arg.type === "number" || arg.type === "boolean") return String(arg.value);
  if (typeof arg.description === "string") return arg.description;
  if (typeof arg.value === "string") return arg.value;
  try {
    return JSON.stringify(arg.value ?? arg.description ?? arg);
  } catch {
    return String(arg.description ?? arg.type ?? "object");
  }
}

function formatStack(stackTrace: Record<string, unknown> | undefined): string | undefined {
  if (!stackTrace) return undefined;
  const frames = stackTrace.callFrames as Array<Record<string, unknown>> | undefined;
  if (!frames?.length) return undefined;
  return frames
    .slice(0, 8)
    .map((f) => {
      const fn = String(f.functionName ?? "<anonymous>");
      const url = String(f.url ?? "");
      const line = f.lineNumber ?? 0;
      const col = f.columnNumber ?? 0;
      return `${fn} (${url}:${line}:${col})`;
    })
    .join("\n");
}

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    if (signal) {
      if (signal.aborted) {
        clearTimeout(t);
        reject(new DOMException("Aborted", "AbortError"));
        return;
      }
      signal.addEventListener(
        "abort",
        () => {
          clearTimeout(t);
          reject(new DOMException("Aborted", "AbortError"));
        },
        { once: true },
      );
    }
  });
}

/** Chrome DevTools Protocol client — buffers console + page errors for pi hooks/tools. */
export class CdpBrowser {
  private ws: WebSocket | null = null;
  private nextId = 1;
  private pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  private buffer: ConsoleEntry[] = [];
  private networkBuffer: NetworkFailure[] = [];
  private pendingRequests = new Map<string, { url: string; type?: string }>();
  private bufferSize = 200;
  private dedupeConsole = true;
  private host = "127.0.0.1";
  private port = 9222;
  private target: PageTarget | null = null;

  get connected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  get targetInfo(): PageTarget | null {
    return this.target;
  }

  setBufferSize(n: number) {
    this.bufferSize = Math.max(20, n);
    while (this.buffer.length > this.bufferSize) this.buffer.shift();
    while (this.networkBuffer.length > this.bufferSize) this.networkBuffer.shift();
  }

  setDedupeConsole(enabled: boolean) {
    this.dedupeConsole = enabled;
  }

  async listPages(host: string, port: number): Promise<PageTarget[]> {
    let res: Response;
    try {
      res = await fetch(`http://${host}:${port}/json/list`);
    } catch (e) {
      const msg = (e as Error).message || "fetch failed";
      throw new Error(
        `Cannot reach Chrome CDP at ${host}:${port} (${msg}). ` +
          `Start Chrome with --remote-debugging-port=${port}, or enable autoLaunchBrowser in browser-console.config.json`,
      );
    }
    if (!res.ok) throw new Error(`CDP list failed (${res.status}): ${res.statusText}`);
    const raw = (await res.json()) as Array<Record<string, unknown>>;
    return raw
      .filter((t) => typeof t.webSocketDebuggerUrl === "string")
      .map((t) => ({
        id: String(t.id ?? ""),
        title: String(t.title ?? ""),
        url: String(t.url ?? ""),
        webSocketDebuggerUrl: String(t.webSocketDebuggerUrl),
      }));
  }

  async connect(config: BrowserConsoleConfig, urlPatterns?: string[]): Promise<PageTarget> {
    await this.disconnect();
    this.host = config.cdpHost;
    this.port = config.cdpPort;
    this.setBufferSize(config.bufferSize);
    this.setDedupeConsole(config.dedupeConsole);

    const pages = await this.listPages(this.host, this.port);
    const target = pickPageTarget(pages, urlPatterns ?? config.urlMatch);
    if (!target) throw new Error(`No debuggable page tabs on ${this.host}:${this.port}`);

    this.target = target;
    this.ws = new WebSocket(target.webSocketDebuggerUrl);

    await new Promise<void>((resolve, reject) => {
      const ws = this.ws!;
      const onOpen = () => {
        cleanup();
        resolve();
      };
      const onError = () => {
        cleanup();
        reject(new Error("WebSocket connection failed"));
      };
      const cleanup = () => {
        ws.removeEventListener("open", onOpen);
        ws.removeEventListener("error", onError);
      };
      ws.addEventListener("open", onOpen);
      ws.addEventListener("error", onError);
    });

    this.ws.onmessage = (ev) => this.onMessage(String(ev.data));
    this.ws.onclose = () => {
      this.ws = null;
    };

    await this.send("Runtime.enable");
    await this.send("Log.enable");
    await this.send("Page.enable");
    await this.send("Network.enable");
    this.networkBuffer = [];

    return target;
  }

  async disconnect(): Promise<void> {
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
    this.target = null;
    this.networkBuffer = [];
    this.pendingRequests.clear();
  }

  async reload(ignoreCache = true): Promise<void> {
    if (!this.connected) throw new Error("Not connected to browser");
    await this.send("Page.reload", { ignoreCache });
  }

  /** Navigate the attached tab to a new URL (keeps the same CDP connection). */
  async navigate(url: string, waitMs = 2000, signal?: AbortSignal): Promise<{ url: string; title: string }> {
    if (!this.connected) throw new Error("Not connected to browser");
    const trimmed = url.trim();
    if (!trimmed) throw new Error("URL is required");

    const result = (await this.send("Page.navigate", { url: trimmed })) as { errorText?: string };
    if (result.errorText) throw new Error(`Navigation failed: ${result.errorText}`);

    if (waitMs > 0) await sleep(waitMs, signal);
    await this.refreshTargetInfo(trimmed);

    return {
      url: this.target?.url ?? trimmed,
      title: this.target?.title ?? "",
    };
  }

  private async refreshTargetInfo(fallbackUrl?: string): Promise<void> {
    if (!this.target) return;
    try {
      const history = (await this.send("Page.getNavigationHistory")) as {
        entries?: Array<{ url?: string; title?: string }>;
        currentIndex?: number;
      };
      const current = history.entries?.[history.currentIndex ?? -1];
      if (current?.url) {
        this.target = {
          ...this.target,
          url: current.url,
          title: current.title ?? this.target.title,
        };
        return;
      }
    } catch {
      // fall through
    }
    if (fallbackUrl) {
      this.target = { ...this.target, url: fallbackUrl };
    }
  }

  async captureScreenshot(options?: { format?: "png" | "jpeg"; quality?: number }): Promise<{ data: string; mimeType: string }> {
    if (!this.connected) throw new Error("Not connected to browser");
    const format = options?.format ?? "jpeg";
    const result = (await this.send("Page.captureScreenshot", {
      format,
      quality: format === "jpeg" ? (options?.quality ?? 80) : undefined,
      fromSurface: true,
    })) as { data?: string };
    if (!result.data) throw new Error("CDP returned no screenshot data");
    return { data: result.data, mimeType: format === "jpeg" ? "image/jpeg" : "image/png" };
  }

  pushEntry(entry: Omit<ConsoleEntry, "id" | "timestamp" | "repeatCount" | "lastTimestamp">) {
    const now = new Date().toISOString();
    if (this.dedupeConsole) {
      const fp = consoleFingerprint(entry);
      for (let i = this.buffer.length - 1; i >= 0; i--) {
        const existing = this.buffer[i]!;
        if (consoleFingerprint(existing) !== fp) continue;
        existing.repeatCount = (existing.repeatCount ?? 1) + 1;
        existing.lastTimestamp = now;
        return;
      }
    }

    const full: ConsoleEntry = {
      ...entry,
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
      timestamp: now,
      repeatCount: 1,
      lastTimestamp: now,
    };
    this.buffer.push(full);
    while (this.buffer.length > this.bufferSize) this.buffer.shift();
  }

  getBuffered(includeWarnings: boolean): ConsoleEntry[] {
    return this.buffer.filter((e) => isFailureEntry(e, includeWarnings));
  }

  getAllBuffered(): ConsoleEntry[] {
    return [...this.buffer];
  }

  clearBuffer() {
    this.buffer = [];
    this.networkBuffer = [];
    this.pendingRequests.clear();
  }

  getNetworkFailures(): NetworkFailure[] {
    return [...this.networkBuffer];
  }

  pushNetworkFailure(entry: Omit<NetworkFailure, "id" | "timestamp">) {
    const full: NetworkFailure = {
      ...entry,
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
      timestamp: new Date().toISOString(),
    };
    this.networkBuffer.push(full);
    while (this.networkBuffer.length > this.bufferSize) this.networkBuffer.shift();
  }

  status(includeWarnings: boolean): BrowserStatus {
    const failures = this.getBuffered(includeWarnings);
    const errors = failures
      .filter((e) => e.type === "error" || e.type === "rejection")
      .reduce((sum, e) => sum + entryEventCount(e), 0);
    const warnings = failures
      .filter((e) => e.type === "warn")
      .reduce((sum, e) => sum + entryEventCount(e), 0);
    return {
      connected: this.connected,
      host: this.connected ? this.host : undefined,
      port: this.connected ? this.port : undefined,
      targetUrl: this.target?.url,
      targetTitle: this.target?.title,
      buffered: this.buffer.length,
      errorCount: errors,
      warningCount: warnings,
      networkFailureCount: this.networkBuffer.length,
    };
  }

  /**
   * Clear the buffers, reload, and wait — so what is buffered afterwards comes from the
   * current code only. Reloading without clearing kept errors the model had already
   * fixed, which made every later check report a bug that no longer existed.
   */
  async reloadFresh(waitMs: number, signal?: AbortSignal): Promise<void> {
    this.clearBuffer();
    await this.reload(true);
    if (waitMs > 0) await sleep(waitMs, signal);
  }

  async checkAfterEdit(config: BrowserConsoleConfig, signal?: AbortSignal): Promise<ConsoleEntry[]> {
    if (!this.connected) return [];
    if (config.autoReloadOnEdit) await this.reloadFresh(config.reloadWaitMs, signal);
    return this.getBuffered(config.includeWarnings);
  }

  private onMessage(raw: string) {
    try {
      const msg = JSON.parse(raw) as Record<string, unknown>;
      if (typeof msg.id === "number" && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id)!;
        this.pending.delete(msg.id);
        if (msg.error) {
          const err = msg.error as Record<string, unknown>;
          reject(new Error(String(err.message ?? "CDP error")));
        } else {
          resolve(msg.result);
        }
        return;
      }
      if (msg.method === "Runtime.consoleAPICalled") {
        this.onConsoleApi(msg.params as Record<string, unknown>);
      } else if (msg.method === "Runtime.exceptionThrown") {
        this.onException(msg.params as Record<string, unknown>);
      } else if (msg.method === "Network.loadingFailed") {
        this.onNetworkLoadingFailed(msg.params as Record<string, unknown>);
      } else if (msg.method === "Network.responseReceived") {
        this.onNetworkResponse(msg.params as Record<string, unknown>);
      } else if (msg.method === "Network.requestWillBeSent") {
        this.onNetworkRequestWillBeSent(msg.params as Record<string, unknown>);
      }
    } catch {
      // ignore malformed frames
    }
  }

  private onConsoleApi(params: Record<string, unknown>) {
    const rawType = String(params.type ?? "log");
    // CDP emits types outside our ConsoleLevel union: "warning" (not "warn"),
    // "assert" (a failed console.assert — treat as error), "trace", "dir", etc.
    const KNOWN: readonly string[] = ["error", "warn", "rejection", "log", "info", "debug"];
    const type: ConsoleLevel =
      rawType === "warning"
        ? "warn"
        : rawType === "assert"
          ? "error"
          : KNOWN.includes(rawType)
            ? (rawType as ConsoleLevel)
            : "log";
    const args = (params.args as Array<Record<string, unknown>> | undefined) ?? [];
    const message = args.map(formatCdpArg).join(" ");
    const stack = formatStack(params.stackTrace as Record<string, unknown> | undefined);
    this.pushEntry({
      type,
      message: message || "(empty console message)",
      stack,
      source: "console",
    });
  }

  private onNetworkRequestWillBeSent(params: Record<string, unknown>) {
    const requestId = String(params.requestId ?? "");
    const request = params.request as Record<string, unknown> | undefined;
    const url = String(request?.url ?? "");
    if (!requestId || !url) return;
    this.pendingRequests.set(requestId, {
      url,
      type: typeof params.type === "string" ? params.type : undefined,
    });
    if (this.pendingRequests.size > this.bufferSize * 2) {
      const first = this.pendingRequests.keys().next().value;
      if (first) this.pendingRequests.delete(first);
    }
  }

  private onNetworkLoadingFailed(params: Record<string, unknown>) {
    const requestId = String(params.requestId ?? "");
    const tracked = requestId ? this.pendingRequests.get(requestId) : undefined;
    const url = tracked?.url ?? "";
    if (!url || !isTrackableNetworkUrl(url)) return;
    if (Boolean(params.canceled)) return;
    this.pushNetworkFailure({
      url,
      errorText: String(params.errorText ?? "loading failed"),
      resourceType: tracked?.type ?? (typeof params.type === "string" ? params.type : undefined),
    });
    if (requestId) this.pendingRequests.delete(requestId);
  }

  private onNetworkResponse(params: Record<string, unknown>) {
    const response = params.response as Record<string, unknown> | undefined;
    if (!response) return;
    const url = String(response.url ?? "");
    const status = typeof response.status === "number" ? response.status : undefined;
    if (!url || !isTrackableNetworkUrl(url) || status === undefined || status < 400) return;
    this.pushNetworkFailure({
      url,
      status,
      resourceType: typeof params.type === "string" ? params.type : undefined,
    });
    const requestId = String(params.requestId ?? "");
    if (requestId) this.pendingRequests.delete(requestId);
  }

  private onException(params: Record<string, unknown>) {
    const details = params.exceptionDetails as Record<string, unknown> | undefined;
    if (!details) return;
    const ex = details.exception as Record<string, unknown> | undefined;
    const message =
      String(details.text ?? "") ||
      String(ex?.description ?? ex?.value ?? "Uncaught exception");
    const stack = formatStack(details.stackTrace as Record<string, unknown> | undefined);
    const url = typeof details.url === "string" ? details.url : undefined;
    const line = details.lineNumber;
    const source =
      url && typeof line === "number" ? `${url}:${line}` : url ? String(url) : "page";
    this.pushEntry({
      type: "rejection",
      message,
      stack,
      source,
      url,
    });
  }

  private send(method: string, params?: Record<string, unknown>): Promise<unknown> {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      return Promise.reject(new Error("CDP socket not open"));
    }
    const id = this.nextId++;
    const payload = JSON.stringify({ id, method, params: params ?? {} });
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws!.send(payload);
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`CDP timeout: ${method}`));
        }
      }, 15000);
    });
  }
}
