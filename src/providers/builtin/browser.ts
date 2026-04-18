import { action, createSlopServer, type ItemDescriptor, type SlopServer } from "@slop-ai/server";

type Tab = {
  id: string;
  index: number;
  url: string;
  title: string;
  active: boolean;
};

type HistoryEntry = {
  id: string;
  step: number;
  url: string;
  actionType: "navigate" | "back" | "forward" | "jump";
  timestamp: string;
  method: "GET";
};

function titleFromUrl(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
}

export class BrowserProvider {
  readonly server: SlopServer;
  private tabs: Tab[] = [];
  private history: HistoryEntry[] = [];
  private historyPosition: number = -1;
  private navigationCount: number = 0;
  private screenshotCount: number = 0;
  private viewportWidth: number;
  private viewportHeight: number;

  constructor(options: { viewportWidth?: number; viewportHeight?: number } = {}) {
    this.viewportWidth = options.viewportWidth ?? 1280;
    this.viewportHeight = options.viewportHeight ?? 800;

    this.server = createSlopServer({
      id: "browser",
      name: "Browser",
    });

    this.server.register("session", () => this.buildSessionDescriptor());
    this.server.register("tabs", () => this.buildTabsDescriptor());
    this.server.register("history", () => this.buildHistoryDescriptor());
  }

  stop(): void {
    this.server.stop();
  }

  private get activeTab(): Tab | undefined {
    return this.tabs.find((t) => t.active);
  }

  private pushHistory(url: string, actionType: HistoryEntry["actionType"]): void {
    // Truncate forward history when navigating from a non-tip position
    if (this.historyPosition < this.history.length - 1) {
      this.history = this.history.slice(0, this.historyPosition + 1);
    }
    this.history.push({
      id: crypto.randomUUID(),
      step: this.history.length,
      url,
      actionType,
      timestamp: new Date().toISOString(),
      method: "GET",
    });
    this.historyPosition = this.history.length - 1;
  }

  private navigate(
    url: string,
    options: { new_tab?: boolean } = {},
  ): { url: string; title: string; status: number } {
    const title = titleFromUrl(url);
    this.navigationCount++;

    if (options.new_tab || this.tabs.length === 0) {
      for (const tab of this.tabs) tab.active = false;
      this.tabs.push({
        id: crypto.randomUUID(),
        index: this.tabs.length,
        url,
        title,
        active: true,
      });
    } else {
      const tab = this.activeTab;
      if (tab) {
        tab.url = url;
        tab.title = title;
      }
    }

    this.pushHistory(url, "navigate");
    this.server.refresh();
    return { url, title, status: 200 };
  }

  private closeTab(index?: number): { closed: boolean } {
    const targetIndex = index ?? this.tabs.findIndex((t) => t.active);
    if (targetIndex < 0 || targetIndex >= this.tabs.length) {
      throw new Error(`No tab at index ${targetIndex}`);
    }

    const wasActive = this.tabs[targetIndex].active;
    this.tabs.splice(targetIndex, 1);

    for (let i = 0; i < this.tabs.length; i++) {
      this.tabs[i].index = i;
    }

    if (wasActive && this.tabs.length > 0) {
      this.tabs[this.tabs.length - 1].active = true;
    }

    this.server.refresh();
    return { closed: true };
  }

  private switchTab(index: number): { tab_index: number; url: string; title: string } {
    const tab = this.tabs[index];
    if (!tab) {
      throw new Error(`No tab at index ${index}`);
    }
    for (const t of this.tabs) t.active = false;
    tab.active = true;
    this.server.refresh();
    return { tab_index: index, url: tab.url, title: tab.title };
  }

  private takeScreenshot(tabIndex?: number): {
    tab_index: number;
    url: string;
    width: number;
    height: number;
    format: string;
    data: string;
    captured_at: string;
  } {
    const tab = tabIndex !== undefined ? this.tabs[tabIndex] : this.activeTab;
    if (!tab) {
      throw new Error("No tab available to screenshot");
    }
    this.screenshotCount++;
    this.server.refresh();
    return {
      tab_index: tab.index,
      url: tab.url,
      width: this.viewportWidth,
      height: this.viewportHeight,
      format: "png",
      data: `<simulated-screenshot:${tab.url}>`,
      captured_at: new Date().toISOString(),
    };
  }

