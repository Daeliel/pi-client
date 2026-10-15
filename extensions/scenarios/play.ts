import { spawn, type ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import type { ScenariosConfig } from "./config";
import { resolvePlaywrightCli } from "./playwright-cli";
import { killTree } from "../shared/run-command";

/**
 * Play mode: the model uses the app like a user — move, click, press, type — one step
 * at a time, and sees a screenshot after every step. It runs in the same Playwright
 * browser and config as the specs (webServer, baseURL, viewport), so what it finds
 * carries over: play_save_spec turns the path it took into a spec.
 *
 * A long-lived Playwright test (__play-session.spec.ts) takes commands through files in
 * .pi/play/ (Playwright workers do not get stdin): cmd-N.json in, res-N.json + shot-N.png out.
 * Exploring only — proof is still a spec passing run_scenarios.
 */

export const PLAY_SPEC = ".pi/scenarios/__play-session.spec.ts";
export const PLAY_DIR = ".pi/play";

export type PlayAction =
  | { do: "click"; x?: number; y?: number; selector?: string; text?: string; button?: "left" | "right"; double?: boolean }
  | { do: "move"; x: number; y: number }
  | { do: "drag"; x: number; y: number; toX: number; toY: number }
  | { do: "press"; key: string }
  | { do: "hold"; key: string; ms: number }
  | { do: "type"; text: string }
  | { do: "wheel"; dx?: number; dy: number }
  | { do: "wait"; ms: number }
  | { do: "goto"; url: string };

export interface StepResult {
  ok: boolean;
  error?: string;
  shot: string;
  url: string;
  title: string;
  consoleErrors: string[];
  viewport: { width: number; height: number } | null;
}

/** The session spec. Runs actions it is handed and screenshots after each step. */
export const PLAY_SPEC_TEMPLATE = `// pi-client play session — generated, rewritten on every start. Not a test.
import { test, type Page } from "@playwright/test";
import * as fs from "node:fs";
import * as path from "node:path";

async function act(page: Page, a: any): Promise<void> {
  switch (a.do) {
    case "click": {
      const opts = { button: a.button ?? "left", clickCount: a.double ? 2 : 1 } as const;
      if (a.selector) return page.locator(a.selector).first().click(opts);
      if (a.text) return page.getByText(a.text).first().click(opts);
      return page.mouse.click(a.x, a.y, opts);
    }
    case "move": return page.mouse.move(a.x, a.y, { steps: 5 });
    case "drag":
      await page.mouse.move(a.x, a.y);
      await page.mouse.down();
      await page.mouse.move(a.toX, a.toY, { steps: 10 });
      return page.mouse.up();
    case "press": return page.keyboard.press(a.key);
    case "hold":
      await page.keyboard.down(a.key);
      await page.waitForTimeout(a.ms);
      return page.keyboard.up(a.key);
    case "type": return page.keyboard.type(a.text, { delay: 20 });
    case "wheel": return page.mouse.wheel(a.dx ?? 0, a.dy);
    case "wait": return page.waitForTimeout(a.ms);
    case "goto": { await page.goto(a.url); return; }
    default: throw new Error("unknown action " + JSON.stringify(a));
  }
}

test("pi play session", async ({ page }) => {
  test.setTimeout(0);
  const dir = process.env.PI_PLAY_DIR!;
  const errors: string[] = [];
  page.on("console", (m) => { if (m.type() === "error") errors.push(m.text().slice(0, 300)); });
  page.on("pageerror", (e) => errors.push(String(e).slice(0, 300)));
  const write = (name: string, data: unknown) => {
    fs.writeFileSync(path.join(dir, name + ".tmp"), JSON.stringify(data));
    fs.renameSync(path.join(dir, name + ".tmp"), path.join(dir, name));
  };
  const snap = async (n: number, ok: boolean, error?: string) => {
    const shot = path.join(dir, "shot-" + n + ".png");
    await page.screenshot({ path: shot });
    write("res-" + n + ".json", { ok, error, shot, url: page.url(), title: await page.title().catch(() => ""), consoleErrors: errors.splice(0), viewport: page.viewportSize() });
  };
  try {
    await page.goto(process.env.PI_PLAY_URL || "/");
    await page.waitForTimeout(500);
    await snap(0, true);
  } catch (e: any) {
    write("res-0.json", { ok: false, error: String(e?.message ?? e), shot: "", url: page.url(), title: "", consoleErrors: errors.splice(0), viewport: page.viewportSize() });
    return;
  }
  for (let n = 1; ; n++) {
    const cmd = path.join(dir, "cmd-" + n + ".json");
    while (!fs.existsSync(cmd)) {
      if (fs.existsSync(path.join(dir, "stop"))) return;
      await page.waitForTimeout(100);
    }
    const { actions, settleMs } = JSON.parse(fs.readFileSync(cmd, "utf8"));
    let ok = true;
    let error: string | undefined;
    for (const a of actions) {
      try { await act(page, a); } catch (e: any) { ok = false; error = String(e?.message ?? e).split("\\n")[0]; break; }
    }
    await page.waitForTimeout(settleMs ?? 300);
    await snap(n, ok, error);
  }
});
`;

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

async function waitForFile(file: string, ms: number, alive: () => boolean, signal?: AbortSignal): Promise<boolean> {
  const until = Date.now() + ms;
  while (!fs.existsSync(file)) {
    if (Date.now() > until || !alive() || signal?.aborted) return false;
    await sleep(100);
  }
  return true;
}

export class PlaySession {
  private child: ChildProcess | null = null;
  private output = "";
  private step = 0;
  /** Steps that worked, in order — what play_save_spec writes. */
  readonly recorded: Array<{ actions: PlayAction[]; settleMs: number }> = [];
  startUrl = "/";

  constructor(
    private readonly cwd: string,
    private readonly config: ScenariosConfig,
  ) {}

  get running(): boolean {
    return this.child !== null && this.child.exitCode === null;
  }

  get steps(): number {
    return this.step;
  }

  private dir(): string {
    return path.join(this.cwd, PLAY_DIR);
  }

  /** Launch the session at `url` and return the first screenshot. */
  async start(url: string, signal?: AbortSignal): Promise<StepResult> {
    this.stop();
    const dir = this.dir();
    fs.rmSync(dir, { recursive: true, force: true });
    fs.mkdirSync(dir, { recursive: true });
    const spec = path.join(this.cwd, PLAY_SPEC);
    fs.mkdirSync(path.dirname(spec), { recursive: true });
    fs.writeFileSync(spec, PLAY_SPEC_TEMPLATE, "utf8");

    const pw = await resolvePlaywrightCli(this.cwd);
    const cmd = `${pw} test "${PLAY_SPEC}" --config "${this.config.playwrightConfig}" --workers 1 --retries 0 --timeout 0 --reporter line`;
    this.output = "";
    this.step = 0;
    this.recorded.length = 0;
    this.startUrl = url;
    const child = spawn(cmd, {
      cwd: this.cwd,
      env: { ...process.env, PI_PLAY_DIR: dir, PI_PLAY_URL: url },
      shell: true,
      windowsHide: true,
      detached: process.platform !== "win32",
    });
    const collect = (b: Buffer) => {
      this.output = (this.output + b.toString("utf8")).slice(-6000);
    };
    child.stdout?.on("data", collect);
    child.stderr?.on("data", collect);
    this.child = child;

    // First screenshot means: webServer up, page loaded. Allow for a slow dev server.
    const ok = await waitForFile(path.join(dir, "res-0.json"), Math.max(this.config.timeoutMs, 60_000), () => this.running, signal);
    if (!ok) {
      const why = signal?.aborted ? "aborted" : this.running ? "timed out starting the app/browser" : "Playwright exited";
      this.stop();
      throw new Error(`${why}.\n${this.output.trim().slice(-2000)}`);
    }
    const res = this.read(0);
    if (!res.ok) {
      this.stop();
      throw new Error(`could not open ${url}: ${res.error}`);
    }
    return res;
  }

  /** Run actions as one step; returns the screenshot after them. */
  async run(actions: PlayAction[], settleMs: number, signal?: AbortSignal): Promise<StepResult> {
    if (!this.running) throw new Error("no play session");
    const n = ++this.step;
    const dir = this.dir();
    fs.writeFileSync(path.join(dir, `cmd-${n}.json.tmp`), JSON.stringify({ actions, settleMs }));
    fs.renameSync(path.join(dir, `cmd-${n}.json.tmp`), path.join(dir, `cmd-${n}.json`));
    const waitMs = 30_000 + actions.reduce((t, a) => t + ("ms" in a && typeof a.ms === "number" ? a.ms : 0), 0);
    const ok = await waitForFile(path.join(dir, `res-${n}.json`), waitMs, () => this.running, signal);
    if (!ok) {
      const why = signal?.aborted ? "aborted" : this.running ? "step timed out" : "the play session ended";
      if (!signal?.aborted) this.stop();
      throw new Error(`${why}.\n${this.output.trim().slice(-1500)}`);
    }
    const res = this.read(n);
    if (res.ok) this.recorded.push({ actions, settleMs });
    return res;
  }

  private read(n: number): StepResult {
    return JSON.parse(fs.readFileSync(path.join(this.dir(), `res-${n}.json`), "utf8")) as StepResult;
  }

  stop(): void {
    if (!this.child) return;
    try {
      fs.writeFileSync(path.join(this.dir(), "stop"), "");
    } catch {
      /* dir gone */
    }
    const child = this.child;
    this.child = null;
    // Give it a moment to end the test cleanly, then make sure the tree is gone.
    setTimeout(() => killTree(child), 1500).unref();
  }
}

// ---------- validation ----------

const KEY_RE = /^[\w+\- ]{1,40}$/;

/** Check an action list; returns a problem to report, or null. */
export function validateActions(actions: PlayAction[]): string | null {
  if (actions.length === 0) return "give at least one action";
  if (actions.length > 12) return "at most 12 actions per step — look at the screenshot between steps";
  for (const [i, a] of actions.entries()) {
    const at = `action ${i + 1} (${a.do})`;
    const num = (v: unknown) => typeof v === "number" && Number.isFinite(v);
    switch (a.do) {
      case "click":
        if (!a.selector && !a.text && !(num(a.x) && num(a.y))) return `${at}: needs x and y, a selector, or text`;
        break;
      case "move":
        if (!num(a.x) || !num(a.y)) return `${at}: needs x and y`;
        break;
      case "drag":
        if (![a.x, a.y, a.toX, a.toY].every(num)) return `${at}: needs x, y, toX, toY`;
        break;
      case "press":
      case "hold":
        if (!a.key || !KEY_RE.test(a.key)) return `${at}: key like "E", "ArrowLeft", "Space", "Control+Z"`;
        if (a.do === "hold" && (!num(a.ms) || a.ms <= 0 || a.ms > 10_000)) return `${at}: ms between 1 and 10000`;
        break;
      case "type":
        if (typeof a.text !== "string" || !a.text) return `${at}: needs text`;
        break;
      case "wheel":
        if (!num(a.dy)) return `${at}: needs dy`;
        break;
      case "wait":
        if (!num(a.ms) || a.ms <= 0 || a.ms > 10_000) return `${at}: ms between 1 and 10000`;
        break;
      case "goto":
        if (typeof a.url !== "string" || !a.url) return `${at}: needs url`;
        break;
      default:
        return `${at}: unknown — use click, move, drag, press, hold, type, wheel, wait, goto`;
    }
  }
  return null;
}

// ---------- recording → spec ----------

function lit(s: string): string {
  return JSON.stringify(s);
}

function actionLine(a: PlayAction): string[] {
  switch (a.do) {
    case "click": {
      const opts = [a.button && a.button !== "left" ? `button: ${lit(a.button)}` : "", a.double ? "clickCount: 2" : ""].filter(Boolean);
      const o = opts.length ? `{ ${opts.join(", ")} }` : "";
      if (a.selector) return [`await page.locator(${lit(a.selector)}).first().click(${o});`];
      if (a.text) return [`await page.getByText(${lit(a.text)}).first().click(${o});`];
      return [`await page.mouse.click(${a.x}, ${a.y}${o ? `, ${o}` : ""});`];
    }
    case "move":
      return [`await page.mouse.move(${a.x}, ${a.y}, { steps: 5 });`];
    case "drag":
      return [
        `await page.mouse.move(${a.x}, ${a.y});`,
        "await page.mouse.down();",
        `await page.mouse.move(${a.toX}, ${a.toY}, { steps: 10 });`,
        "await page.mouse.up();",
      ];
    case "press":
      return [`await page.keyboard.press(${lit(a.key)});`];
    case "hold":
      return [`await page.keyboard.down(${lit(a.key)});`, `await page.waitForTimeout(${a.ms});`, `await page.keyboard.up(${lit(a.key)});`];
    case "type":
      return [`await page.keyboard.type(${lit(a.text)}, { delay: 20 });`];
    case "wheel":
      return [`await page.mouse.wheel(${a.dx ?? 0}, ${a.dy});`];
    case "wait":
      return [`await page.waitForTimeout(${a.ms});`];
    case "goto":
      return [`await page.goto(${lit(a.url)});`];
  }
}

/** A spec that replays the recorded path, screenshots where it ends, and leaves the assertions to write. */
export function buildSpecFromRecording(opts: {
  name: string;
  title: string;
  startUrl: string;
  steps: Array<{ actions: PlayAction[]; settleMs: number }>;
  hasConsoleHelper: boolean;
}): string {
  const body: string[] = [];
  if (opts.hasConsoleHelper) body.push("const consoleCapture = attachConsoleCapture(page);");
  body.push(`await page.goto(${lit(opts.startUrl)});`, "await page.waitForTimeout(500);");
  opts.steps.forEach((s, i) => {
    body.push("", `// step ${i + 1}`);
    for (const a of s.actions) body.push(...actionLine(a));
    body.push(`await page.waitForTimeout(${s.settleMs});`);
  });
  body.push(
    "",
    `await page.screenshot({ path: ${lit(`.pi/scenarios/output/${opts.name}-end.png`)} });`,
    "// TODO: assert what this path proves — on the screen it ends on (a readable value, visible text, or the screenshot reviewed).",
  );
  if (opts.hasConsoleHelper) body.push("consoleCapture.assertClean();");
  const imports = [`import { test, expect } from "@playwright/test";`];
  if (opts.hasConsoleHelper) imports.push(`import { attachConsoleCapture } from "./helpers/console-capture";`);
  return `// @covers: TODO — the source paths this flow proves
// Recorded with play mode: add the assertions before trusting it.
${imports.join("\n")}

test(${lit(opts.title)}, async ({ page }) => {
${body.map((l) => (l ? `  ${l}` : "")).join("\n")}
});
`;
}
