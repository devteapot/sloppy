import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SlopConsumer } from "@slop-ai/consumer/browser";
import { MetaRuntimeProvider } from "../src/plugins/first-party/meta-runtime/provider";
import { InProcessTransport } from "../src/providers/in-process";

const tempPaths: string[] = [];

afterEach(async () => {
  while (tempPaths.length > 0) {
    const path = tempPaths.pop();
    if (path) {
      await rm(path, { recursive: true, force: true });
    }
  }
});

function harness(globalRoot: string, workspaceRoot: string) {
  const provider = new MetaRuntimeProvider({ globalRoot, workspaceRoot });
  const consumer = new SlopConsumer(new InProcessTransport(provider.server));
  return { provider, consumer };
}

async function connect(consumer: SlopConsumer): Promise<void> {
  await consumer.connect();
  await consumer.subscribe("/", 3);
}

async function readPersistedMetaStateFile(root: string): Promise<Record<string, unknown>> {
  const parsed = JSON.parse(await readFile(join(root, "state.json"), "utf8")) as Record<
    string,
    unknown
  >;
  return parsed.kind === "sloppy.meta-runtime.state" &&
    parsed.state &&
    typeof parsed.state === "object" &&
    !Array.isArray(parsed.state)
    ? (parsed.state as Record<string, unknown>)
    : parsed;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe("MetaRuntimeProvider — topology and state", () => {
  test("applies non-privileged session topology changes without approval", async () => {
    const root = await mkdtemp(join(tmpdir(), "sloppy-meta-"));
    tempPaths.push(root);
    const { provider, consumer } = harness(join(root, "global"), join(root, "workspace"));

    try {
      await connect(consumer);
      const proposed = await consumer.invoke("/session", "propose_change", {
        scope: "session",
        summary: "Create a review channel",
        ops: [
          {
            type: "upsertChannel",
            channel: {
              id: "review",
              topic: "review",
              participants: ["root"],
              visibility: "shared",
            },
          },
        ],
      });
      expect(proposed.status).toBe("ok");
      const proposalId = (proposed.data as { id: string }).id;

      const applied = await consumer.invoke(`/proposals/${proposalId}`, "apply_proposal", {});
      expect(applied.status).toBe("ok");

      const channels = await consumer.query("/channels", 2);
      expect(channels.children?.[0]?.id).toBe("review");
      expect(channels.children?.[0]?.properties?.participants).toEqual(["root"]);
    } finally {
      provider.stop();
    }
  });

  test("persistent topology changes require approval and write workspace state", async () => {
    const root = await mkdtemp(join(tmpdir(), "sloppy-meta-"));
    tempPaths.push(root);
    const workspaceRoot = join(root, "workspace");
    const { provider, consumer } = harness(join(root, "global"), workspaceRoot);

    try {
      await connect(consumer);
      const proposed = await consumer.invoke("/session", "propose_change", {
        scope: "workspace",
        summary: "Add reviewer profile",
        ops: [
          {
            type: "upsertAgentProfile",
            profile: {
              id: "reviewer",
              name: "Reviewer",
              instructions: "Inspect changes and report risks.",
            },
          },
        ],
      });
      expect(proposed.status).toBe("ok");
      const proposalId = (proposed.data as { id: string }).id;

      const blocked = await consumer.invoke(`/proposals/${proposalId}`, "apply_proposal", {});
      expect(blocked.status).toBe("error");
      expect(blocked.error?.code).toBe("approval_required");

      const approvals = await consumer.query("/approvals", 2);
      const approvalId = approvals.children?.[0]?.id;
      expect(typeof approvalId).toBe("string");
      const approved = await consumer.invoke(`/approvals/${approvalId}`, "approve", {});
      expect(approved.status).toBe("ok");

      const profiles = await consumer.query("/profiles", 2);
      expect(profiles.children?.[0]?.id).toBe("reviewer");
      const rawPersisted = JSON.parse(
        await readFile(join(workspaceRoot, "state.json"), "utf8"),
      ) as {
        kind: string;
        schema_version: number;
        state: { profiles: Array<{ id: string }> };
      };
      expect(rawPersisted.kind).toBe("sloppy.meta-runtime.state");
      expect(rawPersisted.schema_version).toBe(1);
      expect(rawPersisted.state.profiles.map((profile) => profile.id)).toContain("reviewer");
    } finally {
      provider.stop();
    }
  });

  test("session deny capability masks auto-apply but allow masks request approval", async () => {
    const root = await mkdtemp(join(tmpdir(), "sloppy-meta-"));
    tempPaths.push(root);
    const { provider, consumer } = harness(join(root, "global"), join(root, "workspace"));

    try {
      await connect(consumer);
      const denyProposal = await consumer.invoke("/session", "propose_change", {
        scope: "session",
        summary: "Deny shell writes",
        ops: [
          {
            type: "setCapabilityMask",
            mask: { id: "deny-terminal", provider: "terminal", actions: ["execute"], mode: "deny" },
          },
        ],
      });
      const denyId = (denyProposal.data as { id: string }).id;
      expect((denyProposal.data as { requiresApproval: boolean }).requiresApproval).toBe(false);
      expect((await consumer.invoke(`/proposals/${denyId}`, "apply_proposal", {})).status).toBe(
        "ok",
      );

      const allowProposal = await consumer.invoke("/session", "propose_change", {
        scope: "session",
        summary: "Allow filesystem writes",
        ops: [
          {
            type: "setCapabilityMask",
            mask: {
              id: "allow-filesystem",
              provider: "filesystem",
              actions: ["write"],
              mode: "allow",
            },
          },
        ],
      });
      const allowId = (allowProposal.data as { id: string }).id;
      expect((allowProposal.data as { requiresApproval: boolean }).requiresApproval).toBe(true);
      const blocked = await consumer.invoke(`/proposals/${allowId}`, "apply_proposal", {});
      expect(blocked.status).toBe("error");
      expect(blocked.error?.code).toBe("approval_required");
    } finally {
      provider.stop();
    }
  });

  test("loads global and workspace state with workspace values winning", async () => {
    const root = await mkdtemp(join(tmpdir(), "sloppy-meta-"));
    tempPaths.push(root);
    const globalRoot = join(root, "global");
    const workspaceRoot = join(root, "workspace");

    const first = harness(globalRoot, workspaceRoot);
    try {
      await connect(first.consumer);
      const globalProposal = await first.consumer.invoke("/session", "propose_change", {
        scope: "global",
        summary: "Global reviewer",
        ops: [
          {
            type: "upsertAgentProfile",
            profile: { id: "reviewer", name: "Global Reviewer" },
          },
        ],
      });
      const workspaceProposal = await first.consumer.invoke("/session", "propose_change", {
        scope: "workspace",
        summary: "Workspace reviewer",
        ops: [
          {
            type: "upsertAgentProfile",
            profile: { id: "reviewer", name: "Workspace Reviewer" },
          },
        ],
      });
      for (const proposal of [globalProposal, workspaceProposal]) {
        const proposalId = (proposal.data as { id: string }).id;
        await first.consumer.invoke(`/proposals/${proposalId}`, "apply_proposal", {});
        const approvals = await first.consumer.query("/approvals", 2);
        const approvalId = approvals.children?.find(
          (child) => child.properties?.status === "pending",
        )?.id;
        expect(typeof approvalId).toBe("string");
        await first.consumer.invoke(`/approvals/${approvalId}`, "approve", {});
      }
    } finally {
      first.provider.stop();
    }

    const second = harness(globalRoot, workspaceRoot);
    try {
      await connect(second.consumer);
      const profiles = await second.consumer.query("/profiles", 2);
      expect(profiles.children?.[0]?.properties?.name).toBe("Workspace Reviewer");
      const globalPersisted = (await readPersistedMetaStateFile(globalRoot)) as {
        profiles: Array<{ id: string; name: string }>;
      };
      const workspacePersisted = (await readPersistedMetaStateFile(workspaceRoot)) as {
        profiles: Array<{ id: string; name: string }>;
      };
      expect(globalPersisted.profiles).toContainEqual({
        id: "reviewer",
        name: "Global Reviewer",
      });
      expect(globalPersisted.profiles).not.toContainEqual({
        id: "reviewer",
        name: "Workspace Reviewer",
      });
      expect(workspacePersisted.profiles).toContainEqual({
        id: "reviewer",
        name: "Workspace Reviewer",
      });
      expect(workspacePersisted.profiles).not.toContainEqual({
        id: "reviewer",
        name: "Global Reviewer",
      });

      const replaced = await second.consumer.invoke("/session", "import_state", {
        scope: "workspace",
        mode: "replace",
        state: {},
      });
      expect(replaced.status).toBe("error");
      expect(replaced.error?.code).toBe("approval_required");
      const approvals = await second.consumer.query("/approvals", 2);
      const approvalId = approvals.children?.find(
        (child) => child.properties?.status === "pending",
      )?.id;
      expect(typeof approvalId).toBe("string");
      await second.consumer.invoke(`/approvals/${approvalId}`, "approve", {});
      const afterReplace = await second.consumer.query("/profiles", 2);
      expect(afterReplace.children?.[0]?.properties?.name).toBe("Global Reviewer");
    } finally {
      second.provider.stop();
    }
  });

  test("rejects unsupported meta-runtime state schema envelopes", async () => {
    const root = await mkdtemp(join(tmpdir(), "sloppy-meta-schema-"));
    tempPaths.push(root);
    const globalRoot = join(root, "global");
    await mkdir(globalRoot, { recursive: true });
    await writeFile(
      join(globalRoot, "state.json"),
      `${JSON.stringify(
        {
          kind: "sloppy.meta-runtime.state",
          schema_version: 999,
          saved_at: "2026-05-06T00:00:00.000Z",
          state: {},
        },
        null,
        2,
      )}\n`,
      "utf8",
    );

    expect(() => harness(globalRoot, join(root, "workspace"))).toThrow(
      "unsupported schema_version 999",
    );
  });

  test("validates topology proposals before mutating runtime state", async () => {
    const root = await mkdtemp(join(tmpdir(), "sloppy-meta-"));
    tempPaths.push(root);
    const { provider, consumer } = harness(join(root, "global"), join(root, "workspace"));

    try {
      await connect(consumer);
      const proposed = await consumer.invoke("/session", "propose_change", {
        scope: "session",
        summary: "Invalid route",
        ops: [
          {
            type: "upsertRoute",
            route: {
              id: "bad-route",
              source: "root",
              match: "*",
              target: "agent:missing",
              enabled: true,
            },
          },
        ],
      });
      expect(proposed.status).toBe("ok");
      const proposalId = (proposed.data as { id: string }).id;
      const applied = await consumer.invoke(`/proposals/${proposalId}`, "apply_proposal", {});
      expect(applied.status).toBe("error");
      expect(applied.error?.message).toContain("unknown target agent missing");

      const routes = await consumer.query("/routes", 2);
      expect(routes.properties?.count).toBe(0);
    } finally {
      provider.stop();
    }
  });

  test("rejects invalid route matcher configuration before storing proposals", async () => {
    const root = await mkdtemp(join(tmpdir(), "sloppy-meta-"));
    tempPaths.push(root);
    const { provider, consumer } = harness(join(root, "global"), join(root, "workspace"));

    try {
      await connect(consumer);
      const proposed = await consumer.invoke("/session", "propose_change", {
        scope: "session",
        summary: "Invalid matcher",
        ops: [
          {
            type: "upsertRoute",
            route: {
              id: "bad-regex-route",
              source: "root",
              match: "[",
              matchMode: "regex",
              target: "channel:review",
              enabled: true,
            },
          },
        ],
      });
      expect(proposed.status).toBe("error");
      expect(proposed.error?.message).toContain("valid regular expression");
      const proposals = await consumer.query("/proposals", 2);
      expect(proposals.properties?.count).toBe(0);
    } finally {
      provider.stop();
    }
  });

  test("expires proposals that pass their ttl before apply", async () => {
    const root = await mkdtemp(join(tmpdir(), "sloppy-meta-"));
    tempPaths.push(root);
    const { provider, consumer } = harness(join(root, "global"), join(root, "workspace"));

    try {
      await connect(consumer);
      const proposed = await consumer.invoke("/session", "propose_change", {
        scope: "session",
        summary: "Short-lived channel",
        ttl_ms: 1,
        ops: [
          {
            type: "upsertChannel",
            channel: {
              id: "brief",
              topic: "brief",
              participants: ["root"],
              visibility: "shared",
            },
          },
        ],
      });
      expect(proposed.status).toBe("ok");
      const proposalId = (proposed.data as { id: string }).id;
      await sleep(5);
      const applied = await consumer.invoke(`/proposals/${proposalId}`, "apply_proposal", {});
      expect(applied.status).toBe("error");
      expect(applied.error?.message).toContain("expired before it could be applied");

      const proposal = await consumer.query(`/proposals/${proposalId}`, 1);
      expect(proposal.properties?.status).toBe("expired");
      const channels = await consumer.query("/channels", 2);
      expect(channels.properties?.count).toBe(0);
    } finally {
      provider.stop();
    }
  });
});
