/** A user-visible acceptance flow the agent must prove with a runnable test file. */
export interface ScenarioDefinition {
  id: string;
  title: string;
  /** Given / when / then steps in plain language. */
  steps: string;
  /** Relative path to the test the agent creates (Playwright spec, pytest, etc.). */
  testFile: string;
  /** Selects the runner from config (web = Playwright, api = pytest, script = shell). */
  kind: "web" | "api" | "script";
}

export interface ScenarioCheckResult {
  scenarioId: string;
  title: string;
  testFile: string;
  kind: string;
  status: "pass" | "fail" | "skip";
  output: string;
  reason?: string;
  screenshots?: string[];
}

export interface ScenariosRunResult {
  ran: boolean;
  failed: boolean;
  missingFiles: string[];
  checks: ScenarioCheckResult[];
  /** Failure screenshots collected from web scenario runs. */
  screenshots?: string[];
  /** Screenshots written under .pi/scenarios/output/ during the run. */
  outputScreenshots?: string[];
  /** Non-fatal warnings (e.g. stale Flutter build). */
  preflightWarnings?: string[];
  /** Weak/forbidden patterns in specs that passed Playwright (static audit). */
  weakSpecWarnings?: import("./spec-audit").SpecPatternWarning[];
}
