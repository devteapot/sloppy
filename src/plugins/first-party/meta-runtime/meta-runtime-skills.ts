import type { SkillsService } from "../skills/service";
import type { Proposal, SkillVersion, TopologyChange } from "./meta-runtime-model";

type SkillActivationFailureRecorder = (skillVersionId: string, reason: string) => void;

type SkillProposalState = {
  status?: string;
  scope?: string;
  requiresApproval?: boolean;
};

async function readSkillProposalState(
  skills: SkillsService,
  proposalId: string,
): Promise<SkillProposalState> {
  const proposal = await skills.getSkillProposal(proposalId);
  const status = proposal?.status;
  const scope = proposal?.scope;
  const requiresApproval = proposal?.requires_approval;
  return {
    status: typeof status === "string" ? status : undefined,
    scope: typeof scope === "string" ? scope : undefined,
    requiresApproval: typeof requiresApproval === "boolean" ? requiresApproval : undefined,
  };
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
  skills: SkillsService | null,
  recordFailure: SkillActivationFailureRecorder,
): Promise<Map<string, SkillVersion>> {
  const activated = new Map<string, SkillVersion>();
  const skillOps = proposal.ops.filter(
    (op): op is Extract<TopologyChange, { type: "activateSkillVersion" }> =>
      op.type === "activateSkillVersion" && typeof op.skillVersion.proposalId === "string",
  );
  if (skillOps.length === 0) return activated;

  if (!skills) {
    const reason = "Skills runtime service is not enabled for skill activation.";
    for (const op of skillOps) {
      recordFailure(op.skillVersion.id, reason);
    }
    throw new Error(reason);
  }

  for (const op of skillOps) {
    const skillProposalId = op.skillVersion.proposalId;
    if (!skillProposalId) continue;

    const before = await readSkillProposalState(skills, skillProposalId).catch(
      (): SkillProposalState => ({}),
    );
    if (before.status === "active") {
      activated.set(op.skillVersion.id, activatedSkillVersion(op.skillVersion));
      continue;
    }
    if (before.status !== undefined && before.status !== "proposed") {
      const reason = `Linked skill proposal ${skillProposalId} is ${before.status}, not proposed or active.`;
      recordFailure(op.skillVersion.id, reason);
      throw new Error(reason);
    }
    if (before.status === "proposed" && (before.requiresApproval || before.scope !== "session")) {
      const reason = `Linked skill proposal ${skillProposalId} is a persistent skill proposal. Activate it through the skills provider before applying this meta-runtime proposal.`;
      recordFailure(op.skillVersion.id, reason);
      throw new Error(reason);
    }

    try {
      await skills.activateSkillProposal(skillProposalId);
    } catch (error) {
      const after = await readSkillProposalState(skills, skillProposalId).catch(
        (): SkillProposalState => ({}),
      );
      if (after.status === "active") {
        activated.set(op.skillVersion.id, activatedSkillVersion(op.skillVersion));
        continue;
      }
      const reason =
        error instanceof Error
          ? error.message
          : `Failed to activate linked skill proposal ${skillProposalId}.`;
      recordFailure(op.skillVersion.id, reason);
      throw new Error(reason);
    }

    activated.set(op.skillVersion.id, activatedSkillVersion(op.skillVersion));
  }

  return activated;
}
