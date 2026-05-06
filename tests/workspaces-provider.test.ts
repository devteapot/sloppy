import { describe, expect, test } from "bun:test";
import { SlopConsumer } from "@slop-ai/consumer/browser";

import { InProcessTransport } from "../src/providers/builtin/in-process";
import { WorkspacesProvider } from "../src/providers/builtin/workspaces";

describe("WorkspacesProvider", () => {
  test("exposes workspace/project selection and scoped config layer order", async () => {
    const provider = new WorkspacesProvider({
      globalConfigPath: "/home/user/.sloppy/config.yaml",
      registry: {
        activeWorkspaceId: "alpha",
        activeProjectId: "api",
        items: {
          alpha: {
            name: "Alpha",
            root: "/work/alpha",
            configPath: "/work/alpha/.sloppy/config.yaml",
            tags: ["code"],
            projects: {
              api: {
                name: "API",
                root: "/work/alpha/apps/api",
                configPath: "/work/alpha/apps/api/.sloppy/config.yaml",
                tags: ["service"],
              },
            },
          },
          beta: {
            name: "Beta",
            root: "/work/beta",
            configPath: "/work/beta/.sloppy/config.yaml",
            tags: [],
            projects: {},
          },
        },
      },
    });
    const consumer = new SlopConsumer(new InProcessTransport(provider.server));

    try {
      await consumer.connect();

      const session = await consumer.query("/session", 2);
      expect(session.properties?.active_workspace_id).toBe("alpha");
      expect(session.properties?.active_project_id).toBe("api");
      expect(session.properties?.config_layers).toEqual([
        {
          scope: "global",
          id: "home",
          path: "/home/user/.sloppy/config.yaml",
        },
        {
          scope: "workspace",
          id: "alpha",
          path: "/work/alpha/.sloppy/config.yaml",
        },
        {
          scope: "project",
          id: "api",
          path: "/work/alpha/apps/api/.sloppy/config.yaml",
        },
      ]);

      const workspaces = await consumer.query("/workspaces", 3);
      expect(workspaces.children?.map((child) => child.id)).toEqual(["alpha", "beta"]);
      const projects = await consumer.query("/projects", 2);
      expect(projects.children?.[0]?.properties?.root).toBe("/work/alpha/apps/api");

      const selectWorkspace = await consumer.invoke("/workspaces/beta", "set_active", {});
      expect(selectWorkspace.status).toBe("ok");
      expect(selectWorkspace.data).toMatchObject({
        active_workspace_id: "beta",
        active_project_id: null,
      });

      const updated = await consumer.query("/session", 2);
      expect(updated.properties?.active_workspace_id).toBe("beta");
      expect(updated.properties?.active_project_id).toBeNull();
      expect(updated.properties?.config_layers).toEqual([
        {
          scope: "global",
          id: "home",
          path: "/home/user/.sloppy/config.yaml",
        },
        {
          scope: "workspace",
          id: "beta",
          path: "/work/beta/.sloppy/config.yaml",
        },
      ]);
    } finally {
      provider.stop();
    }
  });
});
