export type CredentialStoreKind = "keychain" | "secret-service" | "none";
export type CredentialStoreStatus = "available" | "unavailable" | "unsupported";

export type CommandResult = {
  stdout: string;
  stderr: string;
  exitCode: number;
};

export type CommandRunner = (
  command: string,
  args: string[],
  options?: {
    input?: string;
  },
) => Promise<CommandResult>;

export interface CredentialStore {
  kind: CredentialStoreKind;
  getStatus(): Promise<CredentialStoreStatus>;
  get(profileId: string): Promise<string | null>;
  set(profileId: string, secret: string): Promise<void>;
  delete(profileId: string): Promise<void>;
}

const KEYCHAIN_SERVICE_NAME = "devteapot.sloppy.llm";
const SECRET_SERVICE_APP_NAME = "sloppy";

type KeytarModule = {
  setPassword(service: string, account: string, password: string): Promise<void>;
  getPassword(service: string, account: string): Promise<string | null>;
  deletePassword(service: string, account: string): Promise<boolean>;
};

let keytarLookup: Promise<KeytarModule | null> | null = null;

/**
 * Returns the optional `keytar` native binding if installed. Used by the
 * macOS keychain store to write secrets without passing them through argv
 * (`security add-generic-password -w <secret>` exposes the value to other
 * processes via `ps`). When `keytar` is not installed the keychain store
 * falls back to the `security` CLI path.
 */
function loadKeytar(): Promise<KeytarModule | null> {
  if (!keytarLookup) {
    // Use a computed specifier to avoid a hard module-resolution error when
    // `keytar` is not installed; the import is intentionally optional.
    const specifier = "keytar";
    keytarLookup = import(/* @vite-ignore */ specifier)
      .then((mod) => (mod && typeof mod === "object" ? (mod as unknown as KeytarModule) : null))
      .catch(() => null);
  }
  return keytarLookup;
}

export function __resetKeytarCacheForTests(
  value: Promise<KeytarModule | null> | null = null,
): void {
  keytarLookup = value;
}

async function runSystemCommand(
  command: string,
  args: string[],
  options?: {
    input?: string;
  },
): Promise<CommandResult> {
  const subprocess = Bun.spawn([command, ...args], {
    stdin: options?.input != null ? new TextEncoder().encode(options.input) : "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });

  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(subprocess.stdout).text(),
    new Response(subprocess.stderr).text(),
    subprocess.exited,
  ]);

  return {
    stdout,
    stderr,
    exitCode,
  };
}

function isNotFoundError(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    typeof (error as NodeJS.ErrnoException).code === "string" &&
    (error as NodeJS.ErrnoException).code === "ENOENT"
  );
}

function missingItem(result: CommandResult): boolean {
  if (result.exitCode === 0) {
    return false;
  }

  const message = `${result.stdout}\n${result.stderr}`.toLowerCase();
  return (
    message.includes("could not be found") ||
    message.includes("item not found") ||
    message.includes("no such secret collection") ||
    message.includes("not found") ||
    message.trim() === ""
  );
}

function normalizeSecretOutput(output: string): string {
  return output.replace(/\r?\n$/, "");
}

abstract class BaseCredentialStore implements CredentialStore {
  private statusPromise: Promise<CredentialStoreStatus> | null = null;

  constructor(
    readonly kind: CredentialStoreKind,
    protected readonly runner: CommandRunner,
  ) {}

  async getStatus(): Promise<CredentialStoreStatus> {
    if (!this.statusPromise) {
      this.statusPromise = this.detectStatus();
    }
    return this.statusPromise;
  }

  protected abstract detectStatus(): Promise<CredentialStoreStatus>;

  protected async ensureAvailable(): Promise<void> {
    const status = await this.getStatus();
    if (status !== "available") {
      throw new Error(`Secure credential storage is ${status} on this machine.`);
    }
  }

  abstract get(profileId: string): Promise<string | null>;
  abstract set(profileId: string, secret: string): Promise<void>;
  abstract delete(profileId: string): Promise<void>;
}

class KeychainCredentialStore extends BaseCredentialStore {
  constructor(runner: CommandRunner) {
    super("keychain", runner);
  }

  protected async detectStatus(): Promise<CredentialStoreStatus> {
    if (process.platform !== "darwin") {
      return "unsupported";
    }

    try {
      await this.runner("security", ["help"]);
      return "available";
    } catch (error) {
      return isNotFoundError(error) ? "unavailable" : "available";
    }
  }

  async get(profileId: string): Promise<string | null> {
    if ((await this.getStatus()) !== "available") {
      return null;
    }

    const result = await this.runner("security", [
      "find-generic-password",
      "-a",
      profileId,
      "-s",
      KEYCHAIN_SERVICE_NAME,
      "-w",
    ]).catch((error) => {
      if (isNotFoundError(error)) {
        return { stdout: "", stderr: "", exitCode: 1 } satisfies CommandResult;
      }
      throw error;
    });

    if (result.exitCode !== 0) {
      if (missingItem(result)) {
        return null;
      }

      throw new Error(result.stderr.trim() || result.stdout.trim());
    }

    return normalizeSecretOutput(result.stdout);
  }

