// Persisted SLOP provider surface for orchestration: state tree, descriptors,
// and durable task records. Runtime behavior (claim flow, scheduling,
// delegation policy) lives in `src/runtime/orchestration/`.

import { createSlopServer, type SlopServer } from "@slop-ai/server";

import { debug } from "../../../core/debug";
import { normalizePlanBudget } from "./budget";
import {
  buildAuditDescriptor,
  buildBlobsDescriptor,
  buildBudgetDescriptor,
  buildDigestsDescriptor,
  buildDriftDescriptor,
  buildFindingsDescriptor,
  buildGatesDescriptor,
  buildGoalsDescriptor,
  buildHandoffsDescriptor,
  buildMessagesDescriptor,
  buildPrecedentsDescriptor,
  buildRootDescriptor,
  buildTasksDescriptor,
  type DescriptorWiring,
} from "./descriptors";
import { createEmailDigestTransport, createSlackDigestTransport } from "./digest-transports";
import { DigestCoordinator } from "./digests";
import { DriftCoordinator } from "./drift";
import { FindingsCoordinator } from "./findings";
import { normalizeGatePolicyInput } from "./gate-policy";
import { GatesCoordinator } from "./gates";
import { GoalsCoordinator } from "./goals";
import { HandoffsCoordinator } from "./handoffs";
import { TaskLifecycle } from "./lifecycle";
import { MessagesCoordinator } from "./messages";
import { PlanLifecycle } from "./plan-lifecycle";
import { PrecedentsCoordinator } from "./precedents";
import { OrchestrationRepository } from "./repository";
import type {
  DigestDeliveryTransport,
  DigestPolicy,
  EmailDigestTransportOptions,
  GatePolicy,
  GuardrailPolicy,
  PlanBudget,
  PrecedentEmbeddingProvider,
  PrecedentTieBreaker,
  SlackDigestTransportOptions,
} from "./types";
import { VerificationCoordinator } from "./verification";

export interface OrchestrationProviderOptions {
  workspaceRoot: string;
  sessionId?: string;
  progressTailMaxChars?: number;
  finalAuditCommandTimeoutMs?: number;
  defaultPlanBudget?: PlanBudget;
  gatePolicy?: GatePolicy;
  precedentTieBreaker?: PrecedentTieBreaker;
  precedentEmbeddingProvider?: PrecedentEmbeddingProvider;
  digestDeliveryChannel?: string;
  digestPolicy?: DigestPolicy;
  digestDeliveryTransports?: DigestDeliveryTransport[];
  digestDeliverySlack?: SlackDigestTransportOptions;
  digestDeliveryEmail?: EmailDigestTransportOptions;
  guardrails?: GuardrailPolicy;
}

export class OrchestrationProvider {
  readonly server: SlopServer;
  private readonly repo: OrchestrationRepository;
  private readonly lifecycle: TaskLifecycle;
  private readonly plans: PlanLifecycle;
  private readonly verification: VerificationCoordinator;
  private readonly findings: FindingsCoordinator;
  private readonly handoffs: HandoffsCoordinator;
  private readonly gates: GatesCoordinator;
  private readonly goals: GoalsCoordinator;
  private readonly messages: MessagesCoordinator;
  private readonly precedents: PrecedentsCoordinator;
  private readonly digests: DigestCoordinator;
  private readonly drift: DriftCoordinator;
  private readonly wiring: DescriptorWiring;

