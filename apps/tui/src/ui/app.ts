import {
  Container,
  matchesKey,
  type OverlayHandle,
  ProcessTerminal,
  Text,
  TUI,
} from "@earendil-works/pi-tui";

import type { SessionClient } from "../backend/session-client";
import type { ApprovalMode, SessionViewSnapshot, TuiRoute } from "../backend/slop-types";
import {
  endpointForSession,
  type SessionSupervisorClient,
  type SupervisorSnapshot,
} from "../backend/supervisor-client";
import { parseLocalCommand, parsePluginSlashCommand } from "../projections/command-parser";
import type { LocalCommand, Verbosity } from "../projections/command-types";
import { buildCommandPaletteCommands, type PaletteCommand } from "../projections/palette-items";
import { evaluatePluginNotifications } from "../projections/plugin-notifications";
import { buildSlashEntries } from "../projections/slash-catalog";
import { ChatLog } from "./chat-log";
import { CommandPalette } from "./command-palette";
import { CustomEditor } from "./custom-editor";
import { sanitizeTerminalText } from "./render-safety";
import { RouteOverlay, routeOverlayText } from "./route-overlay";
import { type InteractionMode, StatusLine, turnStatusLabel } from "./status-line";
import { dim } from "./theme";

export type AppUiOptions = {
  supervisor?: SessionSupervisorClient;
  onSwitchSocket?: (socketPath: string) => Promise<void>;
};

export class AppUi {
  readonly tui: TUI;
  private readonly root = new Container();
  private readonly header = new Text("sloppy");
  private readonly chatLog = new ChatLog();
  private readonly statusLine = new StatusLine();
  private readonly notice = new Text("");
  private readonly turnStatus = new Text("", 1, 0);
  private readonly editor: CustomEditor;
  private snapshot: SessionViewSnapshot | null = null;
  private supervisorSnapshot: SupervisorSnapshot | null = null;
  private route: TuiRoute = "chat";
  private mode: InteractionMode = "default";
  private verbosity: Verbosity = "compact";
  private thinkingExpandedOverride: boolean | null = null;
  private notificationValues = new Map<string, string | undefined>();
  private routeOverlay: OverlayHandle | null = null;
  private routeOverlayComponent: RouteOverlay | null = null;
  private paletteOverlay: OverlayHandle | null = null;

  constructor(
    private readonly client: SessionClient,
    private readonly options: AppUiOptions = {},
  ) {
    this.tui = new TUI(new ProcessTerminal());
    this.editor = new CustomEditor(this.tui);
    this.editor.onSubmit = (text) => {
      this.editor.setText("");
      this.submit(text).catch((error: unknown) => {
        this.setNotice(error instanceof Error ? error.message : String(error));
      });
    };

    this.root.addChild(this.header);
    this.root.addChild(this.chatLog);
    this.root.addChild(this.notice);
    this.root.addChild(this.turnStatus);
    this.root.addChild(this.editor);
    this.root.addChild(this.statusLine);
    this.tui.addChild(this.root);
    this.tui.setFocus(this.editor);
    this.tui.addInputListener((data) => {
      if (matchesKey(data, "ctrl+c")) {
        this.client.disconnect();
        this.options.supervisor?.disconnect();
        this.stop();
        process.exit(0);
      }
      if (matchesKey(data, "ctrl+k")) {
        this.showPalette();
        return { consume: true };
      }
      if (matchesKey(data, "shift+tab")) {
        this.cycleMode();
        return { consume: true };
      }
      if (matchesKey(data, "ctrl+o")) {
        this.toggleThinkingOutput();
        return { consume: true };
      }
      if (matchesKey(data, "escape")) {
        if (this.paletteOverlay) {
          this.hidePalette();
          return { consume: true };
        }
        if (this.routeOverlay) {
          this.hideRoute();
          return { consume: true };
        }
        if (this.editor.clearSigilDraft()) {
          return { consume: true };
        }
        if (!this.snapshot?.turn.canCancel) {
          return { consume: true };
        }
        this.client.cancelTurn().catch((error: unknown) => {
          this.setNotice(error instanceof Error ? error.message : String(error));
        });
        return { consume: true };
      }
      return undefined;
    });
  }

