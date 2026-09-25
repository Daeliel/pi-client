import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { loadConfig, type ReleaseConfig } from "./config";
import {
  formatBuildReport,
  formatDoctorMessage,
  isFlutterAndroidProject,
  listTargetKeys,
  runReleaseBuild,
  runReleaseDoctor,
} from "./engine";
import { RELEASE_PROCEDURE } from "./procedure";
import { syncOwnedTools } from "../shared/tool-activation";

const TOOLS = ["release_doctor", "release_build"];

export default function (pi: ExtensionAPI) {
  let configCache: ReleaseConfig | null = null;

  function cfg(ctx: ExtensionContext): ReleaseConfig {
    if (!configCache) configCache = loadConfig(ctx.cwd);
    return configCache;
  }

  function reloadConfig(ctx: ExtensionContext): ReleaseConfig {
    configCache = loadConfig(ctx.cwd);
    return configCache;
  }

  // Release tools only exist for the model in a Flutter project with an android/ folder.
  function syncTools(ctx: ExtensionContext) {
    const config = reloadConfig(ctx);
    syncOwnedTools(pi, TOOLS, config.enabled && isFlutterAndroidProject(ctx.cwd) ? TOOLS : []);
  }

  pi.on("session_start", async (_event, ctx) => syncTools(ctx));
  pi.on("input", async (_event, ctx) => syncTools(ctx));

  pi.on("before_agent_start", async (event, ctx) => {
    reloadConfig(ctx);
    const config = cfg(ctx);
    if (!config.enabled) return;
    if (!isFlutterAndroidProject(ctx.cwd)) return;
    return {
      systemPrompt: `${event.systemPrompt}\n\n${RELEASE_PROCEDURE}`,
    };
  });

  pi.registerTool({
    name: "release_doctor",
    label: "Release Doctor",
    description:
      "[Lane D — Release] Check Flutter Android toolchain and project layout before APK/AAB builds. " +
      "Run this before release_build when the user asks for an Android release. " +
      "If not ready, stop and tell the human what's missing — do not loop Gradle fixes.",
    promptSnippet: "Check Flutter Android toolchain (Lane D)",
    promptGuidelines: [
      "Call before release_build or when user asks if APK build is possible.",
      "If not ready, give structured blockers — do not write long generic install essays.",
      "Human must install Android Studio/SDK/licenses — Pi cannot do that.",
    ],
    parameters: Type.Object({}),
    async execute(_id, _params, _signal, _onUpdate, ctx) {
      const config = cfg(ctx);
      if (!config.enabled) {
        return {
          content: [{ type: "text", text: "Release extension disabled in release.config.json." }],
          details: { enabled: false },
          isError: true,
        };
      }
      const result = await runReleaseDoctor(ctx.cwd, config);
      const report = formatDoctorMessage(result, ctx.cwd);
      return {
        content: [{ type: "text", text: report }],
        details: { ready: result.ready, checks: result.checks },
        isError: !result.ready,
      };
    },
  });

  pi.registerTool({
    name: "release_build",
    label: "Release Build",
    description:
      "[Lane D — Release] Build a Flutter Android release artifact (APK or AAB). " +
      "Runs release_doctor preflight first. Success = exit 0 and artifact file on disk.",
    promptSnippet: "Build Flutter release APK/AAB (Lane D)",
    promptGuidelines: [
      "Only after release_doctor is ready (or call will preflight and fail fast).",
      'Default target "apk"; use "appbundle" for Play Store.',
      "First Gradle build can take several minutes — do not retry in a loop without reading the log.",
    ],
    parameters: Type.Object({
      target: Type.Optional(
        Type.String({
          description: 'Build target key from release.config.json (default: "apk"). Common: apk, appbundle.',
        }),
      ),
    }),
    async execute(_id, params, signal, _onUpdate, ctx) {
      const config = cfg(ctx);
      if (!config.enabled) {
        return {
          content: [{ type: "text", text: "Release extension disabled in release.config.json." }],
          details: { enabled: false },
          isError: true,
        };
      }
      const targetKey = (params.target ?? "apk").trim().toLowerCase();
      const result = await runReleaseBuild(ctx.cwd, config, targetKey, signal);
      const targetCfg = config.targets[targetKey];
      const report = formatBuildReport(result, targetCfg);
      return {
        content: [{ type: "text", text: report }],
        details: {
          ok: result.ok,
          target: result.target,
          artifactPath: result.artifactPath,
          artifactExists: result.artifactExists,
        },
        isError: !result.ok,
      };
    },
  });

  pi.registerCommand("release", {
    description: "Flutter Android release — doctor | build apk | build appbundle",
    handler: async (args, ctx) => {
      const config = cfg(ctx);
      if (!config.enabled) {
        ctx.ui.notify("Release extension disabled in release.config.json.", "warning");
        return;
      }

      const parts = args.trim().split(/\s+/).filter(Boolean);
      const sub = parts[0]?.toLowerCase() ?? "help";

      if (sub === "doctor") {
        const result = await runReleaseDoctor(ctx.cwd, config);
        const report = formatDoctorMessage(result, ctx.cwd);
        ctx.ui.notify(report, result.ready ? "info" : "warning");
        if (!result.ready) {
          pi.sendUserMessage(`${report}\n\nFix blockers (human setup), then run /release doctor again.`);
        }
        return;
      }

      if (sub === "build") {
        const targetKey = (parts[1] ?? "apk").toLowerCase();
        if (!config.targets[targetKey]) {
          ctx.ui.notify(
            `Unknown target "${targetKey}". Known: ${listTargetKeys(config).join(", ")}`,
            "warning",
          );
          return;
        }
        ctx.ui.notify(`Building ${targetKey}… (first run can take several minutes)`, "info");
        const result = await runReleaseBuild(ctx.cwd, config, targetKey);
        const report = formatBuildReport(result, config.targets[targetKey]);
        ctx.ui.notify(report, result.ok ? "info" : "error");
        if (!result.ok) {
          pi.sendUserMessage(`Release build failed:\n\n${report}`);
        }
        return;
      }

      const targets = listTargetKeys(config).join(" | ");
      ctx.ui.notify(
        `Usage: /release doctor | /release build apk | /release build appbundle\nTargets: ${targets}`,
        "info",
      );
    },
  });
}
