import { action, createSlopServer, type ItemDescriptor, type SlopServer } from "@slop-ai/server";

type WorkspaceProjectConfig = {
  name?: string;
  description?: string;
  root: string;
  configPath: string;
  tags: string[];
};

type WorkspaceConfig = {
  name?: string;
  description?: string;
  root: string;
  configPath: string;
  tags: string[];
  projects: Record<string, WorkspaceProjectConfig>;
};

type WorkspaceRegistryConfig = {
  activeWorkspaceId?: string;
  activeProjectId?: string;
  items: Record<string, WorkspaceConfig>;
};

type ConfigLayer = {
  scope: "global" | "workspace" | "project";
  id: string;
  path: string;
};

function nodeId(value: string): string {
  return encodeURIComponent(value);
}

function firstKey(record: Record<string, unknown>): string | undefined {
  return Object.keys(record).sort()[0];
}

export class WorkspacesProvider {
  readonly server: SlopServer;
  private activeWorkspaceId: string | undefined;
  private activeProjectId: string | undefined;
  private readonly registry: WorkspaceRegistryConfig;
  private readonly globalConfigPath: string;

  constructor(options: {
    registry?: WorkspaceRegistryConfig;
    globalConfigPath: string;
  }) {
    this.registry = options.registry ?? { items: {} };
    this.activeWorkspaceId =
      this.registry.activeWorkspaceId && this.registry.items[this.registry.activeWorkspaceId]
        ? this.registry.activeWorkspaceId
        : firstKey(this.registry.items);
    this.activeProjectId = this.normalizeProjectId(
      this.activeWorkspaceId,
      this.registry.activeProjectId,
    );
    this.globalConfigPath = options.globalConfigPath;

    // Keep the server id distinct from the /workspaces collection path; the
    // current server router treats identical provider/path ids ambiguously for
    // dynamic item affordance lookup.
    this.server = createSlopServer({
      id: "workspace-registry",
      name: "Workspaces",
    });

    this.server.register("session", () => this.buildSessionDescriptor());
    this.server.register("workspaces", () => this.buildWorkspacesDescriptor());
    this.server.register("projects", () => this.buildProjectsDescriptor());
    this.server.register("config", () => this.buildConfigDescriptor());
  }

  stop(): void {
    this.server.stop();
  }

  private normalizeProjectId(
    workspaceId: string | undefined,
    projectId: string | undefined,
  ): string | undefined {
    if (!workspaceId || !projectId) {
      return undefined;
    }

    const workspace = this.registry.items[workspaceId];
    return workspace?.projects[projectId] ? projectId : undefined;
  }

  private activeWorkspace(): { id: string; workspace: WorkspaceConfig } | undefined {
    if (!this.activeWorkspaceId) {
      return undefined;
    }

    const workspace = this.registry.items[this.activeWorkspaceId];
    if (!workspace) {
      return undefined;
    }

    return { id: this.activeWorkspaceId, workspace };
  }

  private activeProject():
    | {
        workspaceId: string;
        projectId: string;
        project: WorkspaceProjectConfig;
      }
    | undefined {
    const active = this.activeWorkspace();
    if (!active || !this.activeProjectId) {
      return undefined;
    }

    const project = active.workspace.projects[this.activeProjectId];
    if (!project) {
      return undefined;
    }

    return {
      workspaceId: active.id,
      projectId: this.activeProjectId,
      project,
    };
  }

  private configLayers(): ConfigLayer[] {
    const layers: ConfigLayer[] = [
      {
        scope: "global",
        id: "home",
        path: this.globalConfigPath,
      },
    ];
    const activeWorkspace = this.activeWorkspace();
    if (activeWorkspace) {
      layers.push({
        scope: "workspace",
        id: activeWorkspace.id,
        path: activeWorkspace.workspace.configPath,
      });
    }
    const activeProject = this.activeProject();
    if (activeProject) {
      layers.push({
        scope: "project",
        id: activeProject.projectId,
        path: activeProject.project.configPath,
      });
    }

    return layers;
  }

  private selectWorkspace(workspaceId: string): {
    active_workspace_id: string;
    active_project_id: string | null;
    config_layers: ConfigLayer[];
  } {
    if (!this.registry.items[workspaceId]) {
      throw new Error(`Unknown workspace: ${workspaceId}`);
    }

    this.activeWorkspaceId = workspaceId;
    this.activeProjectId = undefined;
    this.server.refresh();

    return {
      active_workspace_id: workspaceId,
      active_project_id: null,
      config_layers: this.configLayers(),
    };
  }

  private selectProject(projectId: string): {
    active_workspace_id: string;
    active_project_id: string;
    config_layers: ConfigLayer[];
  } {
    const active = this.activeWorkspace();
    if (!active) {
      throw new Error("No active workspace is selected.");
    }
    if (!active.workspace.projects[projectId]) {
      throw new Error(`Unknown project for workspace ${active.id}: ${projectId}`);
    }

    this.activeProjectId = projectId;
    this.server.refresh();

    return {
      active_workspace_id: active.id,
      active_project_id: projectId,
      config_layers: this.configLayers(),
    };
  }

