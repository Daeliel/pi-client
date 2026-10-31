import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

/** A project's own interpreter, relative to the project or a folder above it. */
const LOCAL_PYTHONS = [
  ".venv/Scripts/python.exe",
  "venv/Scripts/python.exe",
  ".venv/bin/python",
  "venv/bin/python",
  // ComfyUI's portable build ships its interpreter beside the app (the misspelling is theirs).
  "python_embeded/python.exe",
  "python_embedded/python.exe",
];

/**
 * The interpreter the project itself runs with — a virtualenv or a portable build's own
 * Python — nearest to `dir` first, stopping below the home folder. Quoted, forward slashes:
 * ready to put in a shell command. Null when the project has none (PATH Python then).
 */
export function localPython(dir: string): string | null {
  const home = path.resolve(os.homedir());
  for (let d = path.resolve(dir); ; d = path.dirname(d)) {
    // A venv in the home folder is the user's general one, not this project's.
    if (d.toLowerCase() === home.toLowerCase()) return null;
    for (const rel of LOCAL_PYTHONS) {
      const p = path.join(d, rel);
      if (fs.existsSync(p)) return `"${p.replace(/\\/g, "/")}"`;
    }
    if (path.dirname(d) === d) return null;
  }
}
