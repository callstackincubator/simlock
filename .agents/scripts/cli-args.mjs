// What the scripts share. `option("--pr")` is the word after `--pr` on the command line, or
// null when it is absent. `repository()` is the repo a script works on, as `owner/name`:
// GH_REPO, else the origin remote's.
import { execFileSync } from "node:child_process";

export function option(name, args = process.argv.slice(2)) {
  const at = args.indexOf(name);
  return at === -1 ? null : (args[at + 1] ?? null);
}

export function repository() {
  if (process.env.GH_REPO) return process.env.GH_REPO;
  const url = execFileSync("git", ["remote", "get-url", "origin"], { encoding: "utf8" }).trim();
  const match = /([^/:]+)\/([^/]+?)(?:\.git)?$/.exec(url);
  if (match === null) throw new Error(`Cannot read owner/name from origin ${url}; set GH_REPO`);
  return `${match[1]}/${match[2]}`;
}
