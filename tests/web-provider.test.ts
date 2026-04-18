import { afterEach, describe, expect, test } from "bun:test";
import { SlopConsumer } from "@slop-ai/consumer/browser";

import { InProcessTransport } from "../src/providers/builtin/in-process";
import { WebProvider } from "../src/providers/builtin/web";

const originalFetch = globalThis.fetch;

type FetchArgs = Parameters<typeof fetch>;
type SearchFixture = {
  url: string;
  title: string;
  description: string;
};

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function createHarness(options: ConstructorParameters<typeof WebProvider>[0] = {}) {
  const provider = new WebProvider(options);
  const consumer = new SlopConsumer(new InProcessTransport(provider.server));

  return { provider, consumer };
}

async function connect(consumer: SlopConsumer): Promise<void> {
  await consumer.connect();
  await consumer.subscribe("/", 3);
}

function inputUrl(input: FetchArgs[0]): string {
  if (typeof input === "string") {
    return input;
  }
  if (input instanceof URL) {
    return input.toString();
  }
  return input.url;
}

function stubFetch(
  options: {
    searchResults?: SearchFixture[];
    readBody?: string;
    failSearch?: boolean;
    failRead?: boolean;
  } = {},
): string[] {
  const urls: string[] = [];
  const searchResults = options.searchResults ?? [
    {
      url: "https://example.com/one",
      title: "First Result",
      description: "First snippet",
    },
    {
      url: "https://example.com/two",
      title: "Second Result",
      description: "Second snippet",
    },
    {
      url: "https://example.com/three",
      title: "Third Result",
      description: "Third snippet",
    },
  ];

  globalThis.fetch = (async (...args: FetchArgs) => {
    const url = inputUrl(args[0]);
    urls.push(url);

    if (url.startsWith("https://api.search.brave.com/")) {
      if (options.failSearch) {
        return new Response("search failed", { status: 503, statusText: "Service Unavailable" });
      }

      return Response.json({
        web: {
          results: searchResults,
        },
      });
    }

    if (options.failRead) {
      return new Response("read failed", { status: 404, statusText: "Not Found" });
    }

    return new Response(options.readBody ?? "Hello from a stubbed URL.", {
      headers: { "Content-Type": "text/plain" },
    });
  }) as typeof fetch;

  return urls;
}

