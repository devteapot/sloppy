import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

const CODEX_OAUTH_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const CODEX_OAUTH_TOKEN_URL = "https://auth.openai.com/oauth/token";
const TOKEN_REFRESH_SKEW_MS = 120_000;

export type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

type CodexAuthFile = {
  auth_mode?: string;
  OPENAI_API_KEY?: unknown;
  tokens?: {
    id_token?: string;
    access_token?: string;
    refresh_token?: string;
    account_id?: string;
  };
  last_refresh?: string;
};

export type CodexCredentials = {
  accessToken: string;
  refreshToken?: string;
  idToken?: string;
  accountId: string;
};

export type CodexAuthStatus = {
  available: boolean;
  authPath: string;
  reason?: string;
};

export async function getCodexAuthStatus(options?: {
  authPath?: string;
}): Promise<CodexAuthStatus> {
  const authPath = resolve(options?.authPath ?? codexAuthPath());
  const auth = await readCodexAuthFile(authPath);
  if (!auth) {
    return {
      available: false,
      authPath,
      reason: `No Codex auth file found at ${authPath}. Run \`codex login\` first.`,
    };
  }

  if (!credentialsFromAuthFile(auth)) {
    return {
      available: false,
      authPath,
      reason: `Codex auth file at ${authPath} does not contain usable ChatGPT credentials. Run \`codex login\` again.`,
    };
  }
  return { available: true, authPath };
}

export async function resolveCodexCredentials(options?: {
  authPath?: string;
  fetchFn?: FetchLike;
  signal?: AbortSignal;
}): Promise<CodexCredentials> {
  throwIfAborted(options?.signal);
  const authPath = resolve(options?.authPath ?? codexAuthPath());
  const auth = await readCodexAuthFile(authPath);
  throwIfAborted(options?.signal);
  if (!auth) {
    throw new Error(`No Codex auth file found at ${authPath}. Run \`codex login\` first.`);
  }

  const credentials = credentialsFromAuthFile(auth);
  if (!credentials) {
    throw new Error(
      `Codex auth file at ${authPath} does not contain usable ChatGPT credentials. Run \`codex login\` again.`,
    );
  }

  const expiresAt = tokenExpiryMs(credentials.accessToken);
  if (expiresAt && expiresAt - Date.now() <= TOKEN_REFRESH_SKEW_MS) {
    return refreshCodexCredentials(authPath, auth, options?.fetchFn ?? fetch, options?.signal);
  }
  return credentials;
}

function throwIfAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) return;
  const error = new Error("Codex credential resolution was aborted.");
  error.name = "AbortError";
  throw error;
}

function codexAuthPath(): string {
  const override = process.env.SLOPPY_CODEX_AUTH_PATH?.trim();
  if (override) return resolve(override);
  const home = process.env.HOME;
  return resolve(home ? `${home}/.codex/auth.json` : ".codex/auth.json");
}

