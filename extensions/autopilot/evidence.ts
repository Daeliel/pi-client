import * as path from "node:path";
import { loadConfig as loadScenariosConfig } from "../scenarios/config";
import { formatReport, runScenarios } from "../scenarios/engine";
import type { ScenarioDefinition } from "../scenarios/types";
import { loadConfig as loadVerifyConfig } from "../verify/config";
import { formatReport as formatVerifyReport, verify } from "../verify/engine";
import { clipMiddle } from "../shared/output";
import type { BlueprintItem } from "../plan/blueprint";

export interface ProofResult {
  ok: boolean;
  /** Only the user can confirm it — never auto-done. */
  manual?: boolean;
  /** What to show the model when it failed. */
  report: string;
}

/** Spec paths in `proves:` may be bare file names; those live in the scenarios dir. */
export function resolveSpecPath(cwd: string, proves: string): string {
  if (/[\\/]/.test(proves)) return proves.replace(/\\/g, "/");
  return path.posix.join(loadScenariosConfig(cwd).scenariosDir.replace(/\\/g, "/"), proves);
}

function kindFor(file: string): ScenarioDefinition["kind"] {
  return /\.test\.py$/i.test(file) ? "api" : "web";
}

/**
 * Check one item's evidence: its spec passes (with the scenarios auditor's weak-proof
 * rules), or the verify suite passes. The model's word is never evidence.
 */
export async function proveItem(
  cwd: string,
  item: BlueprintItem,
  signal?: AbortSignal,
  onStep?: (text: string) => void,
): Promise<ProofResult> {
  const proves = item.proves.trim();
  if (!proves || /^manual$/i.test(proves)) {
    return { ok: false, manual: true, report: `${item.id} is proved manually — the user confirms it.` };
  }

  if (/^verify$/i.test(proves)) {
    onStep?.(`verify suite for ${item.id}`);
    const result = await verify(cwd, [], loadVerifyConfig(cwd), undefined, signal, (label) => onStep?.(label));
    if (!result.ran) {
      return { ok: false, report: `${item.id}: \`proves: verify\` but the verify suite ran no checks here — prove it with a spec instead.` };
    }
    return { ok: !result.failed, report: clipMiddle(formatVerifyReport(result), 4000) };
  }

  const testFile = resolveSpecPath(cwd, proves);
  const scenario: ScenarioDefinition = {
    id: item.id.toLowerCase(),
    title: `${item.id} ${item.title}`.slice(0, 120),
    steps: item.title,
    testFile,
    kind: kindFor(testFile),
  };
  onStep?.(`${item.id}: ${path.posix.basename(testFile)}`);
  const config = loadScenariosConfig(cwd);
  const result = await runScenarios(cwd, [scenario], config, signal);
  return { ok: !result.failed, report: formatReport(result, [scenario]) };
}
