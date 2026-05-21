export type CliArgs =
  | { mode: "repl" }
  | { mode: "single"; prompt: string }
  | { mode: "help" }
  | { mode: "error"; message: string };

export const CLI_USAGE = [
  "Usage:",
  '  bun run src/cli.ts -p "<prompt>"',
  '  bun run src/cli.ts "<prompt>"',
  "  bun run src/cli.ts",
  "",
].join("\n");

export function parseCliArgs(args: string[]): CliArgs {
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "-h" || arg === "--help") {
      return { mode: "help" };
    }
    if (arg === "-p" || arg === "--prompt") {
      const prompt = args
        .slice(index + 1)
        .join(" ")
        .trim();
      return prompt
        ? { mode: "single", prompt }
        : { mode: "error", message: `${arg} requires a prompt.` };
    }
    if (arg.startsWith("--prompt=")) {
      const prompt = arg.slice("--prompt=".length).trim();
      return prompt
        ? { mode: "single", prompt }
        : { mode: "error", message: "--prompt requires a prompt." };
    }
  }

  const prompt = args.join(" ").trim();
  return prompt ? { mode: "single", prompt } : { mode: "repl" };
}