  update(snapshot: SessionViewSnapshot): void {
    this.snapshot = snapshot;
    this.header.setText(this.headerText(snapshot));
    this.chatLog.update(snapshot, {
      verbosity: this.verbosity,
      thinking: this.thinkingRenderMode(),
    });
    this.statusLine.update(snapshot, this.mode);
    this.turnStatus.setText(dim(turnStatusLabel(snapshot)));
    this.editor.setModeLabel(this.mode);
    this.editor.setApprovalMode(snapshot.approvalMode);
    this.editor.setWorkspaceRoot(snapshot.session.workspaceRoot);
    this.editor.setSlashEntries(
      buildSlashEntries(snapshot.plugins, { actionsByPath: snapshot.actionsByPath }),
    );
    for (const notification of evaluatePluginNotifications(snapshot, this.notificationValues)) {
      this.setNotice(notification.message);
    }
    this.editor.disableSubmit = !snapshot.composer.canSend;
    this.refreshRouteOverlay();
    this.tui.requestRender();
  }

  updateSupervisor(snapshot: SupervisorSnapshot): void {
    this.supervisorSnapshot = snapshot;
    if (this.snapshot) {
      this.header.setText(this.headerText(this.snapshot));
      this.refreshRouteOverlay();
    }
    this.tui.requestRender();
  }

  setNotice(message: string): void {
    this.notice.setText(sanitizeTerminalText(message));
    this.tui.requestRender();
  }

  start(): void {
    this.tui.start();
  }

  stop(): void {
    this.tui.stop();
  }

  private headerText(snapshot: SessionViewSnapshot): string {
    const sessionCount = this.supervisorSnapshot?.sessions.length;
    const suffix = sessionCount ? ` | ${sessionCount} sessions` : "";
    const attempt = snapshot.connection.reconnectAttempt;
    return `sloppy ${snapshot.connection.status}${attempt ? ` (${attempt})` : ""}${suffix}`;
  }

  private async submit(text: string): Promise<void> {
    const localCommand = parseLocalCommand(text);
    const command =
      localCommand?.type === "unknown" && this.snapshot
        ? (parsePluginSlashCommand(text, this.snapshot) ?? localCommand)
        : localCommand;
    if (command) {
      await this.executeCommand(command);
      return;
    }
    const prepared = this.editor.prepareSubmission(text).trim();
    if (prepared) {
      await this.client.sendMessage(prepared);
    }
  }

