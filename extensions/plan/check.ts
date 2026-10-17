import { checkBlueprint, readBlueprint, servesOf, type ParsedBlueprint } from "./blueprint";
import type { PlanConfig } from "./config";
import { checkSources, readPoints, readSources } from "./sources";
import { checkExperience, parseExperience } from "./walkthrough";
import { rereadProblems } from "./reread";

export interface PlanCheck {
  /** Null when there is no blueprint yet. */
  parsed: ParsedBlueprint | null;
  problems: string[];
  /** For the approval dialog and reports. */
  coverage: { points: number; served: number; notCovered: number; sources: number };
}

/** The blueprint's shape plus its link to the sources: points quoted verbatim, all accounted for. */
export function checkPlan(cwd: string, config: PlanConfig): PlanCheck {
  const bp = readBlueprint(cwd, config.blueprintPath);
  if (!bp) return { parsed: null, problems: [`No blueprint at ${config.blueprintPath} yet.`], coverage: { points: 0, served: 0, notCovered: 0, sources: 0 } };
  const served = new Set(bp.parsed.items.flatMap(servesOf));
  const sources = checkSources(cwd, config.blueprintPath, served, bp.parsed.notCovered);
  const points = readPoints(cwd, config.blueprintPath)?.points ?? [];
  const experience = checkExperience(bp.parsed, parseExperience(bp.text), new Set(points.map((p) => p.id)));
  return {
    parsed: bp.parsed,
    problems: [...checkBlueprint(bp.parsed), ...experience, ...sources.problems, ...(sources.problems.length ? [] : rereadProblems(cwd, config))],
    coverage: {
      points: points.length,
      served: points.filter((p) => served.has(p.id)).length,
      notCovered: points.filter((p) => bp.parsed.notCovered.has(p.id) && !served.has(p.id)).length,
      sources: readSources(cwd, config.blueprintPath).length,
    },
  };
}

export function formatCoverage(c: PlanCheck["coverage"]): string {
  if (c.points === 0) return `${c.sources} source(s), no points yet`;
  return `${c.points} source points: ${c.served} served, ${c.notCovered} not covered`;
}
