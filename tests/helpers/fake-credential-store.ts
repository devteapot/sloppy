import type {
  CredentialStore,
  CredentialStoreKind,
  CredentialStoreStatus,
} from "../../src/llm/credential-store";

/** In-memory CredentialStore double for profile-manager tests. */
export class FakeCredentialStore implements CredentialStore {
  readonly kind: CredentialStoreKind = "keychain";
  private readonly map = new Map<string, string>();

  constructor(seed: Record<string, string> = {}) {
    for (const [key, value] of Object.entries(seed)) {
      this.map.set(key, value);
    }
  }

  async getStatus(): Promise<CredentialStoreStatus> {
    return "available";
  }

  async get(id: string): Promise<string | null> {
    return this.map.get(id) ?? null;
  }

  async set(id: string, secret: string): Promise<void> {
    this.map.set(id, secret);
  }

  async delete(id: string): Promise<void> {
    this.map.delete(id);
  }
}
