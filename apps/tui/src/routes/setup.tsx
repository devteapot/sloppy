import { TextAttributes } from "@opentui/core";
import { useKeyboard } from "@opentui/solid";
import { createMemo, createSignal, For, Show } from "solid-js";
import { COLORS } from "../lib/theme";
import type { SessionViewSnapshot } from "../slop/types";

export function SetupRoute(props: {
  snapshot: SessionViewSnapshot;
  composerDraft: string;
  onSetDefaultProfile: (id: string) => void;
  onDeleteProfile: (id: string) => void;
  onDeleteApiKey: (id: string) => void;
}) {
  const [selectedIndex, setSelectedIndex] = createSignal(0);
  const [pendingDelete, setPendingDelete] = createSignal<"profile" | "key" | null>(null);

  const visible = createMemo(() => props.snapshot.llm.profiles);

  useKeyboard((key) => {
    if (props.composerDraft.trim().length > 0) {
      return;
    }
    const items = visible();
    if (items.length === 0) {
      return;
    }

    if (key.name === "up") {
      setSelectedIndex((i) => Math.max(0, i - 1));
      setPendingDelete(null);
      return;
    }
    if (key.name === "down") {
      setSelectedIndex((i) => Math.min(items.length - 1, i + 1));
      setPendingDelete(null);
      return;
    }

    const current = items[Math.min(selectedIndex(), items.length - 1)];
    if (!current) {
      return;
    }

    if (key.name === "return" || key.name === "enter") {
      props.onSetDefaultProfile(current.id);
      return;
    }
    if (key.name === "d") {
      if (current.canDeleteProfile) {
        if (pendingDelete() === "profile" && key.shift) {
          props.onDeleteProfile(current.id);
          setPendingDelete(null);
        } else {
          setPendingDelete("profile");
        }
      }
      return;
    }
    if (key.name === "k") {
      if (current.canDeleteApiKey) {
        if (pendingDelete() === "key" && key.shift) {
          props.onDeleteApiKey(current.id);
          setPendingDelete(null);
        } else {
          setPendingDelete("key");
        }
      }
      return;
    }
    if (key.name === "escape") {
      setPendingDelete(null);
    }
  });

  const llm = () => props.snapshot.llm;

  return (
    <scrollbox flexGrow={1} padding={1} backgroundColor={COLORS.base}>
      <text fg={COLORS.green} attributes={TextAttributes.BOLD} content="LLM Setup" />
      <text fg={llm().status === "ready" ? COLORS.green : COLORS.yellow} content={llm().message} />
      <text
        fg={COLORS.dim}
        wrapMode="word"
        content="↑/↓ select · Enter set default · d (then Shift+D) delete profile · k (then Shift+K) delete API key · /profile-secret provider model opens masked entry · /profile ... --reasoning-effort high"
      />
      <Show when={pendingDelete()}>
        {(mode) => (
          <text
            fg={COLORS.yellow}
            content={`Press Shift+${mode() === "profile" ? "D" : "K"} again to confirm. Esc cancels.`}
          />
        )}
      </Show>
      <For each={visible()}>
        {(profile, index) => {
          const isSelected = () => index() === selectedIndex();
          return (
            <box
              flexDirection="column"
              marginTop={1}
              padding={1}
              backgroundColor={isSelected() ? COLORS.panelHigh : COLORS.panel}
            >
              <text
                fg={profile.ready ? COLORS.green : COLORS.yellow}
                attributes={profile.isDefault ? TextAttributes.BOLD : TextAttributes.NONE}
                content={`${isSelected() ? "▸ " : "  "}${profile.isDefault ? "* " : ""}${profile.label ?? profile.id} · ${profile.provider}/${profile.model}${profile.adapterId ? ` · adapter=${profile.adapterId}` : ""}`}
              />
              <text
                fg={COLORS.dim}
                content={`origin=${profile.origin} key=${profile.keySource} managed=${profile.managed} ready=${profile.ready}${profile.baseUrl ? ` base=${profile.baseUrl}` : ""}`}
              />
            </box>
          );
        }}
      </For>
      <Show when={visible().length === 0}>
        <text fg={COLORS.dim} content="No profiles exposed by /llm yet." />
      </Show>
    </scrollbox>
  );
}