  private async executeCommand(command: LocalCommand): Promise<void> {
    if (command.type === "quit") {
      this.client.disconnect();
      this.options.supervisor?.disconnect();
      this.stop();
      process.exit(0);
    }
    if (command.type === "clear") {
      this.editor.setText("");
      this.setNotice("Composer cleared.");
      return;
    }
    if (command.type === "help") {
      this.showRoute("help");
      return;
    }
    if (command.type === "verbosity") {
      this.setVerbosity(command.mode);
      return;
    }
    if (command.type === "approval_mode") {
      await this.setApprovalMode(command.mode);
      return;
    }
    if (command.type === "config_reload") {
      await this.reloadConfig(command.target);
      return;
    }
    if (command.type === "route") {
      this.showRoute(command.route);
      return;
    }
    if (command.type === "inspect_open") {
      this.showRoute("inspect");
      return;
    }
    if (command.type === "goal") {
      await this.executeGoalCommand(command);
      return;
    }
    if (command.type === "query") {
      await this.client.queryInspect(command.path, command.depth, command.targetId, {
        window: command.window,
        maxNodes: command.maxNodes,
      });
      this.showRoute("inspect");
      return;
    }
    if (command.type === "invoke" || command.type === "plugin_action") {
      await this.client.invokeInspect(
        command.path,
        command.action,
        command.params,
        command.type === "invoke" ? command.targetId : "session",
      );
      return;
    }
    if (command.type === "queue_cancel") {
      const target =
        typeof command.target === "number"
          ? this.snapshot?.queue.find((item) => item.position === command.target)?.id
          : command.target;
      if (target) {
        await this.client.cancelQueuedMessage(target);
      }
      return;
    }
    if (command.type === "session_switch") {
      await this.switchSession(command.sessionId);
      return;
    }
    if (command.type === "session_stop") {
      await this.options.supervisor?.stopSession(command.sessionId);
      return;
    }
    if (command.type === "session_new") {
      const session = await this.options.supervisor?.createSession(command);
      if (session) {
        await this.options.onSwitchSocket?.(this.endpointForSession(session));
      }
      return;
    }
    if (command.type === "runtime") {
      await this.executeRuntimeCommand(command);
      return;
    }
    if (command.type === "profile") {
      await this.client.saveProfile(command);
      return;
    }
    if (command.type === "profile_secret") {
      this.setNotice(
        "Masked profile-secret entry is deferred; use managed profile config for now.",
      );
      this.showRoute("setup");
      return;
    }
    if (command.type === "rejected" || command.type === "unknown") {
      this.setNotice(
        command.type === "rejected" ? command.reason : `Unknown command: ${command.name}`,
      );
    }
  }

  private async executeGoalCommand(
    command: Extract<LocalCommand, { type: "goal" }>,
  ): Promise<void> {
    if (command.action === "show") {
      this.showRoute("runtime");
      return;
    }
    if (command.action === "create" && command.objective) {
      await this.client.createGoal({
        objective: command.objective,
        tokenBudget: command.tokenBudget,
      });
    } else if (command.action === "pause") {
      await this.client.pauseGoal(command.message);
    } else if (command.action === "resume") {
      await this.client.resumeGoal(command.message);
    } else if (command.action === "complete") {
      await this.client.completeGoal(command.message);
    } else if (command.action === "clear") {
      await this.client.clearGoal();
    }
  }

  private async executeRuntimeCommand(
    command: Extract<LocalCommand, { type: "runtime" }>,
  ): Promise<void> {
    if (command.action === "refresh") {
      await this.client.queryInspect("/session", 1, "session-proxy:meta-runtime");
    } else if (command.action === "export") {
      await this.client.invokeInspect(
        "/session",
        "export_bundle",
        {},
        "session-proxy:meta-runtime",
      );
    } else if (command.proposalId) {
      const path = `/proposals/${command.proposalId}`;
      const action =
        command.action === "inspect" ? "inspect_proposal" : `${command.action}_proposal`;
      await this.client.invokeInspect(path, action, {}, "session-proxy:meta-runtime");
    }
    this.showRoute("runtime");
  }

  private async switchSession(sessionId: string): Promise<void> {
    const session = await this.options.supervisor?.switchSession(sessionId);
    if (session) {
      await this.options.onSwitchSocket?.(this.endpointForSession(session));
    }
  }

  private endpointForSession(session: { id: string; socketPath: string }): string {
    return endpointForSession(session, this.supervisorSnapshot?.connection.socketPath);
  }

  private showPalette(): void {
    if (!this.snapshot) {
      return;
    }
    this.hidePalette();
    const commands = buildCommandPaletteCommands(this.snapshot, this.supervisorSnapshot);
    const palette = new CommandPalette(
      this.tui,
      commands,
      (command: PaletteCommand) => {
        this.hidePalette();
        this.executeCommand(command.command).catch((error: unknown) => {
          this.setNotice(error instanceof Error ? error.message : String(error));
        });
      },
      () => this.hidePalette(),
    );
    this.paletteOverlay = this.tui.showOverlay(palette, {
      anchor: "bottom-center",
      width: "80%",
      maxHeight: "50%",
    });
  }