  constructor(options: OrchestrationProviderOptions) {
    const sessionId = options.sessionId ?? "default";
    this.repo = new OrchestrationRepository({
      workspaceRoot: options.workspaceRoot,
      progressTailMaxChars: options.progressTailMaxChars,
      finalAuditCommandTimeoutMs: options.finalAuditCommandTimeoutMs,
    });

    debug("orchestration", "hydrate", this.repo.versionStats());

    this.server = createSlopServer({
      id: "orchestration",
      name: "Orchestration",
    });

    const refresh = () => this.server.refresh();

    this.gates = new GatesCoordinator({
      repo: this.repo,
      policy: normalizeGatePolicyInput(options.gatePolicy),
      refresh,
    });
    this.goals = new GoalsCoordinator({ repo: this.repo, gates: this.gates, refresh });
    this.drift = new DriftCoordinator({
      repo: this.repo,
      gates: this.gates,
      guardrails: options.guardrails,
      refresh,
    });
    this.lifecycle = new TaskLifecycle({
      repo: this.repo,
      gates: this.gates,
      drift: this.drift,
      refresh,
    });
    this.plans = new PlanLifecycle({
      repo: this.repo,
      lifecycle: this.lifecycle,
      gates: this.gates,
      sessionId,
      defaultPlanBudget: normalizePlanBudget(options.defaultPlanBudget),
      onDigestTrigger: (triggerReason) =>
        this.digests?.maybeGenerateTriggeredDigest({ trigger_reason: triggerReason }),
      refresh,
    });
    this.verification = new VerificationCoordinator({
      repo: this.repo,
      lifecycle: this.lifecycle,
      gates: this.gates,
      drift: this.drift,
      refresh,
    });
    this.findings = new FindingsCoordinator({
      repo: this.repo,
      lifecycle: this.lifecycle,
      refresh,
    });
    this.handoffs = new HandoffsCoordinator({ repo: this.repo, refresh });
    this.precedents = new PrecedentsCoordinator({
      repo: this.repo,
      tieBreaker: options.precedentTieBreaker,
      embeddingProvider: options.precedentEmbeddingProvider,
      refresh,
    });
    this.messages = new MessagesCoordinator({
      repo: this.repo,
      precedents: this.precedents,
      refresh,
    });
    this.digests = new DigestCoordinator({
      repo: this.repo,
      gates: this.gates,
      drift: this.drift,
      sessionId,
      policy: options.digestPolicy,
      deliveryChannel: options.digestDeliveryChannel,
      deliveryTransports: [
        ...(options.digestDeliveryTransports ?? []),
        ...(options.digestDeliverySlack
          ? [createSlackDigestTransport(options.digestDeliverySlack)]
          : []),
        ...(options.digestDeliveryEmail
          ? [createEmailDigestTransport(options.digestDeliveryEmail)]
          : []),
      ],
      refresh,
    });
    this.gates.setResolutionHandler((gate) => {
      this.goals.acceptGoalFromGate(gate);
      this.plans.acceptPlanRevisionFromGate(gate.id);
      this.digests.maybeGenerateTriggeredDigest({ trigger_reason: "goal_status_change" });
    });
    this.gates.setOpenHandler((gate) => {
      if (gate.resolver === "user" && gate.status === "open") {
        this.digests.maybeGenerateTriggeredDigest({ trigger_reason: "escalation" });
      }
    });

    this.wiring = {
      repo: this.repo,
      lifecycle: this.lifecycle,
      plans: this.plans,
      verification: this.verification,
      findings: this.findings,
      handoffs: this.handoffs,
      gates: this.gates,
      goals: this.goals,
      messages: this.messages,
      precedents: this.precedents,
      digests: this.digests,
      drift: this.drift,
      sessionId,
    };

    this.server.register("orchestration", () => buildRootDescriptor(this.wiring));
    this.server.register("tasks", () => buildTasksDescriptor(this.wiring));
    this.server.register("handoffs", () => buildHandoffsDescriptor(this.wiring));
    this.server.register("findings", () => buildFindingsDescriptor(this.wiring));
    this.server.register("goals", () => buildGoalsDescriptor(this.wiring));
    this.server.register("gates", () => buildGatesDescriptor(this.wiring));
    this.server.register("messages", () => buildMessagesDescriptor(this.wiring));
    this.server.register("precedents", () => buildPrecedentsDescriptor(this.wiring));
    this.server.register("audit", () => buildAuditDescriptor(this.wiring));
    this.server.register("blobs", () => buildBlobsDescriptor(this.wiring));
    this.server.register("budget", () => buildBudgetDescriptor(this.wiring));
    this.server.register("digests", () => buildDigestsDescriptor(this.wiring));
    this.server.register("drift", () => buildDriftDescriptor(this.wiring));
  }

  stop(): void {
    this.server.stop();
  }

  setPrecedentTieBreaker(tieBreaker: PrecedentTieBreaker | undefined): void {
    this.precedents.setTieBreaker(tieBreaker);
    this.server.refresh();
  }

  setPrecedentEmbeddingProvider(provider: PrecedentEmbeddingProvider | undefined): void {
    this.precedents.setEmbeddingProvider(provider);
    this.server.refresh();
  }
}