async function readCodexAuthFile(authPath: string): Promise<CodexAuthFile | null> {
  try {
    return JSON.parse(await readFile(authPath, "utf8")) as CodexAuthFile;
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

function credentialsFromAuthFile(auth: CodexAuthFile): CodexCredentials | null {
  const accessToken = auth.tokens?.access_token?.trim();
  if (!accessToken) return null;
  const accountId = auth.tokens?.account_id?.trim() || tokenAccountId(accessToken);
  if (!accountId) return null;
  return {
    accessToken,
    refreshToken: auth.tokens?.refresh_token?.trim() || undefined,
    idToken: auth.tokens?.id_token?.trim() || undefined,
    accountId,
  };
}

async function refreshCodexCredentials(
  authPath: string,
  auth: CodexAuthFile,
  fetchFn: FetchLike,
  signal?: AbortSignal,
): Promise<CodexCredentials> {
  throwIfAborted(signal);
  const refreshToken = auth.tokens?.refresh_token?.trim();
  if (!refreshToken) {
    throw new Error("Codex credentials are expired and no refresh token is available.");
  }

  const response = await fetchFn(CODEX_OAUTH_TOKEN_URL, {
    method: "POST",
    redirect: "error",
    signal,
    headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      client_id: CODEX_OAUTH_CLIENT_ID,
      refresh_token: refreshToken,
    }),
  });
  throwIfAborted(signal);
  if (!response.ok) {
    throw new Error(`Codex OAuth refresh failed: ${await response.text()}`);
  }

  const data = (await response.json()) as {
    access_token?: string;
    refresh_token?: string;
    id_token?: string;
  };
  throwIfAborted(signal);
  const accessToken = data.access_token?.trim();
  if (!accessToken) {
    throw new Error("Codex OAuth refresh did not return an access token.");
  }

  const nextAuth: CodexAuthFile = {
    ...auth,
    tokens: {
      ...auth.tokens,
      access_token: accessToken,
      refresh_token: data.refresh_token?.trim() || auth.tokens?.refresh_token,
      id_token: data.id_token?.trim() || auth.tokens?.id_token,
      account_id: auth.tokens?.account_id || tokenAccountId(accessToken),
    },
    last_refresh: new Date().toISOString(),
  };
  await writeCodexAuthFile(authPath, nextAuth, signal);
  const credentials = credentialsFromAuthFile(nextAuth);
  if (!credentials) {
    throw new Error("Codex OAuth refresh returned credentials without an account id.");
  }
  return credentials;
}

async function writeCodexAuthFile(
  authPath: string,
  auth: CodexAuthFile,
  signal?: AbortSignal,
): Promise<void> {
  throwIfAborted(signal);
  await mkdir(dirname(authPath), { recursive: true });
  throwIfAborted(signal);
  const tempPath = `${authPath}.tmp-${process.pid}-${crypto.randomUUID()}`;
  let renamed = false;
  let failed = false;
  let failure: unknown;
  try {
    throwIfAborted(signal);
    await writeFile(tempPath, `${JSON.stringify(auth, null, 2)}\n`, {
      mode: 0o600,
      signal,
    });
    throwIfAborted(signal);
    await rename(tempPath, authPath);
    renamed = true;
  } catch (error) {
    failed = true;
    failure = error;
  }

  if (!renamed) {
    try {
      await unlink(tempPath);
    } catch (cleanupError) {
      if (
        !(
          cleanupError &&
          typeof cleanupError === "object" &&
          "code" in cleanupError &&
          cleanupError.code === "ENOENT"
        )
      ) {
        throw new AggregateError(
          failed ? [failure, cleanupError] : [cleanupError],
          `Failed to remove temporary Codex auth file ${tempPath}.`,
        );
      }
    }
  }
  if (failed) {
    throw failure;
  }
}

function tokenExpiryMs(token: string): number | undefined {
  const exp = jwtPayload(token)?.exp;
  return typeof exp === "number" ? exp * 1000 : undefined;
}

function tokenAccountId(token: string): string | undefined {
  const payload = jwtPayload(token);
  const direct = payload?.chatgpt_account_id;
  if (typeof direct === "string" && direct.trim()) return direct.trim();
  for (const value of Object.values(payload ?? {})) {
    if (!value || typeof value !== "object" || Array.isArray(value)) continue;
    const accountId = (value as { chatgpt_account_id?: unknown }).chatgpt_account_id;
    if (typeof accountId === "string" && accountId.trim()) return accountId.trim();
  }
  return undefined;
}

function jwtPayload(token: string): Record<string, unknown> | null {
  const [, payload] = token.split(".");
  if (!payload) return null;
  try {
    const normalized = payload.replaceAll("-", "+").replaceAll("_", "/");
    const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=");
    return JSON.parse(Buffer.from(padded, "base64").toString("utf8")) as Record<string, unknown>;
  } catch {
    return null;
  }
}
