import { type KeyEvent, TextAttributes, type TextareaRenderable } from "@opentui/core";
import { useKeyboard, useRenderer, useTerminalDimensions } from "@opentui/solid";
import {
  createEffect,
  createMemo,
  createSignal,
  For,
  Match,
  onCleanup,
  onMount,
  Show,
  Switch,
} from "solid-js";
import { createStore, reconcile } from "solid-js/store";
import { PendingApprovalPrompt } from "./components/approval-prompt";
import { CommandPalette } from "./components/command-palette";
import { FileSuggestions } from "./components/file-suggestions";
import { Footer } from "./components/footer";
import { HelpOverlay } from "./components/help-overlay";
import { type AgentMode, nextMode } from "./components/mode-chip";
import { type Notice, NoticeLine } from "./components/notice-line";
import { QueuePreview } from "./components/queue-preview";
import { RouteOverlay } from "./components/route-overlay";
import { type SecretProfileDraft, SecretPrompt } from "./components/secret-prompt";
import { SessionStrip } from "./components/session-strip";
import { SlashSuggestions } from "./components/slash-suggestions";
import { formatStateTreeLines } from "./components/state-tree";
import { StatusBar } from "./components/status-bar";
import {
  commandHelp,
  composerHint,
  errorMessage,
  firstPendingApproval,
  isControlKey,
} from "./lib/format";
import { copyToClipboard } from "./lib/osc52";
import { COLORS } from "./lib/theme";
import { ApprovalsRoute } from "./routes/approvals";
import { AppsRoute } from "./routes/apps";
import { ChatRoute } from "./routes/chat";
import { SetupRoute } from "./routes/setup";
import { TasksRoute } from "./routes/tasks";
import type { SessionClient } from "./slop/session-client";
import type { SessionSupervisorClient, SupervisorSnapshot } from "./slop/supervisor-client";
import type { AppItem, ApprovalItem, SessionViewSnapshot, TuiRoute } from "./slop/types";
import { buildCommandPaletteCommands, type PaletteCommand } from "./state/command-palette";
import { type LocalCommand, parseLocalCommand } from "./state/commands";
import { ComposerHistory } from "./state/composer-history";
import { detectAtMention, loadWorkspaceFiles, matchFileEntries } from "./state/file-catalog";
import { reconcileInitialRoute } from "./state/initial-route";
import { matchSlashEntries } from "./state/slash-catalog";
import { nextVerbosity, type Verbosity, verbosityLabel } from "./state/verbosity";

type AppProps = {
  client: SessionClient;
  supervisor?: SessionSupervisorClient;
  initialSnapshot: SessionViewSnapshot;
  initialSupervisorSnapshot?: SupervisorSnapshot;
  onExit: () => void;
};