  private buildSessionDescriptor() {
    const activeWorkspace = this.activeWorkspace();
    const activeProject = this.activeProject();
    const workspaceCount = Object.keys(this.registry.items).length;
    const projectCount = activeWorkspace
      ? Object.keys(activeWorkspace.workspace.projects).length
      : 0;

    return {
      type: "context",
      props: {
        workspace_count: workspaceCount,
        active_workspace_id: activeWorkspace?.id ?? null,
        active_workspace_root: activeWorkspace?.workspace.root ?? null,
        active_project_id: activeProject?.projectId ?? null,
        active_project_root: activeProject?.project.root ?? null,
        project_count: projectCount,
        config_layers: this.configLayers(),
      },
      summary:
        "Workspace/project registry for selecting folder-bound scopes and their config layer order.",
      actions: {
        set_active_workspace: action(
          { workspace_id: "string" },
          async ({ workspace_id }) => this.selectWorkspace(workspace_id),
          {
            label: "Set Workspace",
            description: "Select the active workspace for this runtime view.",
            estimate: "instant",
          },
        ),
        set_active_project: action(
          { project_id: "string" },
          async ({ project_id }) => this.selectProject(project_id),
          {
            label: "Set Project",
            description: "Select the active project within the active workspace.",
            estimate: "instant",
          },
        ),
        get_config_layers: action(async () => this.configLayers(), {
          label: "Get Config Layers",
          description: "Return the active global/workspace/project config layer order.",
          idempotent: true,
          estimate: "instant",
        }),
      },
      meta: {
        focus: workspaceCount > 0,
        salience: workspaceCount > 0 ? 0.7 : 0.25,
      },
    };
  }

  private buildWorkspacesDescriptor() {
    const items: ItemDescriptor[] = Object.entries(this.registry.items)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([id, workspace]) => this.buildWorkspaceItem(id, workspace));

    return {
      type: "collection",
      props: {
        count: items.length,
        active_workspace_id: this.activeWorkspaceId ?? null,
      },
      summary: "Registered workspaces available to this runtime instance.",
      items,
    };
  }

  private buildWorkspaceItem(id: string, workspace: WorkspaceConfig): ItemDescriptor {
    const selected = this.activeWorkspaceId === id;
    return {
      id: nodeId(id),
      props: {
        id,
        name: workspace.name ?? id,
        description: workspace.description ?? null,
        root: workspace.root,
        config_path: workspace.configPath,
        tags: workspace.tags,
        project_count: Object.keys(workspace.projects).length,
        selected,
      },
      summary: workspace.description ?? `${workspace.name ?? id}: ${workspace.root}`,
      actions: {
        set_active: action(async () => this.selectWorkspace(id), {
          label: "Select Workspace",
          description: "Select this workspace as active.",
          estimate: "instant",
        }),
      },
      meta: {
        salience: selected ? 0.85 : 0.55,
      },
    };
  }

  private buildProjectsDescriptor() {
    const active = this.activeWorkspace();
    const projects = active?.workspace.projects ?? {};
    const items = Object.entries(projects)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([projectId, project]) => this.buildProjectItem(active?.id ?? "", projectId, project));

    return {
      type: "collection",
      props: {
        count: items.length,
        active_workspace_id: active?.id ?? null,
        active_project_id: this.activeProjectId ?? null,
      },
      summary: "Projects for the active workspace.",
      items,
    };
  }

  private buildProjectItem(
    workspaceId: string,
    projectId: string,
    project: WorkspaceProjectConfig,
  ): ItemDescriptor {
    const selected = this.activeWorkspaceId === workspaceId && this.activeProjectId === projectId;
    return {
      id: nodeId(projectId),
      props: {
        id: projectId,
        workspace_id: workspaceId,
        name: project.name ?? projectId,
        description: project.description ?? null,
        root: project.root,
        config_path: project.configPath,
        tags: project.tags,
        selected,
      },
      summary: project.description ?? `${project.name ?? projectId}: ${project.root}`,
      actions: {
        set_active: action(
          async () => {
            if (this.activeWorkspaceId !== workspaceId) {
              this.selectWorkspace(workspaceId);
            }
            return this.selectProject(projectId);
          },
          {
            label: "Select Project",
            description: "Select this project as active.",
            estimate: "instant",
          },
        ),
      },
      meta: {
        salience: selected ? 0.85 : 0.55,
      },
    };
  }

  private buildConfigDescriptor() {
    return {
      type: "context",
      props: {
        layers: this.configLayers(),
      },
      summary:
        "Active config layer order. Later layers override earlier layers when a session is created for this scope.",
      actions: {
        get_layers: action(async () => this.configLayers(), {
          label: "Get Layers",
          description: "Return the active config layer order.",
          idempotent: true,
          estimate: "instant",
        }),
      },
      meta: {
        salience: 0.55,
      },
    };
  }
}
