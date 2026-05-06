import type { KeyEvent, TextareaRenderable } from "@opentui/core";
import { useKeyboard, useRenderer, useTerminalDimensions } from "@opentui/solid";
import {
  createEffect,
  createMemo,
  createSignal,
  Match,
  onCleanup,
  onMount,
  Show,
  Switch,
} from "solid-js";
import { CompactInspector, InspectorPanel } from "./components/activity-lane";
import { PendingApprovalPrompt } from "./components/approval-prompt";
import { Footer } from "./components/footer";
import { HelpOverlay } from "./components/help-overlay";
import { type Notice, NoticeLine } from "./components/notice-line";
import { QueuePreview } from "./components/queue-preview";
import { type SecretProfileDraft, SecretPrompt } from "./components/secret-prompt";
import { formatStateTreeLines } from "./components/state-tree";
import { StatusBar } from "./components/status-bar";
import { TabStrip } from "./components/tab-strip";
import {
  commandHelp,
  composerHint,
  errorMessage,
  firstPendingApproval,
  formatActivityLine,
  formatAppLine,
  formatApprovalLine,
  formatTaskLine,
  isControlKey,
} from "./lib/format";
import { COLORS } from "./lib/theme";
import { ApprovalsRoute } from "./routes/approvals";
import { AppsRoute } from "./routes/apps";
import { ChatRoute } from "./routes/chat";
import { InspectRoute } from "./routes/inspect";
import { SettingsRoute } from "./routes/settings";
import { SetupRoute } from "./routes/setup";
import { TasksRoute } from "./routes/tasks";
import type { SessionClient } from "./slop/session-client";
import type {
  AppItem,
  ApprovalItem,
  InspectorMode,
  SessionViewSnapshot,
  TuiRoute,
} from "./slop/types";
import { type LocalCommand, parseLocalCommand } from "./state/commands";
import { ComposerHistory } from "./state/composer-history";
import { reconcileInitialRoute } from "./state/initial-route";

type AppProps = {
  client: SessionClient;
  initialSnapshot: SessionViewSnapshot;
  onExit: () => void;
};

