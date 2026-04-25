// Persisted SLOP provider surface for orchestration: state tree, descriptors,
// and durable task records. Runtime behavior (claim flow, scheduling,
// delegation policy) lives in `src/runtime/orchestration/`.

import { createSlopServer, type SlopServer } from "@slop-ai/server";

import { debug } from "../../../core/debug";
import {
  buildFindingsDescriptor,
  buildHandoffsDescriptor,
  buildRootDescriptor,
  buildTasksDescriptor,
  type DescriptorWiring,
} from "./descriptors";
import { FindingsCoordinator } from "./findings";
import { HandoffsCoordinator } from "./handoffs";
import { TaskLifecycle } from "./lifecycle";
import { PlanLifecycle } from "./plan-lifecycle";
import { OrchestrationRepository } from "./repository";
import { VerificationCoordinator } from "./verification";

export interface OrchestrationProviderOptions {
  workspaceRoot: string;
  sessionId?: string;
  progressTailMaxChars?: number;
}

export class OrchestrationProvider {
  readonly server: SlopServer;
  private readonly repo: OrchestrationRepository;
  private readonly lifecycle: TaskLifecycle;
  private readonly plans: PlanLifecycle;
  private readonly verification: VerificationCoordinator;
  private readonly findings: FindingsCoordinator;
  private readonly handoffs: HandoffsCoordinator;
  private readonly wiring: DescriptorWiring;

  constructor(options: OrchestrationProviderOptions) {
    const sessionId = options.sessionId ?? "default";
    this.repo = new OrchestrationRepository({
      workspaceRoot: options.workspaceRoot,
      progressTailMaxChars: options.progressTailMaxChars,
    });

    debug("orchestration", "hydrate", this.repo.versionStats());

    this.server = createSlopServer({
      id: "orchestration",
      name: "Orchestration",
    });

    const refresh = () => this.server.refresh();

    this.lifecycle = new TaskLifecycle({ repo: this.repo, refresh });
    this.plans = new PlanLifecycle({
      repo: this.repo,
      lifecycle: this.lifecycle,
      sessionId,
      refresh,
    });
    this.verification = new VerificationCoordinator({
      repo: this.repo,
      lifecycle: this.lifecycle,
      refresh,
    });
    this.findings = new FindingsCoordinator({
      repo: this.repo,
      lifecycle: this.lifecycle,
      refresh,
    });
    this.handoffs = new HandoffsCoordinator({ repo: this.repo, refresh });

    this.wiring = {
      repo: this.repo,
      lifecycle: this.lifecycle,
      plans: this.plans,
      verification: this.verification,
      findings: this.findings,
      handoffs: this.handoffs,
      sessionId,
    };

    this.server.register("orchestration", () => buildRootDescriptor(this.wiring));
    this.server.register("tasks", () => buildTasksDescriptor(this.wiring));
    this.server.register("handoffs", () => buildHandoffsDescriptor(this.wiring));
    this.server.register("findings", () => buildFindingsDescriptor(this.wiring));
  }

  stop(): void {
    this.server.stop();
  }
}
