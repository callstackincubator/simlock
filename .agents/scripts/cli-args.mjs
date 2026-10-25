// The one-line option parser the measuring scripts share: `option("--pr")` is the word after
// `--pr` on the command line, or null when it is absent.
export function option(name, args = process.argv.slice(2)) {
  const at = args.indexOf(name);
  return at === -1 ? null : (args[at + 1] ?? null);
}