export function App(props: AppProps) {
  const renderer = useRenderer();
  const dimensions = useTerminalDimensions();
  const [snapshotStore, setSnapshotStore] = createStore<SessionViewSnapshot>(props.initialSnapshot);
  const snapshot = () => snapshotStore;
  const setSnapshot = (next: SessionViewSnapshot): void => {
    setSnapshotStore(reconcile(next, { key: "id", merge: true }));
  };

  const [supervisorSnapshot, setSupervisorSnapshot] = createSignal<SupervisorSnapshot | null>(
    props.initialSupervisorSnapshot ?? null,
  );
  const [route, setRouteRaw] = createSignal<TuiRoute>(
    props.initialSnapshot.llm.status === "needs_credentials" ? "setup" : "chat",
  );
  let firstLlmStatusSeen = props.initialSnapshot.llm.status !== "unknown";
  let userNavigated = false;
  const setRoute = (next: TuiRoute) => {
    userNavigated = true;
    setRouteRaw(next);
  };
  const [inspectOpen, setInspectOpen] = createSignal(false);
  const [mode, setMode] = createSignal<AgentMode>("default");
  const [verbosity, setVerbosity] = createSignal<Verbosity>("normal");
  const [draft, setDraft] = createSignal("");
  const [notice, setNotice] = createSignal<Notice>({
    kind: "info",
    message: "Connected. Type /help for commands.",
  });
  const [mouseEnabled, setMouseEnabled] = createSignal(renderer.useMouse);
  const [secretProfile, setSecretProfile] = createSignal<SecretProfileDraft | null>(null);
  const [helpOpen, setHelpOpen] = createSignal(false);
  const [paletteOpen, setPaletteOpen] = createSignal(false);
  const [slashSelectedIndex, setSlashSelectedIndex] = createSignal(0);
  const history = new ComposerHistory();
  let composerRef: TextareaRenderable | undefined;

  const slashSuggestions = createMemo(() => {
    const text = draft();
    if (!text.startsWith("/") || text.includes("\n")) return [];
    // Only show suggestions while the user is still typing the command
    // name — once a space has been entered, fall back to argument mode.
    if (text.includes(" ")) return [];
    return matchSlashEntries(text);
  });

  createEffect(() => {
    const items = slashSuggestions();
    setSlashSelectedIndex((index) => (items.length === 0 ? 0 : Math.min(index, items.length - 1)));
  });

  function applySlashSuggestion(): boolean {
    const items = slashSuggestions();
    if (items.length === 0 || !composerRef) return false;
    const pick = items[Math.min(slashSelectedIndex(), items.length - 1)];
    if (!pick) return false;
    const next = `/${pick.insertion} `;
    composerRef.setText(next);
    composerRef.cursorOffset = next.length;
    setDraft(next);
    setSlashSelectedIndex(0);
    return true;
  }

  const [workspaceFiles, setWorkspaceFiles] = createSignal<readonly string[]>([]);
  const [fileSelectedIndex, setFileSelectedIndex] = createSignal(0);

  createEffect(() => {
    const root = snapshot().session.workspaceRoot ?? process.cwd();
    void loadWorkspaceFiles(root).then((files) => {
      setWorkspaceFiles(files);
    });
  });

  const atMention = createMemo(() => {
    if (slashSuggestions().length > 0) return null;
    return detectAtMention(draft());
  });

  const fileSuggestions = createMemo(() => {
    const mention = atMention();
    if (!mention) return [];
    return matchFileEntries(workspaceFiles(), mention.query);
  });

  createEffect(() => {
    const items = fileSuggestions();
    setFileSelectedIndex((index) => (items.length === 0 ? 0 : Math.min(index, items.length - 1)));
  });

  function applyFileSuggestion(): boolean {
    const items = fileSuggestions();
    const mention = atMention();
    if (items.length === 0 || !mention || !composerRef) return false;
    const pick = items[Math.min(fileSelectedIndex(), items.length - 1)];
    if (!pick) return false;
    const text = composerRef.plainText ?? draft();
    // mention.start points at the `@`; everything after it up to end-of-string is the partial query.
    const before = text.slice(0, mention.start);
    const next = `${before}@${pick.path} `;
    composerRef.setText(next);
    composerRef.cursorOffset = next.length;
    setDraft(next);
    setFileSelectedIndex(0);
    return true;
  }

  function pushNotice(next: Notice): void {
    setNotice(next.at ? next : { ...next, at: new Date().toISOString().slice(11, 19) });
  }

  const unsubscribe = props.client.on((event) => {
    if (event.type === "snapshot") {
      setSnapshot(event.snapshot);
      if (
        event.snapshot.connection.status === "connected" &&
        notice().kind === "error" &&
        notice().message === "Session client is not connected."
      ) {
        pushNotice({ kind: "info", message: "Connected. Type /help for commands." });
      }
      return;
    }

    if (event.type === "result") {
      pushNotice({
        kind: event.result.status === "error" ? "error" : "ok",
        message:
          event.result.status === "error"
            ? (event.result.error?.message ?? "Action failed.")
            : `Action ${event.result.status}.`,
      });
      return;
    }

    pushNotice({ kind: "error", message: event.message });
  });
  const unsubscribeSupervisor = props.supervisor?.on((event) => {
    if (event.type === "snapshot") {
      setSupervisorSnapshot(event.snapshot);
      return;
    }
    if (event.type === "result") {
      if (event.result.status === "error") {
        pushNotice({
          kind: "error",
          message: event.result.error?.message ?? "Supervisor action failed.",
        });
      }
      return;
    }
    pushNotice({ kind: "error", message: event.message });
  });

  onCleanup(() => {
    unsubscribe();
    unsubscribeSupervisor?.();
  });

  onMount(() => {
    if (composerRef) {
      renderer.focusRenderable(composerRef);
    }
  });

  onMount(() => {
    const onSelection = (selection: { getSelectedText(): string } | null): void => {
      const text = selection?.getSelectedText() ?? "";
      if (!text) return;
      copyToClipboard(renderer, text);
    };
    renderer.on("selection", onSelection);
    onCleanup(() => {
      renderer.off("selection", onSelection);
    });
  });

  // setTerminalTitle writes an ANSI OSC sequence; many terminals repaint
  // the window on every title change. Coalesce to actual title transitions.
  const terminalTitle = createMemo(() => {
    const current = snapshot();
    const model =
      [
        current.llm.selectedProvider ?? current.session.modelProvider,
        current.llm.selectedModel ?? current.session.model,
      ]
        .filter(Boolean)
        .join("/") || "no model";
    return `Sloppy · ${route()} · ${current.turn.state} · ${model}`;
  });
  createEffect(() => {
    renderer.setTerminalTitle(terminalTitle());
  });

  createEffect(() => {
    const status = snapshot().llm.status;
    const decision = reconcileInitialRoute({
      currentRoute: route(),
      llmStatus: status,
      firstStatusSeen: firstLlmStatusSeen,
      userNavigated,
    });
    firstLlmStatusSeen = decision.firstStatusSeen;
    if (decision.route !== route()) {
      setRouteRaw(decision.route);
    }
  });

  useKeyboard((key) => {
    if (secretProfile() || paletteOpen()) {
      return;
    }
    const pending = pendingApproval();
    if (pending) {
      key.preventDefault();
      key.stopPropagation();
      handlePendingApprovalKey(key, pending);
      return;
    }

    if (handleControlKey(key)) {
      return;
    }

    if (key.name === "tab" && key.shift) {
      cycleMode();
      return;
    }

    if (key.name === "escape") {
      if (helpOpen()) {
        setHelpOpen(false);
        return;
      }
      if (inspectOpen()) {
        setInspectOpen(false);
        return;
      }
      if (route() !== "chat") {
        setRoute("chat");
      }
    }
  });

  function cycleMode(): void {
    const next = nextMode(mode());
    setMode(next);
    pushNotice({
      kind: next === "default" ? "info" : "warn",
      message:
        next === "plan"
          ? "Mode: PLAN — proposals queued."
          : next === "auto-approve"
            ? "Mode: AUTO — pending approvals will be auto-approved (non-dangerous only)."
            : "Mode: DEFAULT — manual approval required.",
    });
  }

  function handleControlKey(key: KeyEvent): boolean {
    const isCtrlC = isControlKey(key, "c", 3);
    const isCtrlD = isControlKey(key, "d", 4);
    const isCtrlK = isControlKey(key, "k", 11);
    if (!isCtrlC && !isCtrlD && !isCtrlK) {
      return false;
    }

    key.preventDefault();
    key.stopPropagation();

    if (isCtrlK) {
      setPaletteOpen(true);
      return true;
    }

    if (isCtrlC) {
      const current = snapshot();
      if (current.turn.canCancel) {
        void props.client.cancelTurn();
        pushNotice({ kind: "warn", message: "Cancelling active turn." });
        return true;
      }

      if (draft().trim()) {
        clearComposer();
        pushNotice({ kind: "info", message: "Draft cleared." });
        return true;
      }
    }

    props.onExit();
    return true;
  }

  function handlePendingApprovalKey(key: KeyEvent, approval: ApprovalItem): void {
    if (key.ctrl && key.name === "c") {
      if (snapshot().turn.canCancel) {
        void props.client.cancelTurn();
        pushNotice({ kind: "warn", message: "Cancelling active turn." });
      }
      return;
    }

    if (key.name === "o" || key.name === "a") {
      if (approval.dangerous && !key.shift) {
        pushNotice({
          kind: "warn",
          message: `${approval.provider}.${approval.action} is marked dangerous — hold Shift to confirm.`,
        });
        return;
      }
      void props.client.approveApproval(approval.id);
      pushNotice({ kind: "ok", message: `Approved ${approval.provider}.${approval.action}.` });
      return;
    }

    if (key.name === "d" || key.name === "escape") {
      void props.client.rejectApproval(approval.id, "Rejected from TUI.");
      pushNotice({ kind: "warn", message: `Rejected ${approval.provider}.${approval.action}.` });
    }
  }

  const queuedItems = createMemo(() => snapshot().queue);
  const paletteCommands = createMemo(() =>
    buildCommandPaletteCommands(snapshot(), mouseEnabled(), supervisorSnapshot() ?? undefined),
  );
  const supervisorSessions = createMemo(() => supervisorSnapshot()?.sessions ?? []);
  const showSessionStrip = createMemo(() => supervisorSessions().length > 1);
  const pendingApproval = createMemo(() => firstPendingApproval(snapshot()));
  const inspectLines = createMemo(() => formatStateTreeLines(snapshot().inspect.tree));

  createEffect(() => {
    if (pendingApproval() && paletteOpen()) {
      setPaletteOpen(false);
    }
  });

  createEffect(() => {
    if (!pendingApproval() && !secretProfile() && composerRef) {
      renderer.focusRenderable(composerRef);
    }
  });

  async function submitDraft(): Promise<void> {
    const text = composerRef?.plainText ?? draft();
    const command = parseLocalCommand(text);
    clearComposer();

    if (command) {
      if (command.type === "unknown") {
        history.push(text);
        await sendText(text);
        return;
      }
      const skipHistory =
        command.type === "profile_secret" ||
        command.type === "profile" ||
        command.type === "rejected";
      if (!skipHistory) {
        history.push(text);
      }
      await runLocalCommand(command);
      return;
    }

    history.push(text);
    await sendText(text);
  }

  async function sendText(text: string): Promise<void> {
    const trimmed = text.trim();
    if (!trimmed) {
      return;
    }

    const current = snapshot();
    if (!current.composer.canSend) {
      pushNotice({
        kind: "warn",
        message: current.composer.disabledReason ?? "Composer is disabled.",
      });
      return;
    }

    const willQueue = current.turn.state === "running" || current.turn.state === "waiting_approval";

    try {
      await props.client.sendMessage(trimmed);
      pushNotice({
        kind: willQueue ? "info" : "ok",
        message: willQueue ? "Turn busy — message queued." : "Message sent.",
      });
    } catch (error) {
      pushNotice({ kind: "error", message: errorMessage(error) });
    }
  }

  function setMouseMode(enabled: boolean): void {
    renderer.useMouse = enabled;
    setMouseEnabled(renderer.useMouse);
    pushNotice({
      kind: enabled ? "warn" : "ok",
      message: enabled
        ? "Mouse mode enabled; drag selects inside the TUI."
        : "Mouse mode disabled; terminal text selection works normally.",
    });
  }

  async function runLocalCommand(command: LocalCommand): Promise<void> {
    try {
      switch (command.type) {
        case "route":
          setRoute(command.route);
          pushNotice({ kind: "info", message: `Opened ${command.route}.` });
          return;
        case "inspect_open":
          setInspectOpen(true);
          pushNotice({ kind: "info", message: "Inspector open. Use /query to load a tree." });
          return;
        case "help":
          setHelpOpen(true);
          pushNotice({ kind: "info", message: commandHelp() });
          return;
        case "clear":
          pushNotice({
            kind: "info",
            message:
              "Submitted-message queue is owned by the runtime — cancel items with /queue-cancel <id|position>.",
          });
          return;
        case "queue_cancel": {
          const items = snapshot().queue;
          const target =
            typeof command.target === "number"
              ? items[command.target - 1]
              : items.find((item) => item.id === command.target);
          if (!target) {
            pushNotice({
              kind: "warn",
              message:
                typeof command.target === "number"
                  ? `No queued message at position ${command.target}.`
                  : `No queued message with id ${command.target}.`,
            });
            return;
          }
          await props.client.cancelQueuedMessage(target.id);
          pushNotice({
            kind: "ok",
            message: `Cancelled queued message at position ${target.position}.`,
          });
          return;
        }
        case "session_new":
          await createSupervisorSession(command);
          return;
        case "session_switch":
          await switchSupervisorSession(command.sessionId);
          return;
        case "session_stop":
          await stopSupervisorSession(command.sessionId);
          return;
        case "verbosity": {
          const next = command.mode === "cycle" ? nextVerbosity(verbosity()) : command.mode;
          setVerbosity(next);
          pushNotice({ kind: "info", message: `Verbosity: ${verbosityLabel(next)}` });
          return;
        }
        case "mouse":
          setMouseMode(command.mode === "toggle" ? !mouseEnabled() : command.mode === "on");
          return;
        case "goal":
          await runGoalCommand(command);
          return;
        case "runtime":
          await runRuntimeCommand(command);
          return;
        case "quit":
          props.onExit();
          return;
        case "query":
          await props.client.queryInspect(command.path, command.depth, command.targetId, {
            window: command.window,
            maxNodes: command.maxNodes,
          });
          setInspectOpen(true);
          pushNotice({
            kind: "ok",
            message: `Queried ${command.targetId}:${command.path} depth ${command.depth}.`,
          });
          return;
        case "invoke":
          await props.client.invokeInspect(
            command.path,
            command.action,
            command.params,
            command.targetId,
          );
          setInspectOpen(true);
          pushNotice({
            kind: "ok",
            message: `Invoked ${command.action} at ${command.targetId}:${command.path}.`,
          });
          return;
        case "profile":
          await props.client.saveProfile(command);
          pushNotice({ kind: "ok", message: `Saved ${command.provider} profile.` });
          return;
        case "profile_secret":
          setSecretProfile({
            profileId: command.profileId,
            label: command.label,
            provider: command.provider,
            model: command.model,
            reasoningEffort: command.reasoningEffort,
            adapterId: command.adapterId,
            baseUrl: command.baseUrl,
            makeDefault: command.makeDefault,
          });
          setRoute("setup");
          pushNotice({ kind: "info", message: "Enter API key. Input is masked." });
          return;
        case "rejected":
          pushNotice({ kind: "warn", message: command.reason });
          return;
        case "unknown":
          return;
      }
    } catch (error) {
      pushNotice({ kind: "error", message: errorMessage(error) });
    }
  }

  async function runRuntimeCommand(
    command: Extract<LocalCommand, { type: "runtime" }>,
  ): Promise<void> {
    const targetId = "session-proxy:meta-runtime";
    switch (command.action) {
      case "refresh":
        await props.client.queryInspect("/proposals", 2, targetId);
        setInspectOpen(true);
        setRoute("runtime");
        pushNotice({ kind: "ok", message: "Runtime proposals refreshed." });
        return;
      case "export":
        await props.client.invokeInspect(
          "/session",
          "export_bundle",
          {
            include_skills: true,
          },
          targetId,
        );
        setInspectOpen(true);
        setRoute("runtime");
        pushNotice({ kind: "ok", message: "Runtime bundle exported to inspector result." });
        return;
      case "inspect": {
        const path = command.proposalId ? `/proposals/${command.proposalId}` : "/proposals";
        await props.client.queryInspect(path, command.proposalId ? 2 : 3, targetId);
        setInspectOpen(true);
        setRoute("runtime");
        pushNotice({ kind: "ok", message: `Runtime state loaded from ${path}.` });
        return;
      }
      case "apply":
      case "revert": {
        const proposalId = command.proposalId;
        if (!proposalId) {
          pushNotice({
            kind: "warn",
            message: `/runtime ${command.action} requires a proposal id.`,
          });
          return;
        }
        await props.client.invokeInspect(
          `/proposals/${proposalId}`,
          command.action === "apply" ? "apply_proposal" : "revert_proposal",
          undefined,
          targetId,
        );
        setInspectOpen(true);
        setRoute("runtime");
        pushNotice({ kind: "ok", message: `Runtime proposal ${command.action} requested.` });
        return;
      }
    }
  }

  async function runGoalCommand(command: Extract<LocalCommand, { type: "goal" }>): Promise<void> {
    switch (command.action) {
      case "show": {
        const goal = snapshot().goal;
        pushNotice({
          kind: goal.exists ? "info" : "warn",
          message: goal.exists
            ? `Goal ${goal.status}: ${goal.objective ?? "(empty)"} · tokens=${goal.totalTokens}${goal.tokenBudget ? `/${goal.tokenBudget}` : ""}`
            : "No active goal. Use /goal <objective> to start one.",
        });
        return;
      }
      case "create":
        await props.client.createGoal({
          objective: command.objective ?? "",
          tokenBudget: command.tokenBudget,
        });
        pushNotice({ kind: "ok", message: "Goal started." });
        return;
      case "pause":
        await props.client.pauseGoal(command.message);
        pushNotice({ kind: "warn", message: "Goal paused." });
        return;
      case "resume":
        await props.client.resumeGoal(command.message);
        pushNotice({ kind: "ok", message: "Goal resumed." });
        return;
      case "complete":
        await props.client.completeGoal(command.message);
        pushNotice({ kind: "ok", message: "Goal marked complete." });
        return;
      case "clear":
        await props.client.clearGoal();
        pushNotice({ kind: "warn", message: "Goal cleared." });
    }
  }

  async function createSupervisorSession(
    command: Extract<LocalCommand, { type: "session_new" }>,
  ): Promise<void> {
    if (!props.supervisor) {
      pushNotice({ kind: "warn", message: "No session supervisor is attached." });
      return;
    }
    const session = await props.supervisor.createSession({
      workspaceId: command.workspaceId,
      projectId: command.projectId,
      title: command.title,
      sessionId: command.sessionId,
    });
    await props.client.switchSocket(session.socketPath);
    pushNotice({ kind: "ok", message: `Switched to ${session.title ?? session.id}.` });
  }

  async function switchSupervisorSession(sessionId: string): Promise<void> {
    if (!props.supervisor) {
      pushNotice({ kind: "warn", message: "No session supervisor is attached." });
      return;
    }
    const fallback = supervisorSnapshot()?.sessions.find((session) => session.id === sessionId);
    const session = await props.supervisor.switchSession(sessionId);
    const socketPath = session.socketPath || fallback?.socketPath;
    if (!socketPath) {
      pushNotice({ kind: "error", message: `Session ${sessionId} did not return a socket path.` });
      return;
    }
    await props.client.switchSocket(socketPath);
    pushNotice({
      kind: "ok",
      message: `Switched to ${session.title ?? fallback?.title ?? sessionId}.`,
    });
  }

  async function stopSupervisorSession(sessionId: string): Promise<void> {
    if (!props.supervisor) {
      pushNotice({ kind: "warn", message: "No session supervisor is attached." });
      return;
    }
    const currentSocket = snapshot().connection.socketPath;
    const sessions = supervisorSnapshot()?.sessions ?? [];
    const stopped = sessions.find((session) => session.id === sessionId);
    const next = sessions.find((session) => session.id !== sessionId);
    await props.supervisor.stopSession(sessionId);
    if (stopped?.socketPath === currentSocket && next) {
      await props.supervisor.switchSession(next.id);
      await props.client.switchSocket(next.socketPath);
      pushNotice({
        kind: "warn",
        message: `Stopped current session. Switched to ${next.title ?? next.id}.`,
      });
      return;
    }
    pushNotice({ kind: "warn", message: `Stopped session ${stopped?.title ?? sessionId}.` });
  }

  async function runPaletteCommand(entry: PaletteCommand): Promise<void> {
    setPaletteOpen(false);
    await runLocalCommand(entry.command);
    if (composerRef) {
      renderer.focusRenderable(composerRef);
    }
  }

  function clearComposer(): void {
    composerRef?.clear();
    setDraft("");
  }

  async function saveSecretProfile(apiKey: string): Promise<void> {
    const profile = secretProfile();
    if (!profile) {
      return;
    }

    setSecretProfile(null);
    try {
      await props.client.saveProfile({
        ...profile,
        apiKey,
      });
      pushNotice({ kind: "ok", message: `Saved ${profile.provider} credentials.` });
      if (composerRef) {
        renderer.focusRenderable(composerRef);
      }
    } catch (error) {
      pushNotice({ kind: "error", message: errorMessage(error) });
    }
  }

  async function inspectApp(app: AppItem): Promise<void> {
    try {
      await props.client.queryInspect("/", 2, app.id);
      setInspectOpen(true);
      pushNotice({ kind: "ok", message: `Inspecting ${app.name}.` });
    } catch (error) {
      pushNotice({ kind: "error", message: errorMessage(error) });
    }
  }

  function copyInspectLine(text: string): void {
    const result = copyToClipboard(renderer, text.trimStart());
    if (result === "copied") {
      pushNotice({ kind: "ok", message: `Yanked: ${text.slice(0, 40)}` });
    } else if (result === "unsupported") {
      pushNotice({ kind: "warn", message: "Clipboard unsupported in this terminal." });
    } else {
      pushNotice({ kind: "error", message: "Yank failed." });
    }
  }

  return (
    <box
      width={dimensions().width}
      height={dimensions().height}
      flexDirection="column"
      backgroundColor={COLORS.base}
    >
      <Show when={showSessionStrip()}>
        <SessionStrip sessions={supervisorSessions()} />
      </Show>
      <StatusBar
        snapshot={snapshot()}
        mouseEnabled={mouseEnabled()}
        mode={mode()}
        verbosity={verbosity()}
      />
      <box flexGrow={1} flexDirection="column">
        <ChatRoute snapshot={snapshot()} verbosity={verbosity()} />
      </box>
      <Show when={route() !== "chat"}>
        <RouteOverlay title={routeLabel(route())}>
          <NonChatRouteView
            route={route()}
            snapshot={snapshot()}
            composerDraft={draft()}
            onApprove={(id) => void props.client.approveApproval(id)}
            onReject={(id) => void props.client.rejectApproval(id, "Rejected from TUI.")}
            onCancelTask={(id) => void props.client.cancelTask(id)}
            onSetDefaultProfile={(id) => void props.client.setDefaultProfile(id)}
            onDeleteProfile={(id) => void props.client.deleteProfile(id)}
            onDeleteApiKey={(id) => void props.client.deleteApiKey(id)}
            onInspectApp={(app) => void inspectApp(app)}
            onDangerousNeedsConfirm={(approval) =>
              pushNotice({
                kind: "warn",
                message: `${approval.provider}.${approval.action} is marked dangerous — press Shift+A to confirm.`,
              })
            }
          />
        </RouteOverlay>
      </Show>
      <Show when={inspectOpen()}>
        <InspectOverlay
          snapshot={snapshot()}
          composerDraft={draft()}
          onCopyLine={copyInspectLine}
          lines={inspectLines()}
        />
      </Show>
      <Show when={pendingApproval()}>
        {(approval) => <PendingApprovalPrompt approval={approval()} />}
      </Show>
      <QueuePreview items={queuedItems()} />
      <SlashSuggestions
        suggestions={slashSuggestions()}
        selectedIndex={slashSelectedIndex()}
        query={draft().startsWith("/") ? draft().slice(1).split(/\s+/, 1)[0] ?? "" : ""}
      />
      <FileSuggestions
        suggestions={fileSuggestions()}
        selectedIndex={fileSelectedIndex()}
        query={atMention()?.query ?? ""}
      />
      <NoticeLine notice={notice()} />
      <box height={5} flexDirection="column" paddingX={1} backgroundColor={COLORS.panelHigh}>
        <text fg={COLORS.dim} content={composerHint(snapshot(), queuedItems().length)} />
        <textarea
          ref={composerRef}
          height={3}
          wrapMode="word"
          focused={!pendingApproval() && !secretProfile()}
          placeholder={
            snapshot().composer.canSend
              ? "Message Sloppy, or type /help"
              : (snapshot().composer.disabledReason ?? "Composer disabled")
          }
          textColor={snapshot().composer.canSend ? COLORS.text : COLORS.dim}
          backgroundColor={COLORS.panelHigh}
          focusedBackgroundColor={COLORS.panelHigh}
          cursorColor={COLORS.green}
          keyBindings={[
            { name: "return", action: "submit" },
            { name: "linefeed", action: "submit" },
            { name: "return", meta: true, action: "newline" },
            { name: "return", shift: true, action: "newline" },
          ]}
          onContentChange={() => {
            setDraft(composerRef?.plainText ?? "");
            history.reset();
          }}
          onKeyPress={(key) => {
            handleControlKey(key);
          }}
          onKeyDown={(key) => {
            if (fileSuggestions().length > 0) {
              if (key.name === "up") {
                setFileSelectedIndex((i) => Math.max(0, i - 1));
                key.preventDefault();
                key.stopPropagation();
                return;
              }
              if (key.name === "down") {
                setFileSelectedIndex((i) => Math.min(fileSuggestions().length - 1, i + 1));
                key.preventDefault();
                key.stopPropagation();
                return;
              }
              if (key.name === "tab" && !key.shift) {
                if (applyFileSuggestion()) {
                  key.preventDefault();
                  key.stopPropagation();
                }
                return;
              }
              if (key.name === "escape") {
                setFileSelectedIndex(0);
              }
            }
            if (slashSuggestions().length > 0) {
              if (key.name === "up") {
                setSlashSelectedIndex((i) => Math.max(0, i - 1));
                key.preventDefault();
                key.stopPropagation();
                return;
              }
              if (key.name === "down") {
                setSlashSelectedIndex((i) => Math.min(slashSuggestions().length - 1, i + 1));
                key.preventDefault();
                key.stopPropagation();
                return;
              }
              if (key.name === "tab" && !key.shift) {
                if (applySlashSuggestion()) {
                  key.preventDefault();
                  key.stopPropagation();
                }
                return;
              }
              if (key.name === "escape") {
                setSlashSelectedIndex(0);
              }
            }
            if ((key.name === "up" || key.name === "down") && draft().length === 0) {
              const next = key.name === "up" ? history.previous() : history.next();
              if (next !== null && composerRef) {
                composerRef.setText(next);
                composerRef.cursorOffset = next.length;
                setDraft(next);
                key.preventDefault();
                key.stopPropagation();
              }
            }
          }}
          onSubmit={() => void submitDraft()}
        />
      </box>
      <Footer mouseEnabled={mouseEnabled()} />
      <Show when={helpOpen()}>
        <HelpOverlay onClose={() => setHelpOpen(false)} />
      </Show>
      <Show when={paletteOpen()}>
        <CommandPalette
          entries={paletteCommands()}
          onRun={(entry) => void runPaletteCommand(entry)}
          onClose={() => {
            setPaletteOpen(false);
            if (composerRef) {
              renderer.focusRenderable(composerRef);
            }
          }}
        />
      </Show>
      <Show when={secretProfile()}>
        {(profile) => (
          <SecretPrompt
            profile={profile()}
            onSubmit={(apiKey) => void saveSecretProfile(apiKey)}
            onCancel={() => {
              setSecretProfile(null);
              pushNotice({ kind: "info", message: "Secret entry cancelled." });
              if (composerRef) {
                renderer.focusRenderable(composerRef);
              }
            }}
          />
        )}
      </Show>
    </box>
  );
}

