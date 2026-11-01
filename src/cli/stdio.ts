export async function readPipedStdin(): Promise<string> {
  process.stdin.setEncoding("utf8");
  let contents = "";
  for await (const chunk of process.stdin) contents += chunk as string;
  return contents;
}
