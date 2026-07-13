import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SlopConsumer } from "@slop-ai/consumer/browser";

import { ConsumerHub } from "../src/core/consumer";
import { MetaRuntimeProvider } from "../src/plugins/first-party/meta-runtime/provider";
import { SKILLS_SERVICE } from "../src/plugins/first-party/service-keys";
import { SkillsProvider } from "../src/plugins/first-party/skills/provider";
import { InProcessTransport } from "../src/providers/in-process";
import { createFirstPartyProviders, type RegisteredProvider } from "../src/providers/registry";
import { createTestConfig } from "./helpers/config";

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

function registeredMetaProvider(provider: MetaRuntimeProvider): RegisteredProvider {
  return {
    id: "meta-runtime",
    name: "Meta Runtime",
    kind: "first-party",
    transport: new InProcessTransport(provider.server),
    transportLabel: "in-process:test",
    stop: () => provider.stop(),
    approvals: provider.approvals,
  };
}

function registeredSkillsProvider(provider: SkillsProvider): RegisteredProvider {
  return {
    id: "skills",
    name: "Skills",
    kind: "first-party",
    transport: new InProcessTransport(provider.server),
    transportLabel: "in-process:test",
    stop: () => provider.stop(),
    approvals: provider.approvals,
  };
}

const TEST_CONFIG = createTestConfig({
  agent: { maxIterations: 1 },
});

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

