import type { FindingsCoordinator } from "./findings";
import type { HandoffsCoordinator } from "./handoffs";
import type { TaskLifecycle } from "./lifecycle";
import type { PlanLifecycle } from "./plan-lifecycle";
import type { OrchestrationRepository } from "./repository";
import type { VerificationCoordinator } from "./verification";

export interface DescriptorWiring {
  repo: OrchestrationRepository;
  lifecycle: TaskLifecycle;
  plans: PlanLifecycle;
  verification: VerificationCoordinator;
  findings: FindingsCoordinator;
  handoffs: HandoffsCoordinator;
  sessionId: string;
}
