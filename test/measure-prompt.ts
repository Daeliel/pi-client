/**
 * Print what a small model receives each call with every pi-client extension loaded:
 * system-prompt sections with sizes, and the active tool list. Run: npm run measure:prompt -- "your prompt"
 */
import antiLoop from "../extensions/anti-loop/index";
import verify from "../extensions/verify/index";
import scenarios from "../extensions/scenarios/index";
import browser from "../extensions/browser-console/index";
import projectContext from "../extensions/project-context/index";
import research from "../extensions/research/index";
import release from "../extensions/release/index";
import polish from "../extensions/polish/index";
import expand from "../extensions/expand/index";
import once from "../extensions/once/index";
import visionRelay from "../extensions/vision-relay/index";
import { createHarness, reply, writeProjectConfig } from "./harness";

const h = await createHarness({
  extensions: [antiLoop, verify, scenarios, browser, projectContext, research, release, polish, expand, once, visionRelay],
  files: { "package.json": JSON.stringify({ scripts: { dev: "vite" } }), "index.html": "<html></html>" },
});
writeProjectConfig(h.cwd, "browser-console.config.json", { autoConnect: false, autoLaunchBrowser: false });
let sys = ""; let tools: any[] = [];
h.faux.setResponses([(c: any) => { sys = c.systemPrompt; tools = c.tools ?? []; return reply("ok"); }]);
await h.session.prompt(process.argv[2] ?? "build a todo app page");
const sections = sys.split(/\n(?=## )/);
for (const sec of sections) console.log(String(sec.length).padStart(6), sec.split("\n")[0].slice(0, 70));
console.log("SYSTEM PROMPT chars:", sys.length, "≈ tokens", Math.round(sys.length / 3.6));
console.log("TOOLS:", tools.length, tools.map((t) => t.name).join(", "));
console.log("TOOL SCHEMA chars:", JSON.stringify(tools).length);
h.dispose();
