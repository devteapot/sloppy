import type { DigestCoordinator } from "./digests";
import type { DriftCoordinator } from "./drift";
import type { FindingsCoordinator } from "./findings";
import type { GatesCoordinator } from "./gates";
import type { GoalsCoordinator } from "./goals";
import type { HandoffsCoordinator } from "./handoffs";
import type { TaskLifecycle } from "./lifecycle";
import type { MessagesCoordinator } from "./messages";
import type { PlanLifecycle } from "./plan-lifecycle";
import type { PrecedentsCoordinator } from "./precedents";
import type { OrchestrationRepository } from "./repository";
import type { VerificationCoordinator } from "./verification";

export interface DescriptorWiring {
  repo: OrchestrationRepository;
  lifecycle: TaskLifecycle;
  plans: PlanLifecycle;
  verification: VerificationCoordinator;
  findings: FindingsCoordinator;
  handoffs: HandoffsCoordinator;
  gates: GatesCoordinator;
  goals: GoalsCoordinator;
  messages: MessagesCoordinator;
  precedents: PrecedentsCoordinator;
  digests: DigestCoordinator;
  drift: DriftCoordinator;
  sessionId: string;
}
