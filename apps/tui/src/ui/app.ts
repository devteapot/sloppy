import { Container, matchesKey, ProcessTerminal, Text, TUI } from "@earendil-works/pi-tui";

import type { SessionClient } from "../backend/session-client";
import type { SessionViewSnapshot } from "../backend/slop-types";
import { submitMessage } from "../handlers/submit";
import { ChatLog } from "./chat-log";
import { CustomEditor } from "./custom-editor";
import { StatusLine } from "./status-line";

export class AppUi {
  readonly tui: TUI;
  private readonly root = new Container();
  private readonly header = new Text("sloppy");
  private readonly chatLog = new ChatLog();
  private readonly statusLine = new StatusLine();
  private readonly notice = new Text("");
  private readonly footer = new Text("Enter sends | Ctrl+C exits | Esc cancels turn");
  private readonly editor: CustomEditor;
  private snapshot: SessionViewSnapshot | null = null;

  constructor(private readonly client: SessionClient) {
    this.tui = new TUI(new ProcessTerminal());
    this.editor = new CustomEditor(this.tui);
    this.editor.onSubmit = (text) => {
      this.editor.setText("");
      submitMessage(this.client, text).catch((error: unknown) => {
        this.setNotice(error instanceof Error ? error.message : String(error));
      });
    };

    this.root.addChild(this.header);
    this.root.addChild(this.chatLog);
    this.root.addChild(this.statusLine);
    this.root.addChild(this.notice);
    this.root.addChild(this.footer);
    this.root.addChild(this.editor);
    this.tui.addChild(this.root);
    this.tui.setFocus(this.editor);
    this.tui.addInputListener((data) => {
      if (matchesKey(data, "ctrl+c")) {
        this.client.disconnect();
        this.stop();
        process.exit(0);
      }
      if (matchesKey(data, "escape")) {
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
    this.header.setText(`sloppy ${snapshot.connection.status}`);
    this.chatLog.update(snapshot.transcript);
    this.statusLine.update(snapshot);
    this.editor.disableSubmit = !snapshot.composer.canSend;
    this.tui.requestRender();
  }

  setNotice(message: string): void {
    this.notice.setText(message);
    this.tui.requestRender();
  }

  start(): void {
    this.tui.start();
  }

  stop(): void {
    this.tui.stop();
  }
}
