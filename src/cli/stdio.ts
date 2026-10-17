export async function readPipedStdin(): Promise<string | undefined> {
  if (process.stdin.isTTY === true) return undefined;
  process.stdin.setEncoding("utf8");
  let contents = "";
  for await (const chunk of process.stdin) contents += chunk as string;
  return contents;
}
