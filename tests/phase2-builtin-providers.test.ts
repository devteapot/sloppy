import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SlopConsumer } from "@slop-ai/consumer/browser";

import { BrowserProvider } from "../src/providers/builtin/browser";
import { CronProvider } from "../src/providers/builtin/cron";
import { DelegationProvider } from "../src/providers/builtin/delegation";
import { InProcessTransport } from "../src/providers/builtin/in-process";
import { MemoryProvider } from "../src/providers/builtin/memory";
import { MessagingProvider } from "../src/providers/builtin/messaging";
import { SkillsProvider } from "../src/providers/builtin/skills";
import { VisionProvider } from "../src/providers/builtin/vision";
import { WebProvider } from "../src/providers/builtin/web";

const tempPaths: string[] = [];
const originalFetch = globalThis.fetch;

afterEach(async () => {
  globalThis.fetch = originalFetch;

  while (tempPaths.length > 0) {
    const path = tempPaths.pop();
    if (!path) {
      continue;
    }
    await rm(path, { recursive: true, force: true });
  }
});

async function waitFor<T>(check: () => Promise<T | null>, timeoutMs = 5000, intervalMs = 50): Promise<T> {
  const started = Date.now();

  while (Date.now() - started < timeoutMs) {
    const value = await check();
    if (value !== null) {
      return value;
    }
    await Bun.sleep(intervalMs);
  }

  throw new Error(`Timed out after ${timeoutMs}ms waiting for condition.`);
}