  private goBack(): { url: string; step: number } {
    if (this.historyPosition <= 0) {
      throw new Error("No previous page in history");
    }
    this.historyPosition--;
    const entry = this.history[this.historyPosition];
    const tab = this.activeTab;
    if (tab) {
      tab.url = entry.url;
      tab.title = titleFromUrl(entry.url);
    }
    this.navigationCount++;
    this.server.refresh();
    return { url: entry.url, step: entry.step };
  }

  private goForward(): { url: string; step: number } {
    if (this.historyPosition >= this.history.length - 1) {
      throw new Error("No next page in history");
    }
    this.historyPosition++;
    const entry = this.history[this.historyPosition];
    const tab = this.activeTab;
    if (tab) {
      tab.url = entry.url;
      tab.title = titleFromUrl(entry.url);
    }
    this.navigationCount++;
    this.server.refresh();
    return { url: entry.url, step: entry.step };
  }

  private goTo(step: number): { url: string; step: number } {
    const entry = this.history[step];
    if (!entry) {
      throw new Error(`No history entry at step ${step}`);
    }
    this.historyPosition = step;
    const tab = this.activeTab;
    if (tab) {
      tab.url = entry.url;
      tab.title = titleFromUrl(entry.url);
    }
    this.navigationCount++;
    this.server.refresh();
    return { url: entry.url, step: entry.step };
  }

  private buildSessionDescriptor() {
    const active = this.activeTab;
    return {
      type: "context",
      props: {
        open_tabs: this.tabs.length,
        active_tab: active ? active.index : null,
        navigation_count: this.navigationCount,
        screenshot_count: this.screenshotCount,
        viewport: { width: this.viewportWidth, height: this.viewportHeight },
      },
      summary: "Current browser session with tab and navigation state.",
      actions: {
        navigate: action(
          {
            url: "string",
            new_tab: {
              type: "boolean",
              description: "Open the URL in a new tab instead of the current one.",
            },
          },
          async ({ url, new_tab }) => this.navigate(url, { new_tab }),
          {
            label: "Navigate",
            description: "Load a URL in the active tab or a new tab.",
            estimate: "slow",
          },
        ),
        close_tab: action(
          {
            tab_index: {
              type: "number",
              description: "Index of the tab to close. Defaults to the active tab.",
            },
          },
          async ({ tab_index }) => this.closeTab(tab_index),
          {
            label: "Close Tab",
            description: "Close a browser tab by index.",
            estimate: "instant",
          },
        ),
      },
      meta: {
        focus: true,
        salience: 1,
      },
    };
  }

  private buildTabsDescriptor() {
    const items: ItemDescriptor[] = this.tabs.map((tab) => ({
      id: tab.id,
      props: {
        index: tab.index,
        url: tab.url,
        title: tab.title,
        active: tab.active,
      },
      actions: {
        switch_tab: action(async () => this.switchTab(tab.index), {
          label: "Switch to Tab",
          description: "Make this tab the active tab.",
          idempotent: true,
          estimate: "instant",
        }),
        take_screenshot: action(async () => this.takeScreenshot(tab.index), {
          label: "Take Screenshot",
          description: "Capture the current viewport of this tab as a PNG.",
          idempotent: true,
          estimate: "fast",
        }),
      },
      meta: {
        salience: tab.active ? 1 : 0.5,
      },
    }));

    return {
      type: "collection",
      props: {
        count: items.length,
      },
      summary: "Open browser tabs.",
      items,
    };
  }

  private buildHistoryDescriptor() {
    const items: ItemDescriptor[] = this.history.map((entry) => ({
      id: entry.id,
      props: {
        step: entry.step,
        url: entry.url,
        action_type: entry.actionType,
        timestamp: entry.timestamp,
        method: entry.method,
      },
      meta: {
        salience: entry.step === this.historyPosition ? 0.9 : 0.3,
      },
    }));

    return {
      type: "collection",
      props: {
        count: items.length,
        current_step: this.historyPosition,
      },
      summary: "Browser navigation history with back/forward controls.",
      actions: {
        go_back: action(async () => this.goBack(), {
          label: "Go Back",
          description: "Navigate to the previous page in history.",
          estimate: "slow",
        }),
        go_forward: action(async () => this.goForward(), {
          label: "Go Forward",
          description: "Navigate to the next page in history.",
          estimate: "slow",
        }),
        go_to: action({ step: "number" }, async ({ step }) => this.goTo(step), {
          label: "Go To Step",
          description: "Jump to a specific navigation history step.",
          estimate: "slow",
        }),
      },
      items,
    };
  }
}
