import type { ProviderRuntimeHub } from "../../core/hub";
import type { Proposal, SkillVersion, TopologyChange } from "./meta-runtime-model";

type SkillActivationFailureRecorder = (skillVersionId: string, reason: string) => void;

async function readSkillProposalStatus(
  hub: ProviderRuntimeHub,
  proposalId: string,
): Promise<string | undefined> {
  const proposal = await hub.queryState({
    providerId: "skills",
    path: `/proposals/${proposalId}`,
    depth: 1,
  });
  const status = proposal.properties?.status;
  return typeof status === "string" ? status : undefined;
}

function activatedSkillVersion(skillVersion: SkillVersion): SkillVersion {
  return {
    ...skillVersion,
    active: true,
    activationStatus: "active",
  };
}

export function opsWithActivatedSkills(
  ops: TopologyChange[],
  activatedSkillVersions: Map<string, SkillVersion>,
): TopologyChange[] {
  if (activatedSkillVersions.size === 0) return ops;
  return ops.map((op) => {
    if (op.type !== "activateSkillVersion") return op;
    return {
      ...op,
      skillVersion: activatedSkillVersions.get(op.skillVersion.id) ?? op.skillVersion,
    };
  });
}

export async function activateLinkedSkills(
  proposal: Proposal,
  hub: ProviderRuntimeHub | null,
  recordFailure: SkillActivationFailureRecorder,
): Promise<Map<string, SkillVersion>> {
  const activated = new Map<string, SkillVersion>();
  const skillOps = proposal.ops.filter(
    (op): op is Extract<TopologyChange, { type: "activateSkillVersion" }> =>
      op.type === "activateSkillVersion" && typeof op.skillVersion.proposalId === "string",
  );
  if (skillOps.length === 0) return activated;

  if (!hub) {
    const reason = "No hub attached for skill activation.";
    for (const op of skillOps) {
      recordFailure(op.skillVersion.id, reason);
    }
    throw new Error(reason);
  }

  for (const op of skillOps) {
    const skillProposalId = op.skillVersion.proposalId;
    if (!skillProposalId) continue;

    const beforeStatus = await readSkillProposalStatus(hub, skillProposalId).catch(() => undefined);
    if (beforeStatus === "active") {
      activated.set(op.skillVersion.id, activatedSkillVersion(op.skillVersion));
      continue;
    }
    if (beforeStatus !== undefined && beforeStatus !== "proposed") {
      const reason = `Linked skill proposal ${skillProposalId} is ${beforeStatus}, not proposed or active.`;
      recordFailure(op.skillVersion.id, reason);
      throw new Error(reason);
    }

    const result = await hub.invoke(
      "skills",
      `/proposals/${skillProposalId}`,
      "activate_skill_proposal",
    );
    if (result.status === "error") {
      const afterStatus = await readSkillProposalStatus(hub, skillProposalId).catch(
        () => undefined,
      );
      if (afterStatus === "active") {
        activated.set(op.skillVersion.id, activatedSkillVersion(op.skillVersion));
        continue;
      }
      const reason =
        result.error?.message ?? `Failed to activate linked skill proposal ${skillProposalId}.`;
      recordFailure(op.skillVersion.id, reason);
      throw new Error(reason);
    }

    activated.set(op.skillVersion.id, activatedSkillVersion(op.skillVersion));
  }

  return activated;
}
