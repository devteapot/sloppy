const SECRET_KEY_NAMES = new Set([
  "api-key",
  "api_key",
  "apikey",
  "key",
  "secret",
  "token",
  "auth",
  "authorization",
  "bearer",
  "password",
]);

const SECRET_VALUE_PATTERNS: RegExp[] = [
  /^sk[-_][A-Za-z0-9_-]{8,}$/i,
  /^pk[-_][A-Za-z0-9_-]{8,}$/i,
  /^rk[-_][A-Za-z0-9_-]{8,}$/i,
  /^sess[-_][A-Za-z0-9_-]{8,}$/i,
  /^ghp_[A-Za-z0-9]{16,}$/,
  /^gho_[A-Za-z0-9]{16,}$/,
  /^ghs_[A-Za-z0-9]{16,}$/,
  /^ghr_[A-Za-z0-9]{16,}$/,
  /^github_pat_[A-Za-z0-9_]{20,}$/,
  /^xox[abprs]-[A-Za-z0-9-]{10,}$/i,
  /^aws_/i,
  /^AKIA[0-9A-Z]{8,}$/,
  /^Bearer\s+\S{8,}$/i,
];

function looksLikeSecretValue(value: string): boolean {
  for (const pattern of SECRET_VALUE_PATTERNS) {
    if (pattern.test(value)) {
      return true;
    }
  }
  return false;
}

export function detectInlineSecret(args: string[]): string | undefined {
  const REJECT =
    "Use /profile-secret <provider> [model] for API keys — secrets must not be passed inline.";

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];

    if (arg.startsWith("--")) {
      const eq = arg.indexOf("=");
      const flagName = (eq === -1 ? arg.slice(2) : arg.slice(2, eq)).toLowerCase();
      const inlineValue = eq === -1 ? undefined : arg.slice(eq + 1);

      if (SECRET_KEY_NAMES.has(flagName)) {
        if (inlineValue !== undefined && inlineValue.length > 0) {
          return REJECT;
        }
        const next = args[index + 1];
        if (next !== undefined && !next.startsWith("--")) {
          return REJECT;
        }
      }

      if (inlineValue !== undefined && looksLikeSecretValue(inlineValue)) {
        return REJECT;
      }
      continue;
    }

    if (looksLikeSecretValue(arg)) {
      return REJECT;
    }
  }

  return undefined;
}