  async set(profileId: string, secret: string): Promise<void> {
    await this.ensureAvailable();
    // The macOS keychain path requires `keytar` (an optional dependency).
    // We refuse to fall back to `security add-generic-password -w <secret>`
    // because that places the API key in argv, where any local process can
    // observe it via `ps`. If the optional install failed (e.g. native
    // toolchain missing), the user can reinstall with keytar present or set
    // the API key via the env var that the profile points at.
    const keytar = await loadKeytar();
    if (!keytar) {
      throw new Error(
        "Keychain storage requires the optional `keytar` package. Install it with `bun add keytar`, or set the API key via the profile's apiKeyEnv environment variable.",
      );
    }
    await keytar.setPassword(KEYCHAIN_SERVICE_NAME, profileId, secret);
  }

  async delete(profileId: string): Promise<void> {
    if ((await this.getStatus()) !== "available") {
      return;
    }

    // Use keytar when available; otherwise fall back to the `security` CLI.
    // delete is argv-safe (no secret in argv), so no fail-secure needed here.
    const keytar = await loadKeytar();
    if (keytar) {
      await keytar.deletePassword(KEYCHAIN_SERVICE_NAME, profileId);
      return;
    }

    const result = await this.runner("security", [
      "delete-generic-password",
      "-a",
      profileId,
      "-s",
      KEYCHAIN_SERVICE_NAME,
    ]).catch((error) => {
      if (isNotFoundError(error)) {
        return { stdout: "", stderr: "", exitCode: 1 } satisfies CommandResult;
      }
      throw error;
    });

    if (result.exitCode !== 0 && !missingItem(result)) {
      throw new Error(
        result.stderr.trim() || result.stdout.trim() || "Failed to delete API key from Keychain.",
      );
    }
  }
}

class SecretServiceCredentialStore extends BaseCredentialStore {
  constructor(runner: CommandRunner) {
    super("secret-service", runner);
  }

  protected async detectStatus(): Promise<CredentialStoreStatus> {
    if (process.platform !== "linux") {
      return "unsupported";
    }

    try {
      await this.runner("secret-tool", ["--help"]);
      return "available";
    } catch (error) {
      return isNotFoundError(error) ? "unavailable" : "available";
    }
  }

  async get(profileId: string): Promise<string | null> {
    if ((await this.getStatus()) !== "available") {
      return null;
    }

    const result = await this.runner("secret-tool", [
      "lookup",
      "application",
      SECRET_SERVICE_APP_NAME,
      "profile_id",
      profileId,
    ]).catch((error) => {
      if (isNotFoundError(error)) {
        return { stdout: "", stderr: "", exitCode: 1 } satisfies CommandResult;
      }
      throw error;
    });

    if (result.exitCode !== 0) {
      if (missingItem(result)) {
        return null;
      }

      throw new Error(result.stderr.trim() || result.stdout.trim());
    }

    return normalizeSecretOutput(result.stdout);
  }

  async set(profileId: string, secret: string): Promise<void> {
    await this.ensureAvailable();
    const result = await this.runner(
      "secret-tool",
      [
        "store",
        "--label",
        `Sloppy API key (${profileId})`,
        "application",
        SECRET_SERVICE_APP_NAME,
        "profile_id",
        profileId,
      ],
      {
        input: secret,
      },
    );
    if (result.exitCode !== 0) {
      throw new Error(
        result.stderr.trim() ||
          result.stdout.trim() ||
          "Failed to store API key in Secret Service.",
      );
    }
  }

  async delete(profileId: string): Promise<void> {
    if ((await this.getStatus()) !== "available") {
      return;
    }

    const result = await this.runner("secret-tool", [
      "clear",
      "application",
      SECRET_SERVICE_APP_NAME,
      "profile_id",
      profileId,
    ]).catch((error) => {
      if (isNotFoundError(error)) {
        return { stdout: "", stderr: "", exitCode: 1 } satisfies CommandResult;
      }
      throw error;
    });

    if (result.exitCode !== 0 && !missingItem(result)) {
      throw new Error(
        result.stderr.trim() ||
          result.stdout.trim() ||
          "Failed to delete API key from Secret Service.",
      );
    }
  }
}

class UnsupportedCredentialStore extends BaseCredentialStore {
  constructor(runner: CommandRunner) {
    super("none", runner);
  }

  protected async detectStatus(): Promise<CredentialStoreStatus> {
    return "unsupported";
  }

  async get(_profileId: string): Promise<string | null> {
    return null;
  }

  async set(_profileId: string, _secret: string): Promise<void> {
    await this.ensureAvailable();
  }

  async delete(_profileId: string): Promise<void> {
    return;
  }
}

export function createCredentialStore(runner: CommandRunner = runSystemCommand): CredentialStore {
  if (process.platform === "darwin") {
    return new KeychainCredentialStore(runner);
  }

  if (process.platform === "linux") {
    return new SecretServiceCredentialStore(runner);
  }

  return new UnsupportedCredentialStore(runner);
}