describe("MetaRuntimeProvider — bundles and registry", () => {
  test("exports merged state and approval-gates persistent imports", async () => {
    const root = await mkdtemp(join(tmpdir(), "sloppy-meta-"));
    tempPaths.push(root);
    const workspaceRoot = join(root, "workspace");
    const { provider, consumer } = harness(join(root, "global"), workspaceRoot);

    try {
      await connect(consumer);
      const imported = await consumer.invoke("/session", "import_state", {
        scope: "workspace",
        mode: "merge",
        state: {
          profiles: [{ id: "imported", name: "Imported" }],
        },
      });
      expect(imported.status).toBe("error");
      expect(imported.error?.code).toBe("approval_required");
      const approvals = await consumer.query("/approvals", 2);
      const approvalId = approvals.children?.[0]?.id;
      expect(typeof approvalId).toBe("string");
      expect((await consumer.invoke(`/approvals/${approvalId}`, "approve", {})).status).toBe("ok");

      const exported = await consumer.invoke("/session", "export_state", {});
      expect(exported.status).toBe("ok");
      expect(
        (exported.data as { profiles: Array<{ id: string; name: string }> }).profiles,
      ).toContainEqual({
        id: "imported",
        name: "Imported",
      });
      const persisted = (await readPersistedMetaStateFile(workspaceRoot)) as {
        profiles: Array<{ id: string }>;
      };
      expect(persisted.profiles.map((profile) => profile.id)).toContain("imported");
    } finally {
      provider.stop();
    }
  });

  test("rejects malformed imported meta-runtime state before mutation", async () => {
    const root = await mkdtemp(join(tmpdir(), "sloppy-meta-"));
    tempPaths.push(root);
    const { provider, consumer } = harness(join(root, "global"), join(root, "workspace"));

    try {
      await connect(consumer);
      const imported = await consumer.invoke("/session", "import_state", {
        scope: "session",
        state: {
          profiles: [{ name: "No Id" }],
        },
      });
      expect(imported.status).toBe("error");
      expect(imported.error?.message).toContain("state.profiles[0].id");

      const bundled = await consumer.invoke("/session", "import_bundle", {
        scope: "session",
        bundle: {
          kind: "sloppy.meta-runtime.bundle",
          schema_version: 1,
          exported_at: "2026-05-06T00:00:00.000Z",
          scope: "merged",
          state: {
            profiles: [{ name: "No Id" }],
          },
          skills: [],
          notes: { secrets: "excluded" },
        },
      });
      expect(bundled.status).toBe("error");
      expect(bundled.error?.message).toContain("state.profiles[0].id");

      const forgedProposal = {
        id: "proposal-forged-global",
        scope: "global",
        summary: "Forged global write",
        status: "proposed",
        requiresApproval: false,
        createdAt: "2026-05-06T00:00:00.000Z",
        ops: [
          {
            type: "upsertAgentProfile",
            profile: { id: "forged", name: "Forged" },
          },
        ],
      };
      const forgedImported = await consumer.invoke("/session", "import_state", {
        scope: "session",
        state: {
          proposals: [forgedProposal],
        },
      });
      expect(forgedImported.status).toBe("error");
      expect(forgedImported.error?.message).toContain("requiresApproval");

      const forgedBundle = await consumer.invoke("/session", "import_bundle", {
        scope: "session",
        bundle: {
          kind: "sloppy.meta-runtime.bundle",
          schema_version: 1,
          exported_at: "2026-05-06T00:00:00.000Z",
          scope: "merged",
          state: {
            proposals: [forgedProposal],
          },
          skills: [],
          notes: { secrets: "excluded" },
        },
      });
      expect(forgedBundle.status).toBe("error");
      expect(forgedBundle.error?.message).toContain("requiresApproval");

      const profiles = await consumer.query("/profiles", 2);
      expect((profiles.children ?? []).map((child) => child.id)).not.toContain("undefined");
      expect(profiles.properties?.count).toBe(0);
      const proposals = await consumer.query("/proposals", 2);
      expect(proposals.properties?.count).toBe(0);
    } finally {
      provider.stop();
    }
  });

  test("imported persistent-scope proposals still require approval on apply", async () => {
    const root = await mkdtemp(join(tmpdir(), "sloppy-meta-"));
    tempPaths.push(root);
    const { provider, consumer } = harness(join(root, "global"), join(root, "workspace"));

    try {
      await connect(consumer);
      const imported = await consumer.invoke("/session", "import_state", {
        scope: "session",
        state: {
          proposals: [
            {
              id: "proposal-global-import",
              scope: "global",
              summary: "Imported global profile",
              status: "proposed",
              requiresApproval: true,
              createdAt: "2026-05-06T00:00:00.000Z",
              ops: [
                {
                  type: "upsertAgentProfile",
                  profile: { id: "global-imported", name: "Global Imported" },
                },
              ],
            },
          ],
        },
      });
      expect(imported.status).toBe("ok");

      const proposal = await consumer.query("/proposals/proposal-global-import", 1);
      expect(proposal.properties?.requiresApproval).toBe(true);
      const applied = await consumer.invoke(
        "/proposals/proposal-global-import",
        "apply_proposal",
        {},
      );
      expect(applied.status).toBe("error");
      expect(applied.error?.code).toBe("approval_required");
      const beforeApproval = await consumer.query("/profiles", 2);
      expect((beforeApproval.children ?? []).map((child) => child.id)).not.toContain(
        "global-imported",
      );

      const approvals = await consumer.query("/approvals", 2);
      const approvalId = approvals.children?.find(
        (child) => child.properties?.status === "pending",
      )?.id;
      expect(typeof approvalId).toBe("string");
      expect((await consumer.invoke(`/approvals/${approvalId}`, "approve", {})).status).toBe("ok");
      const afterApproval = await consumer.query("/profiles", 2);
      expect((afterApproval.children ?? []).map((child) => child.id)).toContain("global-imported");
    } finally {
      provider.stop();
    }
  });

  test("exports and imports portable runtime bundles with active skill contents", async () => {
    const root = await mkdtemp(join(tmpdir(), "sloppy-meta-"));
    tempPaths.push(root);
    const sourceMeta = new MetaRuntimeProvider({
      globalRoot: join(root, "source-global"),
      workspaceRoot: join(root, "source-workspace"),
    });
    const sourceSkills = new SkillsProvider({ skillsDir: join(root, "source-skills") });
    sourceMeta.bindRuntimeService(SKILLS_SERVICE, sourceSkills);
    const sourceMetaRegistration = registeredMetaProvider(sourceMeta);
    const sourceHub = new ConsumerHub(
      [sourceMetaRegistration, registeredSkillsProvider(sourceSkills)],
      TEST_CONFIG,
    );

    const targetMeta = new MetaRuntimeProvider({
      globalRoot: join(root, "target-global"),
      workspaceRoot: join(root, "target-workspace"),
    });
    const targetSkills = new SkillsProvider({ skillsDir: join(root, "target-skills") });
    targetMeta.bindRuntimeService(SKILLS_SERVICE, targetSkills);
    const targetMetaRegistration = registeredMetaProvider(targetMeta);
    const targetHub = new ConsumerHub(
      [targetMetaRegistration, registeredSkillsProvider(targetSkills)],
      TEST_CONFIG,
    );

    try {
      await sourceHub.connect();
      const sourceStop = sourceMetaRegistration.attachRuntime?.(sourceHub, TEST_CONFIG);
      const sourceMetaConsumer = new SlopConsumer(new InProcessTransport(sourceMeta.server));
      const sourceSkillsConsumer = new SlopConsumer(new InProcessTransport(sourceSkills.server));
      await connect(sourceMetaConsumer);
      await connect(sourceSkillsConsumer);

      expect(
        (
          await sourceSkillsConsumer.invoke("/session", "skill_manage", {
            operation: "create",
            scope: "session",
            name: "bundle-review",
            content: "# Bundle Review\n\nReview imported topology.\n",
          })
        ).status,
      ).toBe("ok");

      const proposal = await sourceMetaConsumer.invoke("/session", "propose_change", {
        scope: "session",
        summary: "Bundle identity",
        ops: [
          {
            type: "upsertAgentProfile",
            profile: { id: "reviewer", name: "Reviewer", instructions: "Review bundles." },
          },
          {
            type: "activateSkillVersion",
            skillVersion: {
              id: "bundle-review@1.0.0",
              skillId: "bundle-review",
              version: "1.0.0",
              scope: "session",
              active: true,
              activationStatus: "active",
            },
          },
        ],
      });
      const proposalId = (proposal.data as { id: string }).id;
      expect(
        (await sourceMetaConsumer.invoke(`/proposals/${proposalId}`, "apply_proposal", {})).status,
      ).toBe("error");
      const approvals = await sourceMetaConsumer.query("/approvals", 2);
      const approvalId = approvals.children?.find(
        (child) => child.properties?.status === "pending",
      )?.id;
      expect(typeof approvalId).toBe("string");
      expect(
        (await sourceMetaConsumer.invoke(`/approvals/${approvalId}`, "approve", {})).status,
      ).toBe("ok");

      const exported = await sourceMetaConsumer.invoke("/session", "export_bundle", {});
      expect(exported.status).toBe("ok");
      const bundle = exported.data as {
        kind: string;
        state: { profiles?: Array<{ id: string }> };
        skills: Array<{ name: string; content: string; content_sha256?: string }>;
        notes: { secrets: string };
      };
      expect(bundle.kind).toBe("sloppy.meta-runtime.bundle");
      expect(bundle.notes.secrets).toBe("excluded");
      expect(bundle.state.profiles?.map((profile) => profile.id)).toContain("reviewer");
      expect(bundle.skills[0]?.name).toBe("bundle-review");
      expect(bundle.skills[0]?.content).toContain("# Bundle Review");
      expect(bundle.skills[0]?.content_sha256).toMatch(/^[a-f0-9]{64}$/);

      await targetHub.connect();
      const targetStop = targetMetaRegistration.attachRuntime?.(targetHub, TEST_CONFIG);
      const targetMetaConsumer = new SlopConsumer(new InProcessTransport(targetMeta.server));
      const targetSkillsConsumer = new SlopConsumer(new InProcessTransport(targetSkills.server));
      await connect(targetMetaConsumer);
      await connect(targetSkillsConsumer);

      const imported = await targetMetaConsumer.invoke("/session", "import_bundle", {
        bundle,
        scope: "session",
      });
      expect(imported.status).toBe("ok");
      const importedProfiles = await targetMetaConsumer.query("/profiles", 2);
      expect(importedProfiles.children?.map((child) => child.id)).toContain("reviewer");
      const importedSkillVersions = await targetMetaConsumer.query("/skill-versions", 2);
      expect(importedSkillVersions.children?.map((child) => child.id)).toContain(
        "bundle-review@1.0.0",
      );
      const importedSkill = await targetSkillsConsumer.invoke("/session", "skill_view", {
        name: "bundle-review",
      });
      expect(importedSkill.status).toBe("ok");
      expect((importedSkill.data as { content: string }).content).toContain(
        "Review imported topology.",
      );
      sourceStop?.stop();
      targetStop?.stop();
    } finally {
      sourceHub.shutdown();
      targetHub.shutdown();
    }
  });

  test("import_bundle dry_run reports skill import plan without committing topology", async () => {
    const root = await mkdtemp(join(tmpdir(), "sloppy-meta-"));
    tempPaths.push(root);
    const targetMeta = new MetaRuntimeProvider({
      globalRoot: join(root, "target-global"),
      workspaceRoot: join(root, "target-workspace"),
    });
    const targetSkills = new SkillsProvider({ skillsDir: join(root, "target-skills") });
    targetMeta.bindRuntimeService(SKILLS_SERVICE, targetSkills);
    const targetMetaRegistration = registeredMetaProvider(targetMeta);
    const targetHub = new ConsumerHub(
      [targetMetaRegistration, registeredSkillsProvider(targetSkills)],
      TEST_CONFIG,
    );

    try {
      await targetHub.connect();
      const targetStop = targetMetaRegistration.attachRuntime?.(targetHub, TEST_CONFIG);
      const targetMetaConsumer = new SlopConsumer(new InProcessTransport(targetMeta.server));
      const targetSkillsConsumer = new SlopConsumer(new InProcessTransport(targetSkills.server));
      await connect(targetMetaConsumer);
      await connect(targetSkillsConsumer);

      const bundle = {
        kind: "sloppy.meta-runtime.bundle",
        schema_version: 1,
        exported_at: "2026-05-06T00:00:00.000Z",
        scope: "merged",
        state: {
          profiles: [{ id: "reviewer", name: "Reviewer", instructions: "Review bundles." }],
          skillVersions: [
            {
              id: "bundle-review@1.0.0",
              skillId: "bundle-review",
              version: "1.0.0",
              scope: "session",
              active: true,
              activationStatus: "active",
            },
          ],
        },
        skills: [
          {
            name: "bundle-review",
            content: "# Bundle Review\n\nReview imported topology.\n",
          },
        ],
        notes: { secrets: "excluded" },
      };

      const preview = await targetMetaConsumer.invoke("/session", "import_bundle", {
        bundle,
        scope: "session",
        dry_run: true,
      });
      expect(preview.status).toBe("ok");
      expect(preview.data).toMatchObject({
        scope: "session",
        mode: "merge",
        imported: false,
        dry_run: true,
        skills: {
          created: ["bundle-review"],
          skipped: [],
          failed: [],
        },
        required_skills: {
          count: 1,
          missing: [],
        },
      });

      const importedProfiles = await targetMetaConsumer.query("/profiles", 2);
      expect((importedProfiles.children ?? []).map((child) => child.id)).not.toContain("reviewer");
      const importedSkill = await targetSkillsConsumer.invoke("/session", "skill_view", {
        name: "bundle-review",
      });
      expect(importedSkill.status).toBe("error");
      targetStop?.stop();
    } finally {
      targetHub.shutdown();
    }
  });

  test("import_bundle does not commit topology when bundled skill import fails", async () => {
    const root = await mkdtemp(join(tmpdir(), "sloppy-meta-"));
    tempPaths.push(root);
    const targetMeta = new MetaRuntimeProvider({
      globalRoot: join(root, "target-global"),
      workspaceRoot: join(root, "target-workspace"),
    });
    const targetSkills = new SkillsProvider({ skillsDir: join(root, "target-skills") });
    targetMeta.bindRuntimeService(SKILLS_SERVICE, targetSkills);
    const targetMetaRegistration = registeredMetaProvider(targetMeta);
    const targetHub = new ConsumerHub(
      [targetMetaRegistration, registeredSkillsProvider(targetSkills)],
      TEST_CONFIG,
    );

    try {
      await targetHub.connect();
      const targetStop = targetMetaRegistration.attachRuntime?.(targetHub, TEST_CONFIG);
      const targetMetaConsumer = new SlopConsumer(new InProcessTransport(targetMeta.server));
      await connect(targetMetaConsumer);

      const bundle = {
        kind: "sloppy.meta-runtime.bundle",
        schema_version: 1,
        exported_at: "2026-05-06T00:00:00.000Z",
        scope: "merged",
        state: {
          profiles: [{ id: "reviewer", name: "Reviewer", instructions: "Review bundles." }],
          skillVersions: [
            {
              id: "bundle-review@1.0.0",
              skillId: "bundle-review",
              version: "1.0.0",
              scope: "session",
              active: true,
              activationStatus: "active",
            },
          ],
        },
        skills: [
          {
            name: "bundle-review",
            content: "# Bundle Review\n\nReview imported topology.\n",
          },
        ],
        notes: { secrets: "excluded" },
      };

      const imported = await targetMetaConsumer.invoke("/session", "import_bundle", {
        bundle,
        scope: "session",
        skill_scope: "workspace",
      });
      expect(imported.status).toBe("error");
      expect(imported.error?.message).toContain("topology was not imported");

      const importedProfiles = await targetMetaConsumer.query("/profiles", 2);
      expect((importedProfiles.children ?? []).map((child) => child.id)).not.toContain("reviewer");
      const importedSkillVersions = await targetMetaConsumer.query("/skill-versions", 2);
      expect((importedSkillVersions.children ?? []).map((child) => child.id)).not.toContain(
        "bundle-review@1.0.0",
      );
      targetStop?.stop();
    } finally {
      targetHub.shutdown();
    }
  });

  test("import_bundle rejects mismatched bundled skill hashes before mutation", async () => {
    const root = await mkdtemp(join(tmpdir(), "sloppy-meta-"));
    tempPaths.push(root);
    const targetMeta = new MetaRuntimeProvider({
      globalRoot: join(root, "target-global"),
      workspaceRoot: join(root, "target-workspace"),
    });
    const targetSkills = new SkillsProvider({ skillsDir: join(root, "target-skills") });
    targetMeta.bindRuntimeService(SKILLS_SERVICE, targetSkills);
    const targetMetaRegistration = registeredMetaProvider(targetMeta);
    const targetHub = new ConsumerHub(
      [targetMetaRegistration, registeredSkillsProvider(targetSkills)],
      TEST_CONFIG,
    );

    try {
      await targetHub.connect();
      const targetStop = targetMetaRegistration.attachRuntime?.(targetHub, TEST_CONFIG);
      const targetMetaConsumer = new SlopConsumer(new InProcessTransport(targetMeta.server));
      await connect(targetMetaConsumer);

      const imported = await targetMetaConsumer.invoke("/session", "import_bundle", {
        scope: "session",
        bundle: {
          kind: "sloppy.meta-runtime.bundle",
          schema_version: 1,
          exported_at: "2026-05-06T00:00:00.000Z",
          scope: "merged",
          state: {
            profiles: [{ id: "reviewer", name: "Reviewer", instructions: "Review bundles." }],
            skillVersions: [
              {
                id: "bundle-review@1.0.0",
                skillId: "bundle-review",
                version: "1.0.0",
                scope: "session",
                active: true,
                activationStatus: "active",
              },
            ],
          },
          skills: [
            {
              name: "bundle-review",
              content: "# Bundle Review\n\nTampered content.\n",
              content_sha256: "0".repeat(64),
            },
          ],
          notes: { secrets: "excluded" },
        },
      });
      expect(imported.status).toBe("error");
      expect(imported.error?.message).toContain("content_sha256");

      const importedFileHash = await targetMetaConsumer.invoke("/session", "import_bundle", {
        scope: "session",
        bundle: {
          kind: "sloppy.meta-runtime.bundle",
          schema_version: 1,
          exported_at: "2026-05-06T00:00:00.000Z",
          scope: "merged",
          state: {},
          skills: [
            {
              name: "bundle-review",
              content: "# Bundle Review\n\nContent.\n",
              files: [{ path: "notes.md", content: "notes", sha256: "0".repeat(64) }],
            },
          ],
          notes: { secrets: "excluded" },
        },
      });
      expect(importedFileHash.status).toBe("error");
      expect(importedFileHash.error?.message).toContain("files[0].sha256");

      const importedProfiles = await targetMetaConsumer.query("/profiles", 2);
      expect((importedProfiles.children ?? []).map((child) => child.id)).not.toContain("reviewer");
      targetStop?.stop();
    } finally {
      targetHub.shutdown();
    }
  });

  test("import_bundle preflights existing skill collisions before topology mutation", async () => {
    const root = await mkdtemp(join(tmpdir(), "sloppy-meta-"));
    tempPaths.push(root);
    const targetMeta = new MetaRuntimeProvider({
      globalRoot: join(root, "target-global"),
      workspaceRoot: join(root, "target-workspace"),
    });
    const targetSkills = new SkillsProvider({ skillsDir: join(root, "target-skills") });
    targetMeta.bindRuntimeService(SKILLS_SERVICE, targetSkills);
    const targetMetaRegistration = registeredMetaProvider(targetMeta);
    const targetHub = new ConsumerHub(
      [targetMetaRegistration, registeredSkillsProvider(targetSkills)],
      TEST_CONFIG,
    );

    try {
      await targetHub.connect();
      const targetStop = targetMetaRegistration.attachRuntime?.(targetHub, TEST_CONFIG);
      const targetMetaConsumer = new SlopConsumer(new InProcessTransport(targetMeta.server));
      const targetSkillsConsumer = new SlopConsumer(new InProcessTransport(targetSkills.server));
      await connect(targetMetaConsumer);
      await connect(targetSkillsConsumer);

      expect(
        (
          await targetSkillsConsumer.invoke("/session", "skill_manage", {
            operation: "create",
            scope: "session",
            name: "bundle-review",
            content: "# Bundle Review\n\nExisting target content.\n",
          })
        ).status,
      ).toBe("ok");

      const imported = await targetMetaConsumer.invoke("/session", "import_bundle", {
        scope: "session",
        skip_existing_skills: false,
        bundle: {
          kind: "sloppy.meta-runtime.bundle",
          schema_version: 1,
          exported_at: "2026-05-06T00:00:00.000Z",
          scope: "merged",
          state: {
            profiles: [{ id: "reviewer", name: "Reviewer", instructions: "Review bundles." }],
            skillVersions: [
              {
                id: "bundle-review@1.0.0",
                skillId: "bundle-review",
                version: "1.0.0",
                scope: "session",
                active: true,
                activationStatus: "active",
              },
            ],
          },
          skills: [
            {
              name: "bundle-review",
              content: "# Bundle Review\n\nExisting target content.\n",
            },
          ],
          notes: { secrets: "excluded" },
        },
      });
      expect(imported.status).toBe("error");
      expect(imported.error?.message).toContain("does not overwrite existing skills");

      const importedProfiles = await targetMetaConsumer.query("/profiles", 2);
      expect((importedProfiles.children ?? []).map((child) => child.id)).not.toContain("reviewer");
      targetStop?.stop();
    } finally {
      targetHub.shutdown();
    }
  });

  test("import_bundle rejects same-name skill collisions with different content", async () => {
    const root = await mkdtemp(join(tmpdir(), "sloppy-meta-"));
    tempPaths.push(root);
    const targetMeta = new MetaRuntimeProvider({
      globalRoot: join(root, "target-global"),
      workspaceRoot: join(root, "target-workspace"),
    });
    const targetSkills = new SkillsProvider({ skillsDir: join(root, "target-skills") });
    targetMeta.bindRuntimeService(SKILLS_SERVICE, targetSkills);
    const targetMetaRegistration = registeredMetaProvider(targetMeta);
    const targetHub = new ConsumerHub(
      [targetMetaRegistration, registeredSkillsProvider(targetSkills)],
      TEST_CONFIG,
    );

    try {
      await targetHub.connect();
      const targetStop = targetMetaRegistration.attachRuntime?.(targetHub, TEST_CONFIG);
      const targetMetaConsumer = new SlopConsumer(new InProcessTransport(targetMeta.server));
      const targetSkillsConsumer = new SlopConsumer(new InProcessTransport(targetSkills.server));
      await connect(targetMetaConsumer);
      await connect(targetSkillsConsumer);

      expect(
        (
          await targetSkillsConsumer.invoke("/session", "skill_manage", {
            operation: "create",
            scope: "session",
            name: "bundle-review",
            content: "# Bundle Review\n\nExisting target content.\n",
          })
        ).status,
      ).toBe("ok");

      const bundle = {
        kind: "sloppy.meta-runtime.bundle",
        schema_version: 1,
        exported_at: "2026-05-06T00:00:00.000Z",
        scope: "merged",
        state: {
          profiles: [{ id: "reviewer", name: "Reviewer", instructions: "Review bundles." }],
          skillVersions: [
            {
              id: "bundle-review@1.0.0",
              skillId: "bundle-review",
              version: "1.0.0",
              scope: "session",
              active: true,
              activationStatus: "active",
            },
          ],
        },
        skills: [
          {
            name: "bundle-review",
            content: "# Bundle Review\n\nBundled source content.\n",
          },
        ],
        notes: { secrets: "excluded" },
      };

      const imported = await targetMetaConsumer.invoke("/session", "import_bundle", {
        bundle,
        scope: "session",
      });
      expect(imported.status).toBe("error");
      expect(imported.error?.message).toContain("Existing skill content differs");
      expect(imported.error?.message).toContain("topology was not imported");

      const importedProfiles = await targetMetaConsumer.query("/profiles", 2);
      expect((importedProfiles.children ?? []).map((child) => child.id)).not.toContain("reviewer");
      const importedSkillVersions = await targetMetaConsumer.query("/skill-versions", 2);
      expect((importedSkillVersions.children ?? []).map((child) => child.id)).not.toContain(
        "bundle-review@1.0.0",
      );
      targetStop?.stop();
    } finally {
      targetHub.shutdown();
    }
  });

  test("registry exposes meta-runtime only when explicitly enabled", () => {
    const config = createTestConfig({
      agent: { maxIterations: 1 },
      plugins: {
        apps: { enabled: false },
        terminal: { enabled: false },
        filesystem: { enabled: false },
        memory: { enabled: false },
        skills: { enabled: false },
        "meta-runtime": { enabled: true },
      },
    });

    const providers = createFirstPartyProviders(config);
    try {
      expect(providers.map((provider) => provider.id)).toEqual(["meta-runtime"]);
    } finally {
      for (const provider of providers) {
        provider.stop?.();
      }
    }
  });
});
