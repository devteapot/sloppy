export type RuntimeServiceKey<T> = symbol & {
  readonly __runtimeService?: T;
};

export function createRuntimeServiceKey<T>(description: string): RuntimeServiceKey<T> {
  return Symbol(description) as RuntimeServiceKey<T>;
}

/**
 * Typed bindings for same-process runtime collaborators.
 *
 * SLOP remains the agent and external-consumer boundary. Internal components
 * use this registry when they have a stable, construction-time dependency on
 * another first-party capability.
 */
export class RuntimeServiceRegistry {
  private readonly services = new Map<symbol, unknown>();

  bind<T>(key: RuntimeServiceKey<T>, service: T): void {
    this.services.set(key, service);
  }

  get<T>(key: RuntimeServiceKey<T>): T | undefined {
    return this.services.get(key) as T | undefined;
  }

  require<T>(key: RuntimeServiceKey<T>, name: string): T {
    const service = this.get(key);
    if (!service) {
      throw new Error(`${name} runtime service is not enabled or has not been assembled.`);
    }
    return service;
  }

  clear(): void {
    this.services.clear();
  }
}
