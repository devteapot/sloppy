import { createRuntimeServiceKey } from "../../runtime/services";
import type { DelegationService } from "./delegation/service";
import type { MessagingService } from "./messaging/service";
import type { SkillsService } from "./skills/service";

export const SKILLS_SERVICE = createRuntimeServiceKey<SkillsService>("first-party:skills");
export const DELEGATION_SERVICE =
  createRuntimeServiceKey<DelegationService>("first-party:delegation");
export const MESSAGING_SERVICE = createRuntimeServiceKey<MessagingService>("first-party:messaging");