describe("Phase 2 builtin providers", () => {
  test("MemoryProvider stores, searches, and approval-gates clearing all memories", async () => {
    const provider = new MemoryProvider({
      maxMemories: 20,
      defaultWeight: 0.5,
      compactThreshold: 0.2,
    });
    const consumer = new SlopConsumer(new InProcessTransport(provider.server));

    try {
      await consumer.connect();
      await consumer.subscribe("/", 4);

      const addResult = await consumer.invoke("/session", "add_memory", {
        content: "Lucerne is the current city.",
        tags: ["profile", "location"],
        weight: 0.1,
      });
      expect(addResult.status).toBe("ok");

      const searchResult = await consumer.invoke("/session", "search", {
        query: "Lucerne",
        tags: ["profile"],
        limit: 5,
      });
      expect(searchResult.status).toBe("ok");
      const matches = searchResult.data as Array<{ content: string }>;
      expect(matches[0]?.content).toContain("Lucerne");

      const tags = await consumer.query("/tags", 2);
      expect(tags.children?.some((child) => child.id === "profile")).toBe(true);

      const memories = await consumer.query("/memories", 2);
      expect(memories.children?.length).toBe(1);

      const clearResult = await consumer.invoke("/session", "clear_all", { confirmed: false });
      expect(clearResult.status).toBe("error");
      expect(clearResult.error?.code).toBe("approval_required");

      const approvals = await consumer.query("/approvals", 2);
      const approvalId = approvals.children?.[0]?.id;
      expect(typeof approvalId).toBe("string");
      await consumer.invoke(`/approvals/${approvalId}`, "approve", {});

      const updatedSession = await consumer.query("/session", 2);
      expect(updatedSession.properties?.total_count).toBe(0);
    } finally {
      provider.stop();
    }
  });

  test("SkillsProvider discovers skills and returns full SKILL.md content", async () => {
    const root = await mkdtemp(join(tmpdir(), "sloppy-skills-"));
    tempPaths.push(root);
    const skillDir = join(root, "demo-skill");
    await mkdir(skillDir, { recursive: true });
    await writeFile(
      join(skillDir, "SKILL.md"),
      `---
name: demo-skill
description: Demo skill for tests
version: 1.2.3
tags: [demo, test]
related_skills: [other-skill]
---

# Demo Skill

Use this for testing.
`,
      "utf8",
    );

    const provider = new SkillsProvider({ skillsDir: root });
    const consumer = new SlopConsumer(new InProcessTransport(provider.server));

    try {
      await consumer.connect();
      await consumer.subscribe("/", 3);

      const refreshResult = await consumer.invoke("/session", "refresh_skills", {});
      expect(refreshResult.status).toBe("ok");
      expect((refreshResult.data as { skills_count: number }).skills_count).toBe(1);

      const skills = await consumer.query("/skills", 2);
      expect(skills.children?.length).toBe(1);
      const skillId = skills.children?.[0]?.id;
      expect(skills.children?.[0]?.properties?.name).toBe("demo-skill");

      const viewResult = await consumer.invoke("/session", "view_skill", {
        name: "demo-skill",
      });
      expect(viewResult.status).toBe("ok");
      expect((viewResult.data as { content: string }).content).toContain("# Demo Skill");
    } finally {
      provider.stop();
    }
  });

  test("BrowserProvider tracks tabs, history, and screenshots", async () => {
    const provider = new BrowserProvider({ viewportWidth: 1440, viewportHeight: 900 });
    const consumer = new SlopConsumer(new InProcessTransport(provider.server));

    try {
      await consumer.connect();
      await consumer.subscribe("/", 3);

      await consumer.invoke("/session", "navigate", { url: "https://example.com", new_tab: false });
      await consumer.invoke("/session", "navigate", { url: "https://nousresearch.com", new_tab: true });

      const tabs = await consumer.query("/tabs", 2);
      expect(tabs.children?.length).toBe(2);
      const firstTabId = tabs.children?.find((child) => child.properties?.index === 0)?.id;
      const secondTabId = tabs.children?.find((child) => child.properties?.index === 1)?.id;
      expect(typeof firstTabId).toBe("string");
      expect(typeof secondTabId).toBe("string");

      const switchResult = await consumer.invoke(`/tabs/${firstTabId}`, "switch_tab", {});
      expect(switchResult.status).toBe("ok");

      const screenshotResult = await consumer.invoke(`/tabs/${secondTabId}`, "take_screenshot", {});
      expect(screenshotResult.status).toBe("ok");
      expect((screenshotResult.data as { data: string }).data).toContain("simulated-screenshot");

      const goBackResult = await consumer.invoke("/history", "go_back", {});
      expect(goBackResult.status).toBe("ok");
      expect((goBackResult.data as { url: string }).url).toBe("https://example.com");
    } finally {
      provider.stop();
    }
  });

  test("CronProvider adds jobs, runs them, and exposes output", async () => {
    const provider = new CronProvider({ maxJobs: 5 });
    const consumer = new SlopConsumer(new InProcessTransport(provider.server));

    try {
      await consumer.connect();
      await consumer.subscribe("/", 3);

      const addResult = await consumer.invoke("/session", "add_job", {
        name: "echo-test",
        schedule: "0 * * * *",
        command: "printf cron-ok",
      });
      expect(addResult.status).toBe("ok");

      const jobs = await consumer.query("/jobs", 2);
      expect(jobs.children?.length).toBe(1);
      const jobId = jobs.children?.[0]?.id;
      expect(typeof jobId).toBe("string");

      const runNowResult = await consumer.invoke(`/jobs/${jobId}`, "run_now", {});
      expect(runNowResult.status).toBe("ok");

      const completedJob = await waitFor(async () => {
        const current = await consumer.query(`/jobs/${jobId}`, 2);
        return current.properties?.status === "completed" ? current : null;
      }, 4000);

      expect(completedJob.properties?.last_output_preview).toContain("cron-ok");
    } finally {
      provider.stop();
    }
  });

  test("MessagingProvider creates channels, sends messages, and returns history", async () => {
    const provider = new MessagingProvider({ maxMessages: 20 });
    const consumer = new SlopConsumer(new InProcessTransport(provider.server));

    try {
      await consumer.connect();
      await consumer.subscribe("/", 3);

      const addChannelResult = await consumer.invoke("/session", "add_channel", {
        name: "General",
        transport_type: "telegram",
      });
      expect(addChannelResult.status).toBe("ok");

      const channels = await consumer.query("/channels", 2);
      expect(channels.children?.length).toBe(1);
      const channelId = channels.children?.[0]?.id;
      expect(typeof channelId).toBe("string");

      const sendResult = await consumer.invoke(`/channels/${channelId}`, "send", {
        message: "hello world",
      });
      expect(sendResult.status).toBe("ok");

      const historyResult = await consumer.invoke(`/channels/${channelId}`, "view_history", {
        limit: 5,
      });
      expect(historyResult.status).toBe("ok");
      const history = historyResult.data as Array<{ content: string; direction: string }>;
      expect(history.some((message) => message.content === "hello world" && message.direction === "outbound")).toBe(true);
    } finally {
      provider.stop();
    }
  });

  test("DelegationProvider spawns agents and allows cancellation", async () => {
    const provider = new DelegationProvider({ maxAgents: 2 });
    const consumer = new SlopConsumer(new InProcessTransport(provider.server));

    try {
      await consumer.connect();
      await consumer.subscribe("/", 3);

      const spawnResult = await consumer.invoke("/session", "spawn_agent", {
        name: "research-agent",
        goal: "Investigate a protocol detail",
        model: "gpt-5.4",
      });
      expect(spawnResult.status).toBe("ok");

      const agents = await consumer.query("/agents", 2);
      expect(agents.children?.length).toBe(1);
      const agentId = agents.children?.[0]?.id;
      expect(typeof agentId).toBe("string");

      const monitored = await waitFor(async () => {
        const current = await consumer.invoke(`/agents/${agentId}`, "monitor", {});
        const data = current.data as { status: string };
        return data.status === "running" || data.status === "pending" ? data : null;
      }, 2000);
      expect(["pending", "running"]).toContain(monitored.status);

      const cancelResult = await consumer.invoke(`/agents/${agentId}`, "cancel", {});
      expect(cancelResult.status).toBe("ok");

      const cancelledAgent = await consumer.query(`/agents/${agentId}`, 2);
      expect(cancelledAgent.properties?.status).toBe("cancelled");
    } finally {
      provider.stop();
    }
  });

  test("VisionProvider generates images and analyses, then exposes ready results", async () => {
    const provider = new VisionProvider({ maxImages: 10, defaultWidth: 640, defaultHeight: 480 });
    const consumer = new SlopConsumer(new InProcessTransport(provider.server));

    try {
      await consumer.connect();
      await consumer.subscribe("/", 3);

      const generateResult = await consumer.invoke("/session", "generate_image", {
        prompt: "A crab reading a protocol spec",
      });
      expect(generateResult.status).toBe("ok");

      const analyzeResult = await consumer.invoke("/session", "analyze_image", {
        source: "/tmp/fake-image.png",
      });
      expect(analyzeResult.status).toBe("ok");

      const readyImage = await waitFor(async () => {
        const images = await consumer.query("/images", 2);
        const image = images.children?.[0];
        return image?.properties?.status === "ready" ? image : null;
      }, 4000);
      const imageId = readyImage.id;

      const downloadResult = await consumer.invoke(`/images/${imageId}`, "download", {});
      expect(downloadResult.status).toBe("ok");
      expect((downloadResult.data as { url: string }).url).toContain("placeholder.invalid/generated/");

      const readyAnalysis = await waitFor(async () => {
        const analyses = await consumer.query("/analyses", 2);
        const analysis = analyses.children?.[0];
        return analysis?.properties?.status === "ready" ? analysis : null;
      }, 4000);
      const analysisId = readyAnalysis.id;

      const viewResult = await consumer.invoke(`/analyses/${analysisId}`, "view_result", {});
      expect(viewResult.status).toBe("ok");
      expect((viewResult.data as { result: string }).result).toContain("Simulated analysis");
    } finally {
      provider.stop();
    }
  });

  test("WebProvider searches and reads URLs using stubbed fetch and records history", async () => {
    globalThis.fetch = (async (input: string | URL) => {
      const url = String(input);
      if (url.includes("api.search.brave.com")) {
        return new Response(
          JSON.stringify({
            web: {
              results: [
                {
                  url: "https://example.com/result",
                  title: "Example Result",
                  description: "A stubbed web search result.",
                },
              ],
            },
          }),
          {
            status: 200,
            headers: { "Content-Type": "application/json" },
          },
        );
      }

      return new Response("Hello from stubbed fetch.", {
        status: 200,
        headers: { "Content-Type": "text/plain" },
      });
    }) as typeof fetch;

    const provider = new WebProvider({ historyLimit: 10 });
    const consumer = new SlopConsumer(new InProcessTransport(provider.server));

    try {
      await consumer.connect();
      await consumer.subscribe("/", 3);

      const searchResult = await consumer.invoke("/session", "search", {
        query: "sloppy protocol",
        limit: 3,
      });
      expect(searchResult.status).toBe("ok");
      expect((searchResult.data as { results: Array<{ title: string }> }).results[0]?.title).toBe(
        "Example Result",
      );

      const readResult = await consumer.invoke("/session", "read", {
        url: "https://example.com/readme",
        maxBytes: 100,
      });
      expect(readResult.status).toBe("ok");
      expect((readResult.data as { content: string }).content).toContain("Hello from stubbed fetch");

      const history = await consumer.query("/history", 2);
      expect(history.children?.length).toBe(2);
      const firstHistoryId = history.children?.[0]?.id;
      expect(typeof firstHistoryId).toBe("string");

      const showResult = await consumer.invoke(`/history/${firstHistoryId}`, "show_result", {});
      expect(showResult.status).toBe("ok");
    } finally {
      provider.stop();
    }
  });
});