export function App(props: AppProps) {
  const renderer = useRenderer();
  const dimensions = useTerminalDimensions();
  const [snapshot, setSnapshot] = createSignal(props.initialSnapshot);
  const [route, setRouteRaw] = createSignal<TuiRoute>(
    props.initialSnapshot.llm.status === "needs_credentials" ? "setup" : "chat",
  );
  let firstLlmStatusSeen = props.initialSnapshot.llm.status !== "unknown";
  let userNavigated = false;
  const setRoute = (next: TuiRoute) => {
    userNavigated = true;
    setRouteRaw(next);
  };
  const [inspectorMode, setInspectorMode] = createSignal<InspectorMode>("activity");
  const [draft, setDraft] = createSignal("");
  const [notice, setNotice] = createSignal<Notice>({
    kind: "info",
    message: "Connected. Type /help for commands.",
  });
  const [mouseEnabled, setMouseEnabled] = createSignal(renderer.useMouse);
  const [secretProfile, setSecretProfile] = createSignal<SecretProfileDraft | null>(null);
  const [noticeHistory, setNoticeHistory] = createSignal<Notice[]>([]);
  const [noticeExpanded, setNoticeExpanded] = createSignal(false);
  const [helpOpen, setHelpOpen] = createSignal(false);
  const history = new ComposerHistory();
  let composerRef: TextareaRenderable | undefined;

  function pushNotice(next: Notice): void {
    const stamped = next.at ? next : { ...next, at: new Date().toISOString().slice(11, 19) };
    setNotice(stamped);
    setNoticeHistory((current) => {
      const trimmed = [...current, stamped];
      return trimmed.length > 100 ? trimmed.slice(trimmed.length - 100) : trimmed;
    });
    if (stamped.kind === "error") {
      setNoticeExpanded(true);
    }
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

  onCleanup(() => {
    unsubscribe();
    // Lifecycle owned by index.tsx (cleanupSession); the App only consumes events.
  });

  onMount(() => {
    if (composerRef) {
      renderer.focusRenderable(composerRef);
    }
  });

  createEffect(() => {
    const current = snapshot();
    const model =
      [
        current.llm.selectedProvider ?? current.session.modelProvider,
        current.llm.selectedModel ?? current.session.model,
      ]
        .filter(Boolean)
        .join("/") || "no model";
    renderer.setTerminalTitle(`Sloppy · ${route()} · ${current.turn.state} · ${model}`);
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
    if (secretProfile()) {
      return;
    }
    // Single owner for pending-approval input. Stop every key (so the composer
    // textarea and route handlers can't see them) and dispatch approve / reject /
    // cancel-turn here. Splitting this across handlers risks one stopping the
    // other once propagationStopped is set.
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

    if (key.name === "f1") {
      setHelpOpen((open) => !open);
      return;
    }

    if (key.sequence === "?") {
      setNoticeExpanded((expanded) => !expanded);
      return;
    }

    if (key.name === "f2") {
      setRoute("setup");
      return;
    }

    if (key.name === "f3") {
      setRoute("approvals");
      return;
    }

    if (key.name === "f4") {
      setRoute("tasks");
      return;
    }

    if (key.name === "f5") {
      setRoute("apps");
      return;
    }

    if (key.name === "f6") {
      setRoute("inspect");
      return;
    }

    if (key.name === "f7") {
      toggleMouseMode();
      return;
    }
  });

  function handleControlKey(key: KeyEvent): boolean {
    const isCtrlC = isControlKey(key, "c", 3);
    const isCtrlD = isControlKey(key, "d", 4);
    if (!isCtrlC && !isCtrlD) {
      return false;
    }

    key.preventDefault();
    key.stopPropagation();

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
      return;
    }
  }

  const queuedItems = createMemo(() => snapshot().queue);

  const isWide = createMemo(() => dimensions().width >= 118);
  const activeInspectorItems = createMemo(() => {
    const current = snapshot();
    switch (inspectorMode()) {
      case "approvals":
        return current.approvals.map(formatApprovalLine);
      case "tasks":
        return current.tasks.map(formatTaskLine);
      case "apps":
        return current.apps.map(formatAppLine);
      case "state":
        return formatStateTreeLines(current.inspect.tree);
      default:
        return current.activity.slice(-12).map(formatActivityLine);
    }
  });
  const pendingApproval = createMemo(() => firstPendingApproval(snapshot()));

  createEffect(() => {
    // Refocus the composer when modal layers (approval prompt, secret prompt) clear.
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
        // Unknown slashes fall through to the model so provider-owned commands aren't swallowed.
        history.push(text);
        await sendText(text);
        return;
      }
      // Never push secret-shaped or rejected commands into history; /profile-secret
      // precedes a masked entry; /profile + --api-key is already a rejected leak path.
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

  function setMouseMode(enabled: boolean, source: "command" | "key"): void {
    renderer.useMouse = enabled;
    setMouseEnabled(renderer.useMouse);
    pushNotice({
      kind: enabled ? "warn" : "ok",
      message: enabled
        ? `Mouse mode enabled${source === "key" ? " via F7" : ""}; drag selects inside the TUI. Use F7 or /mouse off to restore terminal copy selection.`
        : `Mouse mode disabled${source === "key" ? " via F7" : ""}; terminal text selection/copy works normally.`,
    });
  }

  function toggleMouseMode(): void {
    setMouseMode(!mouseEnabled(), "key");
  }

  async function runLocalCommand(command: LocalCommand): Promise<void> {
    try {
      switch (command.type) {
        case "route":
          setRoute(command.route);
          pushNotice({ kind: "info", message: `Opened ${command.route}.` });
          return;
        case "inspector":
          setInspectorMode(command.mode);
          pushNotice({ kind: "info", message: `Inspector: ${command.mode}.` });
          return;
        case "help":
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
        case "mouse":
          setMouseMode(
            command.mode === "toggle" ? !mouseEnabled() : command.mode === "on",
            "command",
          );
          return;
        case "quit":
          props.onExit();
          return;
        case "query":
          await props.client.queryInspect(command.path, command.depth, command.targetId, {
            window: command.window,
            maxNodes: command.maxNodes,
          });
          setRoute("inspect");
          setInspectorMode("state");
          pushNotice({
            kind: "ok",
            message: `Queried ${command.targetId}:${command.path} depth ${command.depth}${command.window ? ` window ${command.window.join(":")}` : ""}.`,
          });
          return;
        case "invoke":
          await props.client.invokeInspect(
            command.path,
            command.action,
            command.params,
            command.targetId,
          );
          setRoute("inspect");
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
        case "set_default_profile":
          await props.client.setDefaultProfile(command.profileId);
          pushNotice({ kind: "ok", message: `Selected profile ${command.profileId}.` });
          return;
        case "delete_profile":
          await props.client.deleteProfile(command.profileId);
          pushNotice({ kind: "ok", message: `Deleted profile ${command.profileId}.` });
          return;
        case "delete_api_key":
          await props.client.deleteApiKey(command.profileId);
          pushNotice({ kind: "ok", message: `Deleted stored key for ${command.profileId}.` });
          return;
        case "rejected":
          pushNotice({ kind: "warn", message: command.reason });
          return;
        case "unknown":
          // Unreachable: submitDraft falls through to sendText for unknowns.
          return;
      }
    } catch (error) {
      pushNotice({ kind: "error", message: errorMessage(error) });
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
      setRoute("inspect");
      setInspectorMode("state");
      pushNotice({ kind: "ok", message: `Inspecting ${app.name}.` });
    } catch (error) {
      pushNotice({ kind: "error", message: errorMessage(error) });
    }
  }

  return (
    <box
      width={dimensions().width}
      height={dimensions().height}
      flexDirection="column"
      backgroundColor={COLORS.base}
    >
      <StatusBar
        snapshot={snapshot()}
        route={route()}
        inspector={inspectorMode()}
        mouseEnabled={mouseEnabled()}
      />
      <TabStrip snapshot={snapshot()} route={route()} />
      <box flexGrow={1} flexDirection={isWide() ? "row" : "column"}>
        <box flexGrow={1} flexDirection="column">
          <RouteView
            route={route()}
            snapshot={snapshot()}
            composerDraft={draft()}
            onRoute={setRoute}
            onInspector={setInspectorMode}
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
            onCopyResult={(result, text) => {
              if (result === "copied") {
                pushNotice({ kind: "ok", message: `Yanked: ${text.slice(0, 40)}` });
              } else if (result === "unsupported") {
                pushNotice({ kind: "warn", message: "Clipboard unsupported in this terminal." });
              } else {
                pushNotice({ kind: "error", message: "Yank failed." });
              }
            }}
          />
        </box>
        <Show when={isWide()}>
          <InspectorPanel mode={inspectorMode()} lines={activeInspectorItems()} />
        </Show>
      </box>
      <Show when={!isWide()}>
        <CompactInspector mode={inspectorMode()} lines={activeInspectorItems()} />
      </Show>
      <Show when={pendingApproval()}>
        {(approval) => <PendingApprovalPrompt approval={approval()} />}
      </Show>
      <QueuePreview items={queuedItems()} />
      <NoticeLine notice={notice()} history={noticeHistory()} expanded={noticeExpanded()} />
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
            if ((key.name === "up" || key.name === "down") && draft().length === 0) {
              const next = key.name === "up" ? history.previous() : history.next();
              if (next !== null && composerRef) {
                composerRef.setText(next);
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

function RouteView(props: {
  route: TuiRoute;
  snapshot: SessionViewSnapshot;
  composerDraft: string;
  onRoute: (route: TuiRoute) => void;
  onInspector: (mode: InspectorMode) => void;
  onApprove: (id: string) => void;
  onReject: (id: string) => void;
  onCancelTask: (id: string) => void;
  onSetDefaultProfile: (id: string) => void;
  onDeleteProfile: (id: string) => void;
  onDeleteApiKey: (id: string) => void;
  onInspectApp: (app: AppItem) => void;
  onDangerousNeedsConfirm: (approval: ApprovalItem) => void;
  onCopyResult: (result: "copied" | "unsupported" | "error", text: string) => void;
}) {
  return (
    <Switch
      fallback={
        <ChatRoute
          snapshot={props.snapshot}
          onRoute={props.onRoute}
          onInspector={props.onInspector}
        />
      }
    >
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
      <Match when={props.route === "inspect"}>
        <InspectRoute
          snapshot={props.snapshot}
          composerDraft={props.composerDraft}
          onCopyResult={props.onCopyResult}
        />
      </Match>
      <Match when={props.route === "settings"}>
        <SettingsRoute snapshot={props.snapshot} />
      </Match>
    </Switch>
  );
}
