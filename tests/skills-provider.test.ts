import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
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
      expect(skill?.affordances?.map((affordance) => affordance.action)).toEqual(["view_skill"]);
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
});
