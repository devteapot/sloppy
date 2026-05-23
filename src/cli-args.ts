export type CliArgs =
  | { mode: "repl" }
  | { mode: "single"; prompt: string; approvalMode?: "auto" }
  | { mode: "help" }
  | { mode: "error"; message: string };

export const CLI_USAGE = [
  "Usage:",
  '  bun run src/cli.ts -p "<prompt>" [--yolo]',
  '  bun run src/cli.ts "<prompt>"',
  "  bun run src/cli.ts",
  "",
].join("\n");

export function parseCliArgs(args: string[]): CliArgs {
  const approvalMode = args.includes("--yolo") ? "auto" : undefined;
  const promptArgs = args.filter((arg) => arg !== "--yolo");
  for (let index = 0; index < promptArgs.length; index += 1) {
    const arg = promptArgs[index];
    if (arg === "-h" || arg === "--help") {
      return { mode: "help" };
    }
    if (arg === "-p" || arg === "--prompt") {
      const prompt = promptArgs
        .slice(index + 1)
        .join(" ")
        .trim();
      return prompt
        ? { mode: "single", prompt, ...(approvalMode && { approvalMode }) }
        : { mode: "error", message: `${arg} requires a prompt.` };
    }
    if (arg.startsWith("--prompt=")) {
      const prompt = arg.slice("--prompt=".length).trim();
      return prompt
        ? { mode: "single", prompt, ...(approvalMode && { approvalMode }) }
        : { mode: "error", message: "--prompt requires a prompt." };
    }
  }

  const prompt = promptArgs.join(" ").trim();
  return prompt
    ? { mode: "single", prompt, ...(approvalMode && { approvalMode }) }
    : { mode: "repl" };
}
