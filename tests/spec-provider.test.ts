import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SlopConsumer } from "@slop-ai/consumer/browser";

import { InProcessTransport } from "../src/providers/builtin/in-process";
import { SpecProvider } from "../src/providers/builtin/spec";

const tempPaths: string[] = [];

afterEach(async () => {
  while (tempPaths.length > 0) {
    const path = tempPaths.pop();
    if (!path) continue;
    await rm(path, { recursive: true, force: true });
  }
});

async function harness() {
  const root = await mkdtemp(join(tmpdir(), "sloppy-spec-"));
  tempPaths.push(root);
  const provider = new SpecProvider({ workspaceRoot: root });
  const consumer = new SlopConsumer(new InProcessTransport(provider.server));
  await consumer.connect();
  await consumer.subscribe("/", 4);
  return { root, provider, consumer };
}

describe("SpecProvider", () => {
  test("creates an active spec and persists requirements", async () => {
    const { root, provider, consumer } = await harness();

    try {
      const created = await consumer.invoke("/specs", "create_spec", {
        title: "Audit workflow",
        body: "# Audit workflow\n\nImplementation must be checked against spec.",
      });
      expect(created.status).toBe("ok");
      const specId = (created.data as { id: string }).id;

      const specs = await consumer.query("/specs", 3);
      expect(specs.properties?.active_spec_id).toBe(specId);
      expect(specs.children?.[0]?.properties?.active).toBe(true);

      const requirement = await consumer.invoke(`/specs/${specId}`, "add_requirement", {
        text: "Audit findings block completion until resolved.",
        priority: "must",
        tags: ["audit"],
      });
      expect(requirement.status).toBe("ok");
      const requirementId = (requirement.data as { id: string }).id;

      const requirements = await consumer.query(`/specs/${specId}/requirements`, 2);
      expect(requirements.children?.[0]?.id).toBe(requirementId);
      expect(requirements.children?.[0]?.properties?.text).toContain("block completion");

      const persisted = join(root, ".sloppy", "specs", "specs", specId, "requirements.json");
      expect(existsSync(persisted)).toBe(true);
      expect(readFileSync(persisted, "utf8")).toContain(requirementId);
    } finally {
      provider.stop();
    }
  });

  test("records decisions and approves proposed changes", async () => {
    const { provider, consumer } = await harness();

    try {
      const created = await consumer.invoke("/specs", "create_spec", {
        title: "Spec changes",
      });
      const specId = (created.data as { id: string }).id;

      const decision = await consumer.invoke(`/specs/${specId}`, "record_decision", {
        summary: "Repairs should be separate tasks.",
        rationale: "Keeps audit context small.",
      });
      expect(decision.status).toBe("ok");

      const change = await consumer.invoke(`/specs/${specId}`, "propose_change", {
        summary: "Allow accepted deviations",
        details: "Blocking findings may be accepted with a recorded reason.",
      });
      expect(change.status).toBe("ok");
      const changeId = (change.data as { id: string }).id;

      const approved = await consumer.invoke(
        `/specs/${specId}/changes/${changeId}`,
        "approve_change",
        {
          reason: "Needed for intentional product decisions.",
        },
      );
      expect(approved.status).toBe("ok");

      const changes = await consumer.query(`/specs/${specId}/changes`, 2);
      expect(changes.children?.[0]?.properties?.status).toBe("approved");

      const decisions = await consumer.query(`/specs/${specId}/decisions`, 2);
      expect(decisions.children?.[0]?.properties?.summary).toContain("Repairs");
    } finally {
      provider.stop();
    }
  });
});