const ROUTE_LABELS: Record<TuiRoute, string> = {
  chat: "Chat",
  setup: "Setup",
  approvals: "Approvals",
  tasks: "Tasks",
  apps: "Apps",
  inspect: "Inspect",
  runtime: "Runtime",
  settings: "Settings",
};

function routeLabel(route: TuiRoute): string {
  return ROUTE_LABELS[route] ?? route;
}

function NonChatRouteView(props: {
  route: TuiRoute;
  snapshot: SessionViewSnapshot;
  composerDraft: string;
  onApprove: (id: string) => void;
  onReject: (id: string) => void;
  onCancelTask: (id: string) => void;
  onSetDefaultProfile: (id: string) => void;
  onDeleteProfile: (id: string) => void;
  onDeleteApiKey: (id: string) => void;
  onInspectApp: (app: AppItem) => void;
  onDangerousNeedsConfirm: (approval: ApprovalItem) => void;
}) {
  return (
    <Switch fallback={null}>
      <Match when={props.route === "setup"}>
        <SetupRoute
          snapshot={props.snapshot}
          composerDraft={props.composerDraft}
          onSetDefaultProfile={props.onSetDefaultProfile}
          onDeleteProfile={props.onDeleteProfile}
          onDeleteApiKey={props.onDeleteApiKey}
        />
      </Match>
      <Match when={props.route === "approvals"}>
        <ApprovalsRoute
          approvals={props.snapshot.approvals}
          composerDraft={props.composerDraft}
          onApprove={props.onApprove}
          onReject={props.onReject}
          onDangerousNeedsConfirm={props.onDangerousNeedsConfirm}
        />
      </Match>
      <Match when={props.route === "tasks"}>
        <TasksRoute
          tasks={props.snapshot.tasks}
          composerDraft={props.composerDraft}
          onCancelTask={props.onCancelTask}
        />
      </Match>
      <Match when={props.route === "apps"}>
        <AppsRoute
          apps={props.snapshot.apps}
          composerDraft={props.composerDraft}
          onInspectApp={props.onInspectApp}
        />
      </Match>
      <Match when={props.route === "runtime"}>
        <RuntimeRoute snapshot={props.snapshot} />
      </Match>
    </Switch>
  );
}

