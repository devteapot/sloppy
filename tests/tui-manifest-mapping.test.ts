import { describe, expect, test } from "bun:test";
import { type Terminal, TUI } from "@earendil-works/pi-tui";

import { EMPTY_SESSION_VIEW } from "../apps/tui/src/backend/node-mappers";
import type { SupervisorSnapshot } from "../apps/tui/src/backend/supervisor-client";
import {
  parseLocalCommand,
  parsePluginSlashCommand,
} from "../apps/tui/src/projections/command-parser";
import {
  projectIndicators,
  projectPluginActions,
} from "../apps/tui/src/projections/manifest-projection";
import { buildCommandPaletteCommands } from "../apps/tui/src/projections/palette-items";
import {
  evaluatePluginNotifications,
  readPluginNotificationValue,
} from "../apps/tui/src/projections/plugin-notifications";
import { detectInlineSecret } from "../apps/tui/src/projections/secret-detection";
import { buildSlashEntries, matchSlashEntries } from "../apps/tui/src/projections/slash-catalog";
import { CustomEditor } from "../apps/tui/src/ui/custom-editor";
import { singleLineText } from "../apps/tui/src/ui/render-safety";
import { routeOverlayText } from "../apps/tui/src/ui/route-overlay";
import { SlashAutocompleteProvider } from "../apps/tui/src/ui/slash-autocomplete";
import { StatusLine } from "../apps/tui/src/ui/status-line";

class FakeTerminal implements Terminal {
  get columns(): number {
    return 80;
  }

  get rows(): number {
    return 24;
  }

  get kittyProtocolActive(): boolean {
    return false;
  }

  start(): void {}
  stop(): void {}
  async drainInput(): Promise<void> {}
  write(): void {}
  moveBy(): void {}
  hideCursor(): void {}
  showCursor(): void {}
  clearLine(): void {}
  clearFromCursor(): void {}
  clearScreen(): void {}
  setTitle(): void {}
  setProgress(): void {}
}

const TEST_ESC = String.fromCharCode(0x1b);
const TEST_BEL = String.fromCharCode(0x07);
const TEST_APC_PATTERN = new RegExp(`${TEST_ESC}_[\\s\\S]*?${TEST_BEL}`, "g");
const TEST_OSC_PATTERN = new RegExp(`${TEST_ESC}\\][\\s\\S]*?(?:${TEST_BEL}|${TEST_ESC}\\\\)`, "g");
const TEST_CSI_PATTERN = new RegExp(`${TEST_ESC}\\[[0-?]*[ -/]*[@-~]`, "g");

function stripAnsiForTest(value: string): string {
  return value
    .replace(TEST_APC_PATTERN, "")
    .replace(TEST_OSC_PATTERN, "")
    .replace(TEST_CSI_PATTERN, "");
}