describe("WebProvider", () => {
  test("exposes initial web search and history state", async () => {
    const { provider, consumer } = createHarness();

    try {
      await connect(consumer);

      const session = await consumer.query("/session", 2);
      expect(session.type).toBe("context");
      expect(session.properties?.total_ops).toBe(0);
      expect(session.properties?.last_search_query).toBeNull();
      expect(session.properties?.last_search_result_count).toBeNull();
      expect(session.affordances?.map((affordance) => affordance.action)).toEqual([
        "search",
        "read",
      ]);

      const search = await consumer.query("/search", 2);
      expect(search.properties?.query).toBeNull();
      expect(search.properties?.result_count).toBe(0);

      const history = await consumer.query("/history", 2);
      expect(history.type).toBe("collection");
      expect(history.properties?.count).toBe(0);
      expect(history.children ?? []).toEqual([]);
    } finally {
      provider.stop();
    }
  });

  test("search updates search state with formatted results", async () => {
    stubFetch();
    const { provider, consumer } = createHarness();

    try {
      await connect(consumer);

      const searchResult = await consumer.invoke("/session", "search", {
        query: "sloppy protocol",
        limit: 2,
      });
      expect(searchResult.status).toBe("ok");

      const data = searchResult.data as {
        query: string;
        results: Array<{ url: string; title: string; snippet: string }>;
      };
      expect(data.query).toBe("sloppy protocol");
      expect(data.results).toEqual([
        {
          url: "https://example.com/one",
          title: "First Result",
          snippet: "First snippet",
        },
        {
          url: "https://example.com/two",
          title: "Second Result",
          snippet: "Second snippet",
        },
      ]);

      const search = await consumer.query("/search", 2);
      expect(search.properties?.query).toBe("sloppy protocol");
      expect(search.properties?.result_count).toBe(2);
      expect(search.properties?.results).toEqual(data.results);
    } finally {
      provider.stop();
    }
  });

  test("passes query and max result limit to the search endpoint", async () => {
    const urls = stubFetch();
    const { provider, consumer } = createHarness();

    try {
      await connect(consumer);

      await consumer.invoke("/session", "search", {
        query: "agent harness",
        limit: 1,
      });

      const requestUrl = new URL(urls[0] ?? "");
      expect(requestUrl.searchParams.get("q")).toBe("agent harness");
      expect(requestUrl.searchParams.get("format")).toBe("json");
      expect(requestUrl.searchParams.get("num")).toBe("1");
    } finally {
      provider.stop();
    }
  });

  test("search history records successful searches", async () => {
    stubFetch();
    const { provider, consumer } = createHarness();

    try {
      await connect(consumer);

      await consumer.invoke("/session", "search", { query: "first query", limit: 1 });
      await consumer.invoke("/session", "search", { query: "second query", limit: 2 });

      const history = await consumer.query("/history", 2);
      expect(history.properties?.count).toBe(2);
      expect(history.children?.[0]?.properties?.kind).toBe("search");
      expect(history.children?.[0]?.properties?.query).toBe("second query");
      expect(history.children?.[0]?.properties?.result_count).toBe(2);
      expect(history.children?.[0]?.properties?.status).toBe("ok");
      expect(history.children?.[1]?.properties?.query).toBe("first query");
    } finally {
      provider.stop();
    }
  });

  test("history show_result returns full search results", async () => {
    stubFetch();
    const { provider, consumer } = createHarness();

    try {
      await connect(consumer);

      await consumer.invoke("/session", "search", { query: "show search", limit: 2 });
      const history = await consumer.query("/history", 2);
      const historyId = history.children?.[0]?.id;
      expect(typeof historyId).toBe("string");

      const showResult = await consumer.invoke(`/history/${historyId}`, "show_result", {});
      expect(showResult.status).toBe("ok");
      expect((showResult.data as { query: string }).query).toBe("show search");
      expect((showResult.data as { results: SearchFixture[] }).results).toHaveLength(2);
    } finally {
      provider.stop();
    }
  });

  test("read fetches URL content and records read history", async () => {
    stubFetch({ readBody: "Readable page content." });
    const { provider, consumer } = createHarness();

    try {
      await connect(consumer);

      const readResult = await consumer.invoke("/session", "read", {
        url: "https://example.com/read",
        maxBytes: 100,
      });
      expect(readResult.status).toBe("ok");
      expect((readResult.data as { url: string }).url).toBe("https://example.com/read");
      expect((readResult.data as { content: string }).content).toBe("Readable page content.");
      expect((readResult.data as { contentLength: number }).contentLength).toBe(22);

      const history = await consumer.query("/history", 2);
      expect(history.children?.[0]?.properties?.kind).toBe("read");
      expect(history.children?.[0]?.properties?.url).toBe("https://example.com/read");
      expect(history.children?.[0]?.properties?.content_length).toBe(22);
      expect(history.children?.[0]?.properties?.status).toBe("ok");
    } finally {
      provider.stop();
    }
  });

  test("read truncates content at maxBytes", async () => {
    stubFetch({ readBody: "abcdefghijklmnopqrstuvwxyz" });
    const { provider, consumer } = createHarness();

    try {
      await connect(consumer);

      const readResult = await consumer.invoke("/session", "read", {
        url: "https://example.com/long",
        maxBytes: 5,
      });
      expect(readResult.status).toBe("ok");
      expect((readResult.data as { content: string }).content).toBe("abcde\n...[truncated]");
      expect((readResult.data as { contentLength: number }).contentLength).toBe(26);
    } finally {
      provider.stop();
    }
  });

  test("history show_result returns read content", async () => {
    stubFetch({ readBody: "Saved read content." });
    const { provider, consumer } = createHarness();

    try {
      await connect(consumer);

      await consumer.invoke("/session", "read", {
        url: "https://example.com/show-read",
        maxBytes: 100,
      });
      const history = await consumer.query("/history", 2);
      const historyId = history.children?.[0]?.id;
      expect(typeof historyId).toBe("string");

      const showResult = await consumer.invoke(`/history/${historyId}`, "show_result", {});
      expect(showResult.status).toBe("ok");
      expect((showResult.data as { url: string }).url).toBe("https://example.com/show-read");
      expect((showResult.data as { content: string }).content).toBe("Saved read content.");
    } finally {
      provider.stop();
    }
  });

  test("caps retained history to historyLimit", async () => {
    stubFetch();
    const { provider, consumer } = createHarness({ historyLimit: 2 });

    try {
      await connect(consumer);

      await consumer.invoke("/session", "search", { query: "one", limit: 1 });
      await consumer.invoke("/session", "search", { query: "two", limit: 1 });
      await consumer.invoke("/session", "search", { query: "three", limit: 1 });

      const history = await consumer.query("/history", 2);
      expect(history.properties?.count).toBe(2);
      expect(history.children?.map((child) => child.properties?.query)).toEqual(["three", "two"]);

      const session = await consumer.query("/session", 2);
      expect(session.properties?.total_ops).toBe(2);
    } finally {
      provider.stop();
    }
  });

  test("records failed searches in history", async () => {
    stubFetch({ failSearch: true });
    const { provider, consumer } = createHarness();

    try {
      await connect(consumer);

      const searchResult = await consumer.invoke("/session", "search", {
        query: "broken",
        limit: 1,
      });
      expect(searchResult.status).toBe("error");

      const history = await consumer.query("/history", 2);
      expect(history.children?.[0]?.properties?.kind).toBe("search");
      expect(history.children?.[0]?.properties?.status).toBe("error");
      expect(history.children?.[0]?.properties?.query).toBe("broken");
      expect(String(history.children?.[0]?.properties?.error)).toContain("503");
    } finally {
      provider.stop();
    }
  });
});
