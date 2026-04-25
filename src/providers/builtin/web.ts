import { action, createSlopServer, type ItemDescriptor, type SlopServer } from "@slop-ai/server";

import { ProviderApprovalManager } from "../approvals";

type SearchResult = {
  url: string;
  title: string;
  snippet: string;
};

type WebOp = {
  id: string;
  kind: "search" | "read";
  query?: string;
  url?: string;
  timestamp: string;
  status: "ok" | "error";
  resultCount?: number;
  results?: SearchResult[];
  content?: string;
  contentLength?: number;
  error?: string;
};

function buildOpId(): string {
  return `webop-${crypto.randomUUID()}`;
}

function truncateContent(text: string, maxBytes: number): string {
  const encoded = new TextEncoder().encode(text);
  if (encoded.length <= maxBytes) {
    return text;
  }
  return `${new TextDecoder().decode(encoded.slice(0, maxBytes))}\n...[truncated]`;
}

export class WebProvider {
  readonly server: SlopServer;
  private historyLimit: number;
  readonly approvals: ProviderApprovalManager;
  private history: WebOp[] = [];
  private lastSearch: { query: string; results: SearchResult[] } | null = null;

  constructor(options: { historyLimit?: number } = {}) {
    this.historyLimit = options.historyLimit ?? 20;

    this.server = createSlopServer({
      id: "web",
      name: "Web",
    });
    this.approvals = new ProviderApprovalManager(this.server);

    this.server.register("session", () => this.buildSessionDescriptor());
    this.server.register("search", () => this.buildSearchDescriptor());
    this.server.register("history", () => this.buildHistoryDescriptor());
    this.server.register("approvals", () => this.approvals.buildDescriptor());
  }

  stop(): void {
    this.server.stop();
  }

  private pushHistory(op: WebOp): void {
    this.history.unshift(op);
    this.history = this.history.slice(0, this.historyLimit);
  }

  private async performSearch(query: string, limit: number): Promise<SearchResult[]> {
    const params = new URLSearchParams({ q: query, format: "json", num: String(limit) });
    const response = await fetch(`https://api.search.brave.com/res/v1/web/search?${params}`, {
      headers: {
        Accept: "application/json",
        "Accept-Encoding": "gzip",
        "X-Subscription-Token": Bun.env.BRAVE_SEARCH_API_KEY ?? "",
      },
    });

    if (!response.ok) {
      throw new Error(`Search request failed: ${response.status} ${response.statusText}`);
    }

    const data = (await response.json()) as {
      web?: { results?: Array<{ url: string; title: string; description: string }> };
    };
    const raw = data.web?.results ?? [];
    return raw.slice(0, limit).map((r) => ({
      url: r.url,
      title: r.title,
      snippet: r.description,
    }));
  }

  private async doSearch(
    query: string,
    limit: number,
  ): Promise<{ query: string; results: SearchResult[] }> {
    const opId = buildOpId();
    const timestamp = new Date().toISOString();
    try {
      const results = await this.performSearch(query, limit);
      this.lastSearch = { query, results };
      this.pushHistory({
        id: opId,
        kind: "search",
        query,
        timestamp,
        status: "ok",
        resultCount: results.length,
        results,
      });
      this.server.refresh();
      return { query, results };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.pushHistory({
        id: opId,
        kind: "search",
        query,
        timestamp,
        status: "error",
        error: message,
      });
      this.server.refresh();
      throw error;
    }
  }

  private async doRead(
    url: string,
    maxBytes: number,
  ): Promise<{ url: string; content: string; contentLength: number }> {
    const opId = buildOpId();
    const timestamp = new Date().toISOString();
    try {
      const response = await fetch(url, {
        headers: { Accept: "text/html,text/plain,*/*" },
      });

      if (!response.ok) {
        throw new Error(`Fetch failed: ${response.status} ${response.statusText}`);
      }

      const raw = await response.text();
      const content = truncateContent(raw, maxBytes);
      this.pushHistory({
        id: opId,
        kind: "read",
        url,
        timestamp,
        status: "ok",
        content,
        contentLength: raw.length,
      });
      this.server.refresh();
      return { url, content, contentLength: raw.length };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.pushHistory({
        id: opId,
        kind: "read",
        url,
        timestamp,
        status: "error",
        error: message,
      });
      this.server.refresh();
      throw error;
    }
  }

  private buildSessionDescriptor() {
    return {
      type: "context",
      props: {
        total_ops: this.history.length,
        last_search_query: this.lastSearch?.query ?? null,
        last_search_result_count: this.lastSearch?.results.length ?? null,
      },
      summary: "Web browsing session stats and affordances.",
      actions: {
        search: action(
          {
            query: "string",
            limit: {
              type: "number",
              description: "Maximum number of results to return (default 10).",
            },
          },
          async ({ query, limit }) => this.doSearch(query, limit ?? 10),
          {
            label: "Web Search",
            description: "Search the web and return a list of results.",
            estimate: "slow",
          },
        ),
        read: action(
          {
            url: "string",
            maxBytes: {
              type: "number",
              description: "Maximum response body size in bytes (default 32768).",
            },
          },
          async ({ url, maxBytes }) => this.doRead(url, maxBytes ?? 32768),
          {
            label: "Read URL",
            description: "Fetch the contents of a URL and return the text.",
            estimate: "slow",
          },
        ),
      },
      meta: {
        focus: false,
        salience: 0.6,
      },
    };
  }

  private buildSearchDescriptor() {
    if (!this.lastSearch) {
      return {
        type: "context",
        props: { query: null, result_count: 0 },
        summary: "No search has been performed yet.",
      };
    }

    return {
      type: "context",
      props: {
        query: this.lastSearch.query,
        result_count: this.lastSearch.results.length,
        results: this.lastSearch.results,
      },
      summary: `Search results for: ${this.lastSearch.query}`,
    };
  }

  private buildHistoryDescriptor() {
    const items: ItemDescriptor[] = this.history.map((op) => ({
      id: op.id,
      props: {
        kind: op.kind,
        timestamp: op.timestamp,
        status: op.status,
        ...(op.kind === "search"
          ? { query: op.query, result_count: op.resultCount ?? 0 }
          : { url: op.url, content_length: op.contentLength ?? 0 }),
        ...(op.error ? { error: op.error } : {}),
      },
      actions: {
        show_result: action(
          async () => {
            if (op.kind === "search") {
              return { query: op.query, results: op.results ?? [] };
            }
            return { url: op.url, content: op.content ?? "" };
          },
          {
            label: "Show Result",
            description: "Return the full result for this web operation.",
            idempotent: true,
            estimate: "fast",
          },
        ),
      },
    }));

    return {
      type: "collection",
      props: { count: items.length },
      summary: "Recent web search and read operations.",
      items,
    };
  }
}
