import * as os from "node:os";
import * as path from "node:path";

/** Pi project/user config directory name (matches @earendil-works/pi-coding-agent). */
export const CONFIG_DIR_NAME = ".pi";

/**
 * Config file search order (later wins):
 * 1. user  ~/{CONFIG_DIR_NAME}/<name>
 * 2. project <cwd>/{CONFIG_DIR_NAME}/<name>
 * 3. project <cwd>/<name>                    (legacy project root)
 */
export function foundationConfigPaths(cwd: string, filename: string): string[] {
  const homePi = path.join(os.homedir(), CONFIG_DIR_NAME);
  return [
    path.join(homePi, filename),
    path.join(cwd, CONFIG_DIR_NAME, filename),
    path.join(cwd, filename),
  ];
}