describe("TUI client contribution mapping", () => {
  test("projects client plugin contributions into actions, notifications, indicators, and slash entries", () => {
    const next = {
      ...EMPTY_SESSION_VIEW,
      plugins: [
        {
          id: "persistent-goal",
          version: "1.0.0",
          status: "active",
          description: "Persistent long-running session objective controls.",
          ui: {
            actions: [
              {
                id: "goal:create",
                label: "Create Goal",
                description: "Create a persistent session goal",
                command: "create",
                available: true,
                argument: { name: "objective", required: true, param: "objective" },
                presentation: {
                  tui: {
                    slash: {
                      name: "goal",
                      signature: "<objective>|pause|resume|complete|clear",
                    },
                  },
                },
              },
            ],
            notifications: [
              {
                id: "goal-complete",
                source: "goal",
                field: "status",
                to: "complete",
                message: "Goal complete: {objective}",
              },
            ],
            indicators: [
              {
                id: "goal-status",
                source: "goal",
                template: "goal {status}",
              },
            ],
          },
        },
      ],
    };

    expect(next.plugins[0]?.id).toBe("persistent-goal");
    expect(next.plugins[0]?.ui.actions?.[0]).toMatchObject({
      id: "goal:create",
      command: "create",
      available: true,
    });
    expect(next.plugins[0]?.ui.notifications?.[0]).toEqual({
      id: "goal-complete",
      source: "goal",
      field: "status",
      to: "complete",
      message: "Goal complete: {objective}",
    });
    expect(next.plugins[0]?.ui.indicators?.[0]?.template).toBe("goal {status}");

    expect(buildSlashEntries().some((entry) => entry.name === "persistent-goal:goal")).toBe(false);
    expect(
      buildSlashEntries(next.plugins).some((entry) => entry.name === "persistent-goal:goal"),
    ).toBe(true);
    expect(buildSlashEntries(next.plugins).some((entry) => entry.name === "runtime")).toBe(true);
    expect(matchSlashEntries("/persistent-goal:go", 8, next.plugins)[0]?.entry.name).toBe(
      "persistent-goal:goal",
    );
    expect(matchSlashEntries("/qc")[0]?.entry.name).toBe("queue-cancel");
  });

  test("builds highlighted slash autocomplete suggestions from built-ins and plugins", async () => {
    const plugins = [
      {
        id: "custom-plugin",
        version: "1.0.0",
        status: "active",
        ui: {
          actions: [
            {
              id: "custom:run",
              label: "Run Custom",
              description: "Run a custom plugin action",
              command: "run",
              available: true,
              presentation: { tui: { slash: { name: "custom", signature: "<text>" } } },
            },
          ],
          notifications: [],
          indicators: [],
        },
      },
    ];
    const provider = new SlashAutocompleteProvider(buildSlashEntries(plugins));
    const builtIn = await provider.getSuggestions(["/ver"], 0, 4, {
      signal: new AbortController().signal,
    });

    expect(builtIn?.prefix).toBe("/ver");
    expect(builtIn?.items[0]?.value).toBe("verbosity");
    expect(stripAnsiForTest(builtIn?.items[0]?.label ?? "")).toBe("verbosity");
    expect(builtIn?.items[0]?.label).toContain("\x1b[");
    expect(builtIn?.items[0]?.description).toContain("[compact|verbose]");

    const applied = provider.applyCompletion(
      ["/ver"],
      0,
      4,
      builtIn?.items[0] ?? { value: "", label: "" },
      builtIn?.prefix ?? "",
    );
    expect(applied.lines[0]).toBe("/verbosity ");

    const plugin = await provider.getSuggestions(["/cu"], 0, 3, {
      signal: new AbortController().signal,
    });
    expect(plugin?.items[0]?.value).toBe("custom-plugin:custom");
    expect(plugin?.items[0]?.description).toContain("Run a custom plugin action");

    const unavailableProvider = new SlashAutocompleteProvider(
      buildSlashEntries([
        {
          ...plugins[0],
          ui: {
            ...plugins[0]!.ui,
            actions: plugins[0]!.ui.actions.map((action) => ({ ...action, available: false })),
          },
        },
      ]),
    );
    expect(
      await unavailableProvider.getSuggestions(["/cu"], 0, 3, {
        signal: new AbortController().signal,
      }),
    ).toBeNull();
  });

  test("namespaces plugin slash names and keeps built-ins unqualified", async () => {
    const plugins = [
      {
        id: "shadow-plugin",
        version: "1.0.0",
        status: "active",
        ui: {
          actions: [
            {
              id: "shadow:help",
              label: "Shadow Help",
              description: "Attempt to shadow help",
              command: "help",
              available: true,
              presentation: { tui: { slash: { name: "help" } } },
            },
            {
              id: "shadow:alias",
              label: "Shadow Alias",
              description: "Namespaced built-in alias",
              command: "alias",
              available: true,
              presentation: { tui: { slash: { name: "custom", aliases: ["q"] } } },
            },
            {
              id: "shadow:duplicate",
              label: "Shadow Duplicate",
              description: "Duplicate plugin command",
              command: "duplicate",
              available: true,
              presentation: { tui: { slash: { name: "help" } } },
            },
          ],
          notifications: [],
          indicators: [],
        },
      },
    ];
    const entries = buildSlashEntries(plugins);

    expect(entries.find((entry) => entry.name === "help")?.description).toBe(
      "Show hotkeys and slash commands",
    );
    expect(entries.some((entry) => entry.name === "shadow-plugin:help")).toBe(true);
    expect(entries.find((entry) => entry.name === "shadow-plugin:custom")?.aliases).toContain(
      "shadow-plugin:q",
    );
    expect(entries.filter((entry) => entry.name === "shadow-plugin:help")).toHaveLength(1);
    const provider = new SlashAutocompleteProvider(entries);
    expect(
      (
        await provider.getSuggestions(["/help"], 0, 5, {
          signal: new AbortController().signal,
        })
      )?.items[0]?.value,
    ).toBe("help");
    expect(
      (
        await provider.getSuggestions(["/shadow"], 0, 7, {
          signal: new AbortController().signal,
        })
      )?.items.map((item) => item.value),
    ).toContain("shadow-plugin:help");
  });

  test("parses plugin slash commands into typed plugin commands", () => {
    const snapshot = {
      ...EMPTY_SESSION_VIEW,
      plugins: [
        {
          id: "custom-plugin",
          version: "1.0.0",
          status: "active",
          ui: {
            actions: [
              {
                id: "custom:run",
                label: "Run Custom",
                description: "Run a custom plugin action",
                command: "run",
                available: true,
                params: { mode: "fast" },
                argument: { name: "text", required: true, param: "text" },
                presentation: { tui: { slash: { name: "custom", signature: "<text>" } } },
              },
            ],
            notifications: [],
            indicators: [],
          },
        },
      ],
    };

    expect(parsePluginSlashCommand("/custom-plugin:custom hello world", snapshot)).toEqual({
      type: "plugin_action",
      pluginId: "custom-plugin",
      actionId: "custom:run",
      label: "Run Custom",
      command: "run",
      params: { mode: "fast", text: "hello world" },
    });
    expect(parsePluginSlashCommand("/custom-plugin:custom", snapshot)).toEqual({
      type: "rejected",
      reason: "Usage: /custom-plugin:custom <text>",
    });

    const shadowingSnapshot = {
      ...snapshot,
      plugins: [
        {
          id: "shadow-plugin",
          version: "1.0.0",
          status: "active",
          ui: {
            actions: [
              {
                id: "shadow:help",
                label: "Shadow Help",
                description: "Attempt to shadow help",
                command: "help",
                available: true,
                presentation: { tui: { slash: { name: "help" } } },
              },
            ],
            notifications: [],
            indicators: [],
          },
        },
      ],
    };
    expect(parsePluginSlashCommand("/help", shadowingSnapshot)).toBeNull();
    expect(parsePluginSlashCommand("/shadow-plugin:help", shadowingSnapshot)).toEqual({
      type: "plugin_action",
      pluginId: "shadow-plugin",
      actionId: "shadow:help",
      label: "Shadow Help",
      command: "help",
      params: undefined,
    });
  });

  test("renders and clears composer sigil drafts", () => {
    const tui = new TUI(new FakeTerminal());
    const editor = new CustomEditor(tui);

    editor.setText("/help");
    const slashRender = stripAnsiForTest(editor.render(44).join("\n"));
    expect(slashRender).toContain("?/ help");
    expect(slashRender).not.toContain("?/ /help");

    expect(editor.clearSigilDraft()).toBe(true);
    expect(stripAnsiForTest(editor.render(44).join("\n"))).toContain("?>");

    editor.setText("$pwd");
    const shellRender = stripAnsiForTest(editor.render(44).join("\n"));
    expect(shellRender).toContain("?$ pwd");
    expect(shellRender).not.toContain("?$ $pwd");

    expect(editor.clearSigilDraft()).toBe(true);
    expect(stripAnsiForTest(editor.render(44).join("\n"))).toContain("?>");

    editor.setText("hello");
    expect(editor.clearSigilDraft()).toBe(false);
    expect(stripAnsiForTest(editor.render(44).join("\n"))).toContain("?> hello");
  });

  test("parses explicit verbosity commands without compact aliases", () => {
    expect(parseLocalCommand("/verbosity")).toEqual({ type: "verbosity", mode: "show" });
    expect(parseLocalCommand("/verbosity compact")).toEqual({
      type: "verbosity",
      mode: "compact",
    });
    expect(parseLocalCommand("/verbosity verbose")).toEqual({
      type: "verbosity",
      mode: "verbose",
    });
    expect(parseLocalCommand("/compact")).toEqual({ type: "unknown", name: "/compact" });
    expect(
      buildSlashEntries().find((entry) => entry.name === "verbosity")?.aliases,
    ).toBeUndefined();
  });

  test("parses session approval mode commands", () => {
    expect(parseLocalCommand("/approval")).toEqual({ type: "approval_mode", mode: "show" });
    expect(parseLocalCommand("/approval normal")).toEqual({
      type: "approval_mode",
      mode: "normal",
    });
    expect(parseLocalCommand("/approval auto")).toEqual({
      type: "approval_mode",
      mode: "auto",
    });
    expect(parseLocalCommand("/approval toggle")).toEqual({
      type: "approval_mode",
      mode: "toggle",
    });
    expect(parseLocalCommand("/approval nope")).toEqual({
      type: "rejected",
      reason: "Usage: /approval [normal|auto|toggle]",
    });
  });

  test("parses config reload commands", () => {
    expect(parseLocalCommand("/reload-config")).toEqual({
      type: "config_reload",
      target: "session",
    });
    expect(parseLocalCommand("/config-reload supervisor")).toEqual({
      type: "config_reload",
      target: "supervisor",
    });
    expect(parseLocalCommand("/reload-config all")).toEqual({
      type: "unknown",
      name: "/reload-config all",
    });
    expect(buildSlashEntries().find((entry) => entry.name === "reload-config")).toBeTruthy();
  });

  test("rejects inline secrets in /profile and detects secret-shaped values", () => {
    expect(parseLocalCommand("/profile openai gpt-5 --api-key sk-abc12345678")?.type).toBe(
      "rejected",
    );

    expect(detectInlineSecret(["--api-key", "sk-abc12345678"])).toBeDefined();
    expect(detectInlineSecret(["--api-key=sk-abc12345678"])).toBeDefined();
    expect(detectInlineSecret(["--token", "anything-at-all"])).toBeDefined();
    expect(detectInlineSecret(["ghp_0123456789abcdef0123"])).toBeDefined();
    expect(detectInlineSecret(["github_pat_11ABCDEFG0123456789012"])).toBeDefined();
    expect(detectInlineSecret(["xoxb-1234567890-abc"])).toBeDefined();
    expect(detectInlineSecret(["AKIAIOSFODNN7EXAMPLE"])).toBeDefined();
    expect(detectInlineSecret(["--label=sk-abc12345678"])).toBeDefined();

    expect(detectInlineSecret(["--token"])).toBeUndefined();
    expect(detectInlineSecret(["--token", "--no-default"])).toBeUndefined();
    expect(detectInlineSecret(["--label", "my profile"])).toBeUndefined();
    expect(detectInlineSecret(["openai", "gpt-5"])).toBeUndefined();
    expect(detectInlineSecret([])).toBeUndefined();
  });

  test("slash catalog and command parser agree on plugin slash presentations", () => {
    const snapshot = {
      ...EMPTY_SESSION_VIEW,
      plugins: [
        {
          id: "demo",
          version: "1.0.0",
          status: "active",
          ui: {
            actions: [
              {
                id: "demo:deploy",
                label: "Deploy",
                description: "Deploy a target",
                command: "deploy",
                available: true,
                argument: { name: "target", required: true, param: "target" },
                presentation: {
                  tui: { slash: { name: "deploy", aliases: ["ship"], signature: "<target>" } },
                },
              },
            ],
            indicators: [],
            notifications: [],
          },
        },
      ],
    };

    const entry = buildSlashEntries(snapshot.plugins).find(
      (candidate) => candidate.name === "demo:deploy",
    );
    expect(entry).toMatchObject({
      name: "demo:deploy",
      aliases: ["demo:ship"],
      signature: "<target>",
    });

    const expected = {
      type: "plugin_action",
      pluginId: "demo",
      command: "deploy",
      params: { target: "prod" },
    };
    expect(parsePluginSlashCommand("/demo:deploy prod", snapshot)).toMatchObject(expected);
    expect(parsePluginSlashCommand("/demo:ship prod", snapshot)).toMatchObject(expected);
  });

  test("projects plugin actions, indicators, and command palette entries from live state", () => {
    const withGoal = {
      ...EMPTY_SESSION_VIEW,
      goal: {
        ...EMPTY_SESSION_VIEW.goal,
        exists: true,
        status: "active",
        objective: "Ship the typed client",
        totalTokens: 1200,
      },
      plugins: [
        {
          id: "persistent-goal",
          version: "1.0.0",
          status: "active",
          ui: {
            actions: [
              {
                id: "goal:pause",
                label: "Pause Goal",
                description: "Pause automatic goal continuation",
                command: "pause",
                available: true,
              },
            ],
            indicators: [
              {
                id: "goal-status",
                source: "goal",
                template: "goal {status} {totalTokens}",
                fields: { totalTokens: { format: "number" as const } },
                visibleWhen: { field: "exists", equals: true },
              },
            ],
            notifications: [],
          },
        },
      ],
    };

    expect(projectPluginActions(withGoal)).toMatchObject([
      {
        pluginId: "persistent-goal",
        available: true,
        action: { id: "goal:pause" },
      },
    ]);
    expect(projectIndicators(withGoal)).toMatchObject([
      {
        pluginId: "persistent-goal",
        text: "goal active 1,200",
      },
    ]);
    expect(
      buildCommandPaletteCommands(withGoal).some((item) => item.id.includes("goal:pause")),
    ).toBe(true);
    const statusLine = new StatusLine();
    statusLine.update(withGoal, "default");
    const statusText = statusLine.render(120).join("\n");
    expect(statusText).toContain("goal active 1,200");
    expect(statusText).not.toContain("thinking");
    expect(statusText).not.toContain("Idle");
    expect(routeOverlayText("help", withGoal, null)).toContain("/help");
  });

  test("renders supervised session approval modes in the runtime overlay", () => {
    const supervisor: SupervisorSnapshot = {
      connection: { status: "connected", socketPath: "/tmp/supervisor.sock" },
      resumeSessionId: "auto-session",
      autoCloseEnabled: false,
      clientLeaseCount: 1,
      sessions: [
        {
          id: "auto-session",
          socketPath: "/tmp/auto.sock",
          runtimeStatus: "live",
          queuedCount: 0,
          pendingApprovalCount: 0,
          runningTaskCount: 0,
          goalTotalTokens: 0,
          approvalMode: "auto",
          isResumeSession: true,
          canSwitch: true,
          canStop: true,
        },
        {
          id: "normal-session",
          socketPath: "",
          runtimeStatus: "dormant",
          queuedCount: 0,
          pendingApprovalCount: 0,
          runningTaskCount: 0,
          goalTotalTokens: 0,
          approvalMode: "normal",
          isResumeSession: false,
          canSwitch: true,
          canStop: false,
        },
      ],
      scopes: [],
    };

    const rendered = routeOverlayText("runtime", EMPTY_SESSION_VIEW, supervisor);
    expect(rendered).toContain("* auto-session live approval=auto");
    expect(rendered).toContain("normal-session dormant approval=normal");
  });

  test("collapses embedded newlines in untrusted overlay fields", () => {
    const snapshot = {
      ...EMPTY_SESSION_VIEW,
      approvals: [
        {
          id: "a1",
          status: "pending",
          provider: "terminal",
          path: "/terminal",
          action: "run",
          reason: "looks safe\na2 approved terminal.run\n  forged detail",
          dangerous: false,
          canApprove: true,
          canReject: true,
        },
      ],
    };

    const rendered = routeOverlayText("approvals", snapshot, null);
    // The reason renders as one indented line; no forged top-level row.
    const topLevelRows = rendered.split("\n").filter((row) => row && !row.startsWith("  "));
    expect(topLevelRows).toEqual(["a1 pending terminal.run"]);
    expect(rendered).toContain("  looks safe a2 approved terminal.run forged detail");

    const sessionTitle = {
      connection: { status: "connected" as const, socketPath: "/tmp/s.sock" },
      autoCloseEnabled: false,
      clientLeaseCount: 0,
      scopes: [],
      sessions: [
        {
          id: "s1",
          title: "real\n s2 live approval=auto",
          socketPath: "/tmp/s.sock",
          runtimeStatus: "live" as const,
          queuedCount: 0,
          pendingApprovalCount: 0,
          runningTaskCount: 0,
          goalTotalTokens: 0,
          approvalMode: "normal" as const,
          isResumeSession: false,
          canSwitch: true,
          canStop: true,
        },
      ],
    };
    const runtime = routeOverlayText("runtime", EMPTY_SESSION_VIEW, sessionTitle);
    expect(runtime).toContain("s1 live approval=normal real s2 live approval=auto");
  });

  test("singleLineText folds CRLF, tabs, and escape sequences into single spaces", () => {
    expect(singleLineText("a\r\nb\tc\u001b[31m d ")).toBe("a b c d");
    expect(singleLineText(undefined)).toBe("");
    expect(singleLineText("  plain  ")).toBe("plain");
  });

  test("evaluates plugin manifest notifications against session snapshots", () => {
    const pending = {
      ...EMPTY_SESSION_VIEW,
      goal: {
        ...EMPTY_SESSION_VIEW.goal,
        exists: true,
        status: "active",
        objective: "Ship the typed client",
      },
      plugins: [
        {
          id: "persistent-goal",
          version: "1.0.0",
          status: "active",
          ui: {
            actions: [],
            indicators: [],
            notifications: [
              {
                id: "goal-complete",
                source: "goal",
                field: "status",
                to: "complete",
                message: "Goal complete: {objective}",
              },
            ],
          },
        },
      ],
    };
    const previousValues = new Map<string, string | undefined>();

    expect(readPluginNotificationValue(pending, "goal", "status")).toBe("active");
    expect(evaluatePluginNotifications(pending, previousValues)).toEqual([]);

    const complete = {
      ...pending,
      goal: {
        ...pending.goal,
        status: "complete",
      },
    };
    expect(evaluatePluginNotifications(complete, previousValues)).toMatchObject([
      {
        key: "persistent-goal:goal-complete",
        message: "Goal complete: Ship the typed client",
      },
    ]);
  });
});
