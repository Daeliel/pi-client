import * as fs from "node:fs";
import * as path from "node:path";
import type { ScenariosConfig } from "./config";
import type { ScenarioDefinition } from "./types";
import { ensureScenariosDir, ensureWebScaffold, ensurePlaywrightProjectDeps } from "./engine";
import {
  defaultTestFile,
  renderScaffoldContent,
  type ScaffoldParams,
  type ScaffoldTemplate,
} from "./scaffold-content";

export type { ScaffoldParams, ScaffoldTemplate };
export { renderScaffoldContent, defaultTestFile, slugId } from "./scaffold-content";

export interface ScaffoldResult {
  ok: boolean;
  scenario: ScenarioDefinition;
  testFile: string;
  created: boolean;
  scaffolded: string[];
  pwInstallNote: string | null;
  message: string;
}

/**
 * Optional helper: write a thin starter spec (never overwrites an existing test file).
 * Freeform specs remain the normal path when the model writes good tests itself.
 */
export async function scaffoldScenario(
  cwd: string,
  config: ScenariosConfig,
  params: ScaffoldParams,
): Promise<ScaffoldResult> {
  const id = params.id.trim();
  const title = params.title.trim();
  const steps = params.steps.trim();
  if (!id || !title || !steps) {
    return {
      ok: false,
      scenario: { id, title, steps, testFile: "", kind: "web" },
      testFile: "",
      created: false,
      scaffolded: [],
      pwInstallNote: null,
      message: "id, title, and steps are required.",
    };
  }

  const kind: ScenarioDefinition["kind"] = params.template === "api" ? "api" : "web";
  const testFile =
    params.testFile?.trim() || defaultTestFile(params.template, id, config.scenariosDir);
  const scenario: ScenarioDefinition = { id, title, steps, testFile, kind };

  ensureScenariosDir(cwd, config);
  const scaffolded = ensureWebScaffold(cwd, config, [scenario]);
  const pwInstallNote = kind === "web" ? await ensurePlaywrightProjectDeps(cwd) : null;

  const abs = path.isAbsolute(testFile) ? testFile : path.join(cwd, testFile);
  if (fs.existsSync(abs)) {
    return {
      ok: true,
      scenario,
      testFile,
      created: false,
      scaffolded,
      pwInstallNote,
      message:
        `Test file already exists at ${testFile} — not overwritten. ` +
        `Register with define_scenarios or edit the file. Freeform specs are fine.`,
    };
  }

  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, renderScaffoldContent({ ...params, testFile }), "utf8");

  return {
    ok: true,
    scenario,
    testFile,
    created: true,
    scaffolded,
    pwInstallNote,
    message:
      `Wrote starter ${params.template} spec to ${testFile}. ` +
      `Adapt clicks/asserts for this app, then define_scenarios + run_scenarios. ` +
      `This is optional help — writing your own spec from scratch is also fine.`,
  };
}