function RuntimeRoute(props: { snapshot: SessionViewSnapshot }) {
  const metaRuntime = () =>
    props.snapshot.apps.find(
      (app) => app.id === "session-proxy:meta-runtime" || app.providerId === "meta-runtime",
    );
  return (
    <box flexGrow={1} flexDirection="column" paddingX={1} paddingY={1}>
      <text fg={COLORS.cyan} attributes={TextAttributes.BOLD} content="Runtime" />
      <text
        fg={COLORS.text}
        wrapMode="word"
        content="Meta-runtime proposals and bundles are accessed through the public /apps provider proxy."
      />
      <Show
        when={metaRuntime()}
        fallback={<text fg={COLORS.yellow} content="meta-runtime app not visible" />}
      >
        {(app) => (
          <box flexDirection="column" marginTop={1}>
            <text fg={COLORS.green} content={`meta-runtime ${app().status} · ${app().transport}`} />
            <text fg={COLORS.dim} content="/runtime refresh · /runtime inspect [proposal-id]" />
            <text
              fg={COLORS.dim}
              content="/runtime apply <proposal-id> · /runtime revert <proposal-id>"
            />
            <text fg={COLORS.dim} content="/runtime export" />
          </box>
        )}
      </Show>
    </box>
  );
}

function InspectOverlay(props: {
  snapshot: SessionViewSnapshot;
  composerDraft: string;
  lines: string[];
  onCopyLine: (text: string) => void;
}) {
  const [selectedIndex, setSelectedIndex] = createSignal(0);
  const inspect = () => props.snapshot.inspect;

  useKeyboard((key) => {
    if (props.composerDraft.trim().length > 0) {
      return;
    }
    const items = props.lines;
    if (items.length === 0) {
      return;
    }
    if (key.name === "up") {
      setSelectedIndex((i) => Math.max(0, i - 1));
      return;
    }
    if (key.name === "down") {
      setSelectedIndex((i) => Math.min(items.length - 1, i + 1));
      return;
    }
    if (key.name === "y") {
      const text = items[Math.min(selectedIndex(), items.length - 1)];
      if (text) {
        props.onCopyLine(text);
      }
    }
  });

  return (
    <box
      position="absolute"
      top={2}
      left={2}
      right={2}
      bottom={6}
      flexDirection="column"
      backgroundColor={COLORS.panel}
      border
      borderColor={COLORS.cyan}
      padding={1}
      zIndex={16}
    >
      <text
        fg={COLORS.cyan}
        attributes={TextAttributes.BOLD}
        content="SLOP Inspector  (Esc closes · ↑/↓ select · y yanks · /query path depth · /invoke path action {json})"
      />
      <text
        fg={COLORS.dim}
        content={`target=${inspect().targetId} (${inspect().targetName}) path=${inspect().path} depth=${inspect().depth}`}
      />
      <Show when={inspect().error}>
        <text fg={COLORS.red} content={inspect().error} />
      </Show>
      <For each={props.lines}>
        {(line, index) => {
          const isSelected = () => index() === selectedIndex();
          return (
            <text
              fg={isSelected() ? COLORS.green : line.startsWith("/") ? COLORS.cyan : COLORS.text}
              bg={isSelected() ? COLORS.panelHigh : COLORS.panel}
              content={`${isSelected() ? "▸ " : "  "}${line}`}
            />
          );
        }}
      </For>
      <Show when={inspect().result}>
        {(result) => (
          <text
            fg={result().status === "error" ? COLORS.red : COLORS.green}
            content={`result: ${result().status}`}
          />
        )}
      </Show>
    </box>
  );
}
