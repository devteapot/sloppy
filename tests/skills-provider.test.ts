import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SlopConsumer } from "@slop-ai/consumer/browser";

import { InProcessTransport } from "../src/providers/builtin/in-process";
import { SkillsProvider } from "../src/providers/builtin/skills";

const tempPaths: string[] = [];

afterEach(async () => {
  while (tempPaths.length > 0) {
    const path = tempPaths.pop();
    if (!path) {
      continue;
    }
    await rm(path, { recursive: true, force: true });
  }
});

async function createSkill(
  root: string,
  relativeDir: string,
  frontmatter: string,
  body = "# Test Skill\n\nUse this skill in tests.\n",
): Promise<void> {
  const skillDir = join(root, relativeDir);
  await mkdir(skillDir, { recursive: true });
  await writeFile(join(skillDir, "SKILL.md"), `${frontmatter}\n\n${body}`, "utf8");
}

function createHarness(skillsDir: string) {
  const provider = new SkillsProvider({ skillsDir });
  const consumer = new SlopConsumer(new InProcessTransport(provider.server));

  return { provider, consumer };
}

function createLayeredHarness(skillsDir: string, workspaceSkillsDir: string) {
  const provider = new SkillsProvider({ skillsDir, workspaceSkillsDir });
  const consumer = new SlopConsumer(new InProcessTransport(provider.server));

  return { provider, consumer };
}

function createCustomHarness(options: ConstructorParameters<typeof SkillsProvider>[0]) {
  const provider = new SkillsProvider(options);
  const consumer = new SlopConsumer(new InProcessTransport(provider.server));

  return { provider, consumer };
}

async function connectAndRefresh(consumer: SlopConsumer): Promise<void> {
  await consumer.connect();
  await consumer.subscribe("/", 3);
  const refreshResult = await consumer.invoke("/session", "refresh_skills", {});
  expect(refreshResult.status).toBe("ok");
}

