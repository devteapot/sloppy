export type CopyResult = "copied" | "unsupported" | "error";

export function copyToClipboard(
  text: string,
  output: NodeJS.WriteStream = process.stdout,
): CopyResult {
  try {
    if (!output.isTTY) {
      return "unsupported";
    }
    const encoded = Buffer.from(text, "utf8").toString("base64");
    output.write(`\u001b]52;c;${encoded}\u0007`);
    return "copied";
  } catch {
    return "error";
  }
}