  private hidePalette(): void {
    this.paletteOverlay?.hide();
    this.paletteOverlay = null;
  }

  private showRoute(route: TuiRoute): void {
    this.route = route;
    this.refreshRouteOverlay();
  }

  private hideRoute(): void {
    this.routeOverlay?.hide();
    this.routeOverlay = null;
    this.routeOverlayComponent = null;
    this.route = "chat";
  }

  private cycleMode(): void {
    const modes: InteractionMode[] = ["default", "plan"];
    const next = modes[(modes.indexOf(this.mode) + 1) % modes.length] ?? "default";
    this.mode = next;
    this.editor.setModeLabel(this.mode);
    if (this.snapshot) {
      this.statusLine.update(this.snapshot, this.mode);
    }
  }

  private async setApprovalMode(mode: ApprovalMode | "show" | "toggle"): Promise<void> {
    const current = this.snapshot?.approvalMode ?? "normal";
    if (mode === "show") {
      this.setNotice(`Approval mode: ${current}`);
      return;
    }
    const next = mode === "toggle" ? (current === "auto" ? "normal" : "auto") : mode;
    await this.client.setApprovalMode(next);
    this.setNotice(`Approval mode: ${next}`);
    this.editor.setApprovalMode(next);
  }

  private async reloadConfig(target: "session" | "supervisor"): Promise<void> {
    if (target === "supervisor") {
      if (!this.options.supervisor) {
        this.setNotice("No supervisor is connected.");
        return;
      }
      await this.options.supervisor.reloadConfig();
      this.setNotice("Supervisor config reloaded.");
      return;
    }
    const result = await this.client.reloadConfig();
    if (result.status !== "ok") {
      return;
    }
    const data =
      result.data && typeof result.data === "object"
        ? (result.data as Record<string, unknown>)
        : {};
    this.setNotice(
      data.configRequiresRestart === true
        ? "Session config reloaded; restart required for runtime wiring changes."
        : "Session config reloaded.",
    );
  }

  private setVerbosity(mode: Verbosity | "show"): void {
    if (mode === "show") {
      this.setNotice(`Verbosity: ${this.verbosity}`);
      return;
    }
    this.verbosity = mode;
    if (this.snapshot) {
      this.chatLog.update(this.snapshot, {
        verbosity: this.verbosity,
        thinking: this.thinkingRenderMode(),
      });
    }
    this.setNotice(`Verbosity: ${this.verbosity}`);
  }

  private toggleThinkingOutput(): void {
    const current = this.thinkingExpandedOverride ?? this.defaultThinkingExpanded();
    this.thinkingExpandedOverride = !current;
    if (this.snapshot) {
      this.chatLog.update(this.snapshot, {
        verbosity: this.verbosity,
        thinking: this.thinkingRenderMode(),
      });
    }
    this.setNotice(
      this.thinkingExpandedOverride ? "Thinking output expanded." : "Thinking output collapsed.",
    );
  }

  private thinkingRenderMode(): "default" | "expanded" | "collapsed" {
    if (this.thinkingExpandedOverride === true) return "expanded";
    if (this.thinkingExpandedOverride === false) return "collapsed";
    return "default";
  }

  private defaultThinkingExpanded(): boolean {
    return (
      this.snapshot?.transcript.some((message) =>
        message.blocks.some((block) => block.type === "thinking" && block.display !== "hidden"),
      ) ?? false
    );
  }

  private refreshRouteOverlay(): void {
    if (!this.snapshot || this.route === "chat") {
      return;
    }
    const text = routeOverlayText(this.route, this.snapshot, this.supervisorSnapshot);
    if (this.routeOverlayComponent) {
      this.routeOverlayComponent.setText(text);
      return;
    }
    this.routeOverlayComponent = new RouteOverlay(text, 1, 1);
    this.routeOverlay = this.tui.showOverlay(this.routeOverlayComponent, {
      anchor: "bottom-center",
      width: "90%",
      maxHeight: "60%",
    });
  }
}