describe("SkillsProvider", () => {
  test("discovers skills from nested SKILL.md files", async () => {
    const root = await mkdtemp(join(tmpdir(), "sloppy-skills-"));
    tempPaths.push(root);
    await createSkill(
      root,
      "tools/demo-skill",
      `---
name: demo-skill
description: Demo skill
version: 1.0.0
tags: [demo]
---`,
    );

    const { provider, consumer } = createHarness(root);

    try {
      await connectAndRefresh(consumer);

      const skills = await consumer.query("/skills", 2);
      expect(skills.type).toBe("collection");
      expect(skills.properties?.count).toBe(1);
      expect(skills.children?.[0]?.id).toBe("skill-tools-demo-skill");
      expect(skills.children?.[0]?.properties?.name).toBe("demo-skill");
    } finally {
      provider.stop();
    }
  });

  test("lists skills sorted by display name", async () => {
    const root = await mkdtemp(join(tmpdir(), "sloppy-skills-"));
    tempPaths.push(root);
    await createSkill(root, "zeta", "---\nname: zeta\n---");
    await createSkill(root, "alpha", "---\nname: alpha\n---");

    const { provider, consumer } = createHarness(root);

    try {
      await connectAndRefresh(consumer);

      const skills = await consumer.query("/skills", 2);
      expect(skills.children?.map((child) => child.properties?.name)).toEqual(["alpha", "zeta"]);
    } finally {
      provider.stop();
    }
  });

  test("uses scope precedence when skill names collide", async () => {
    const root = await mkdtemp(join(tmpdir(), "sloppy-skills-"));
    tempPaths.push(root);
    const imported = join(root, "imported");
    const workspace = join(root, "workspace");
    await createSkill(imported, "shared", "---\nname: shared-skill\n---", "# Imported Skill\n");
    await createSkill(workspace, "shared", "---\nname: shared-skill\n---", "# Workspace Skill\n");

    const { provider, consumer } = createLayeredHarness(imported, workspace);

    try {
      await connectAndRefresh(consumer);

      const skills = await consumer.query("/skills", 2);
      const shared = skills.children?.filter((child) => child.properties?.name === "shared-skill");
      expect(shared?.map((child) => child.properties?.scope)).toEqual(["workspace", "imported"]);

      const viewed = await consumer.invoke("/session", "view_skill", { name: "shared-skill" });
      expect(viewed.status).toBe("ok");
      expect((viewed.data as { content: string }).content).toContain("# Workspace Skill");
    } finally {
      provider.stop();
    }
  });

  test("discovers builtin and external skill roots", async () => {
    const root = await mkdtemp(join(tmpdir(), "sloppy-skills-"));
    tempPaths.push(root);
    const builtin = join(root, "builtin");
    const external = join(root, "external");
    await createSkill(builtin, "runtime/architect", "---\nname: runtime-architect\n---");
    await createSkill(external, "team/workflow", "---\nname: team-workflow\n---");

    const { provider, consumer } = createCustomHarness({
      skillsDir: join(root, "empty"),
      builtinSkillsDir: builtin,
      externalDirs: [external],
    });

    try {
      await connectAndRefresh(consumer);

      const skills = await consumer.query("/skills", 2);
      expect(skills.children?.map((child) => child.properties?.name)).toEqual([
        "runtime-architect",
        "team-workflow",
      ]);
      expect(skills.children?.map((child) => child.properties?.scope)).toEqual([
        "builtin",
        "imported",
      ]);
    } finally {
      provider.stop();
    }
  });

  test("exposes session counts, installed names, and refresh affordance", async () => {
    const root = await mkdtemp(join(tmpdir(), "sloppy-skills-"));
    tempPaths.push(root);
    await createSkill(root, "alpha", "---\nname: alpha\ntags: [one, shared]\n---");
    await createSkill(root, "beta", "---\nname: beta\ntags: [two, shared]\n---");

    const { provider, consumer } = createHarness(root);

    try {
      await connectAndRefresh(consumer);

      const session = await consumer.query("/session", 2);
      expect(session.type).toBe("context");
      expect(session.properties?.skills_count).toBe(2);
      expect(session.properties?.tags_count).toBe(3);
      expect(session.properties?.installed).toEqual(["alpha", "beta"]);
      expect(session.affordances?.map((affordance) => affordance.action)).toEqual([
        "refresh_skills",
        "view_skill",
        "skill_view",
        "propose_skill",
        "skill_manage",
      ]);
    } finally {
      provider.stop();
    }
  });

  test("exposes skill metadata properties", async () => {
    const root = await mkdtemp(join(tmpdir(), "sloppy-skills-"));
    tempPaths.push(root);
    await createSkill(
      root,
      "metadata",
      `---
name: metadata-skill
description: Reads metadata for tests
version: 2.3.4
tags: [metadata, test]
related_skills: [helper-skill]
---`,
    );

    const { provider, consumer } = createHarness(root);

    try {
      await connectAndRefresh(consumer);

      const skills = await consumer.query("/skills", 2);
      const skill = skills.children?.[0];
      expect(skill?.properties?.name).toBe("metadata-skill");
      expect(skill?.properties?.description).toBe("Reads metadata for tests");
      expect(skill?.properties?.version).toBe("2.3.4");
      expect(skill?.properties?.tags).toEqual(["metadata", "test"]);
      expect(skill?.properties?.related_skills).toEqual(["helper-skill"]);
      expect(typeof skill?.properties?.file_path).toBe("string");
    } finally {
      provider.stop();
    }
  });

  test("uses fallback metadata when frontmatter fields are absent", async () => {
    const root = await mkdtemp(join(tmpdir(), "sloppy-skills-"));
    tempPaths.push(root);
    await createSkill(root, "plain-skill", "# No frontmatter\n", "");

    const { provider, consumer } = createHarness(root);

    try {
      await connectAndRefresh(consumer);

      const skills = await consumer.query("/skills", 2);
      const skill = skills.children?.[0];
      expect(skill?.properties?.name).toBe("plain-skill");
      expect(skill?.properties?.description).toBe("");
      expect(skill?.properties?.version).toBe("0.0.0");
      expect(skill?.properties?.tags).toEqual([]);
    } finally {
      provider.stop();
    }
  });

  test("view_skill action reads skill content from session", async () => {
    const root = await mkdtemp(join(tmpdir(), "sloppy-skills-"));
    tempPaths.push(root);
    await createSkill(
      root,
      "reader",
      "---\nname: reader\n---",
      "# Reader Skill\n\nDetailed instructions live here.\n",
    );

    const { provider, consumer } = createHarness(root);

    try {
      await connectAndRefresh(consumer);

      const viewResult = await consumer.invoke("/session", "view_skill", { name: "reader" });
      expect(viewResult.status).toBe("ok");
      expect((viewResult.data as { name: string; content: string }).name).toBe("reader");
      expect((viewResult.data as { content: string }).content).toContain("# Reader Skill");
    } finally {
      provider.stop();
    }
  });

  test("skill_view waits for startup discovery before resolving a skill", async () => {
    const root = await mkdtemp(join(tmpdir(), "sloppy-skills-"));
    tempPaths.push(root);
    await createSkill(
      root,
      "startup-reader",
      "---\nname: startup-reader\n---",
      "# Startup Reader\n\nLoaded during provider startup.\n",
    );

    const { provider, consumer } = createHarness(root);

    try {
      await consumer.connect();
      await consumer.subscribe("/", 3);
      const viewResult = await consumer.invoke("/session", "skill_view", {
        name: "startup-reader",
      });
      expect(viewResult.status).toBe("ok");
      expect((viewResult.data as { content: string }).content).toContain("# Startup Reader");
    } finally {
      provider.stop();
    }
  });

  test("skill items expose a view_skill affordance", async () => {
    const root = await mkdtemp(join(tmpdir(), "sloppy-skills-"));
    tempPaths.push(root);
    await createSkill(root, "item-reader", "---\nname: item-reader\n---", "# Item Reader\n");

    const { provider, consumer } = createHarness(root);

    try {
      await connectAndRefresh(consumer);

      const skills = await consumer.query("/skills", 2);
      const skillId = skills.children?.[0]?.id;
      expect(typeof skillId).toBe("string");

      const skill = skills.children?.[0];
      expect(skill?.affordances?.map((affordance) => affordance.action)).toEqual([
        "view_skill",
        "skill_view",
      ]);
      expect(skill?.affordances?.[0]?.idempotent).toBe(true);
    } finally {
      provider.stop();
    }
  });

  test("marks dangerous skills in list metadata", async () => {
    const root = await mkdtemp(join(tmpdir(), "sloppy-skills-"));
    tempPaths.push(root);
    await createSkill(root, "danger", "---\nname: danger\ndangerous: true\n---");

    const { provider, consumer } = createHarness(root);

    try {
      await connectAndRefresh(consumer);

      const skills = await consumer.query("/skills", 2);
      const skill = skills.children?.[0];
      expect(skill?.properties?.name).toBe("[DANGEROUS] danger");
      expect(skill?.meta?.salience).toBe(0.9);
      expect(skill?.meta?.urgency).toBe("high");
    } finally {
      provider.stop();
    }
  });

  test("reads nested Sloppy metadata and supporting files on demand", async () => {
    const root = await mkdtemp(join(tmpdir(), "sloppy-skills-"));
    tempPaths.push(root);
    await createSkill(
      root,
      "research/demo",
      `---
name: research-demo
description: Demo with support files
version: 1.2.0
platforms: [macos, linux]
metadata:
  sloppy:
    tags: [research, demo]
    category: research
---`,
      `# Research Demo\n\nUse ${"$"}{SLOPPY_SKILL_DIR}/scripts/run.sh.\n`,
    );
    await mkdir(join(root, "research/demo/references"), { recursive: true });
    await writeFile(join(root, "research/demo/references/notes.md"), "Reference details", "utf8");

    const { provider, consumer } = createHarness(root);

    try {
      await connectAndRefresh(consumer);

      const skills = await consumer.query("/skills", 2);
      const skill = skills.children?.[0];
      expect(skill?.properties?.name).toBe("research-demo");
      expect(skill?.properties?.tags).toEqual(["research", "demo"]);
      expect(skill?.properties?.category).toBe("research");
      expect(skill?.properties?.platforms).toEqual(["macos", "linux"]);
      expect(skill?.properties?.supporting_files).toEqual(["references/notes.md"]);

      const main = await consumer.invoke("/session", "skill_view", { name: "research-demo" });
      expect(main.status).toBe("ok");
      expect((main.data as { content: string }).content).toContain(`${root}/research/demo`);

      const reference = await consumer.invoke("/session", "skill_view", {
        name: "research-demo",
        file_path: "references/notes.md",
      });
      expect(reference.status).toBe("ok");
      expect((reference.data as { content: string }).content).toBe("Reference details");

      const escaped = await consumer.invoke("/session", "skill_view", {
        name: "research-demo",
        file_path: "../SKILL.md",
      });
      expect(escaped.status).toBe("error");
      expect(escaped.error?.message).toContain("escapes the skill directory");
    } finally {
      provider.stop();
    }
  });

  test("returns an empty collection when the skills directory is missing", async () => {
    const root = join(tmpdir(), `sloppy-missing-skills-${crypto.randomUUID()}`);
    const { provider, consumer } = createHarness(root);

    try {
      await connectAndRefresh(consumer);

      const session = await consumer.query("/session", 2);
      expect(session.properties?.skills_count).toBe(0);

      const skills = await consumer.query("/skills", 2);
      expect(skills.properties?.count).toBe(0);
      expect(skills.children ?? []).toEqual([]);
    } finally {
      provider.stop();
    }
  });

  test("skill_manage creates, patches, and manages supporting files with approval for workspace scope", async () => {
    const root = await mkdtemp(join(tmpdir(), "sloppy-skills-"));
    tempPaths.push(root);
    const imported = join(root, "imported");
    const workspace = join(root, "workspace");
    const { provider, consumer } = createLayeredHarness(imported, workspace);

    try {
      await connectAndRefresh(consumer);

      const createBlocked = await consumer.invoke("/session", "skill_manage", {
        operation: "create",
        scope: "workspace",
        category: "runtime",
        name: "managed-skill",
        content: "---\nname: managed-skill\n---\n# Managed Skill\n\nOld step\n",
      });
      expect(createBlocked.status).toBe("error");
      expect(createBlocked.error?.code).toBe("approval_required");

      let approvals = await consumer.query("/approvals", 2);
      let approvalId = approvals.children?.[0]?.id;
      expect(typeof approvalId).toBe("string");
      const created = await consumer.invoke(`/approvals/${approvalId}`, "approve", {});
      expect(created.status).toBe("ok");
      expect(await readFile(join(workspace, "runtime/managed-skill/SKILL.md"), "utf8")).toContain(
        "Old step",
      );

      const patchBlocked = await consumer.invoke("/session", "skill_manage", {
        operation: "patch",
        name: "managed-skill",
        old_string: "Old step",
        new_string: "New step",
      });
      expect(patchBlocked.status).toBe("error");
      approvals = await consumer.query("/approvals", 2);
      approvalId = approvals.children?.find((child) => child.properties?.status === "pending")?.id;
      expect(typeof approvalId).toBe("string");
      const patched = await consumer.invoke(`/approvals/${approvalId}`, "approve", {});
      expect(patched.status).toBe("ok");
      expect(await readFile(join(workspace, "runtime/managed-skill/SKILL.md"), "utf8")).toContain(
        "New step",
      );

      const writeBlocked = await consumer.invoke("/session", "skill_manage", {
        operation: "write_file",
        name: "managed-skill",
        file_path: "references/example.md",
        file_content: "Example reference",
      });
      expect(writeBlocked.status).toBe("error");
      approvals = await consumer.query("/approvals", 2);
      approvalId = approvals.children?.find((child) => child.properties?.status === "pending")?.id;
      expect(typeof approvalId).toBe("string");
      const written = await consumer.invoke(`/approvals/${approvalId}`, "approve", {});
      expect(written.status).toBe("ok");

      await consumer.invoke("/session", "refresh_skills", {});
      const reference = await consumer.invoke("/session", "skill_view", {
        name: "managed-skill",
        file_path: "references/example.md",
      });
      expect(reference.status).toBe("ok");
      expect((reference.data as { content: string }).content).toBe("Example reference");
    } finally {
      provider.stop();
    }
  });

  test("skill_manage creates session skills without approval", async () => {
    const root = await mkdtemp(join(tmpdir(), "sloppy-skills-"));
    tempPaths.push(root);
    const { provider, consumer } = createHarness(root);

    try {
      await connectAndRefresh(consumer);

      const created = await consumer.invoke("/session", "skill_manage", {
        operation: "create",
        scope: "session",
        name: "managed-session",
        content: "---\nname: managed-session\n---\n# Managed Session\n",
      });
      expect(created.status).toBe("ok");

      const viewed = await consumer.invoke("/session", "skill_view", {
        name: "managed-session",
      });
      expect(viewed.status).toBe("ok");
      expect((viewed.data as { content: string }).content).toContain("# Managed Session");
    } finally {
      provider.stop();
    }
  });

  test("activates session skill proposals without approval", async () => {
    const root = await mkdtemp(join(tmpdir(), "sloppy-skills-"));
    tempPaths.push(root);
    const { provider, consumer } = createHarness(root);

    try {
      await connectAndRefresh(consumer);
      const proposed = await consumer.invoke("/session", "propose_skill", {
        scope: "session",
        name: "session-skill",
        version: "1.0.0",
        body: "---\nname: session-skill\nversion: 1.0.0\n---\n# Session Skill\n",
      });
      expect(proposed.status).toBe("ok");
      const proposalId = (proposed.data as { id: string }).id;
      const activated = await consumer.invoke(
        `/proposals/${proposalId}`,
        "activate_skill_proposal",
        {},
      );
      expect(activated.status).toBe("ok");

      const skills = await consumer.query("/skills", 2);
      expect(skills.children?.map((child) => child.properties?.name)).toEqual(["session-skill"]);
      const viewed = await consumer.invoke("/session", "view_skill", { name: "session-skill" });
      expect(viewed.status).toBe("ok");
      expect((viewed.data as { content: string }).content).toContain("# Session Skill");
    } finally {
      provider.stop();
    }
  });

  test("approval-gates workspace skill proposals before writing SKILL.md", async () => {
    const root = await mkdtemp(join(tmpdir(), "sloppy-skills-"));
    tempPaths.push(root);
    const imported = join(root, "imported");
    const workspace = join(root, "workspace");
    const { provider, consumer } = createLayeredHarness(imported, workspace);

    try {
      await connectAndRefresh(consumer);
      const body = "---\nname: workspace-skill\nversion: 1.0.0\n---\n# Workspace Skill\n";
      const proposed = await consumer.invoke("/session", "propose_skill", {
        scope: "workspace",
        name: "workspace-skill",
        version: "1.0.0",
        body,
      });
      expect(proposed.status).toBe("ok");
      const proposalId = (proposed.data as { id: string }).id;

      const blocked = await consumer.invoke(
        `/proposals/${proposalId}`,
        "activate_skill_proposal",
        {},
      );
      expect(blocked.status).toBe("error");
      expect(blocked.error?.code).toBe("approval_required");

      const approvals = await consumer.query("/approvals", 2);
      const approvalId = approvals.children?.[0]?.id;
      expect(typeof approvalId).toBe("string");
      const approved = await consumer.invoke(`/approvals/${approvalId}`, "approve", {});
      expect(approved.status).toBe("ok");

      expect(await readFile(join(workspace, "workspace-skill", "SKILL.md"), "utf8")).toBe(body);
      await consumer.invoke("/session", "refresh_skills", {});
      const skills = await consumer.query("/skills", 2);
      expect(skills.children?.[0]?.properties?.scope).toBe("workspace");
      expect(skills.children?.[0]?.properties?.name).toBe("workspace-skill");
    } finally {
      provider.stop();
    }
  });

  test("refuses to overwrite an existing persistent skill", async () => {
    const root = await mkdtemp(join(tmpdir(), "sloppy-skills-"));
    tempPaths.push(root);
    const imported = join(root, "imported");
    const workspace = join(root, "workspace");
    await createSkill(
      workspace,
      "existing-skill",
      "---\nname: existing-skill\n---",
      "# Original Skill\n",
    );
    const { provider, consumer } = createLayeredHarness(imported, workspace);

    try {
      await connectAndRefresh(consumer);
      const proposed = await consumer.invoke("/session", "propose_skill", {
        scope: "workspace",
        name: "existing-skill",
        version: "2.0.0",
        body: "---\nname: existing-skill\nversion: 2.0.0\n---\n# Replacement Skill\n",
      });
      expect(proposed.status).toBe("ok");
      const proposalId = (proposed.data as { id: string }).id;

      const blocked = await consumer.invoke(
        `/proposals/${proposalId}`,
        "activate_skill_proposal",
        {},
      );
      expect(blocked.status).toBe("error");
      expect(blocked.error?.code).toBe("approval_required");
      const approvals = await consumer.query("/approvals", 2);
      const approvalId = approvals.children?.[0]?.id;
      expect(typeof approvalId).toBe("string");
      const approved = await consumer.invoke(`/approvals/${approvalId}`, "approve", {});
      expect(approved.status).toBe("error");
      expect(approved.error?.message).toContain("Refusing to overwrite existing workspace skill");
      expect(await readFile(join(workspace, "existing-skill", "SKILL.md"), "utf8")).toContain(
        "# Original Skill",
      );
    } finally {
      provider.stop();
    }
  });
});
