import { describe, expect, test } from "bun:test";
import { SessionStore } from "./store";

function buildStore(options?: { title?: string; workspaceRoot?: string }): SessionStore {
  return new SessionStore({
    sessionId: "test-session",
    modelProvider: "anthropic",
    model: "claude-3.5-sonnet",
    ...options,
  });
}

describe("SessionStore session title auto-generation", () => {
  test("beginTurn auto-generates title from first message", () => {
    const store = buildStore();
    store.beginTurn("deploy the staging environment now");
    const snapshot = store.getSnapshot();
    expect(snapshot.session.title).toBe("Deploy The Staging Environment Now");
  });

  test("beginTurn does not overwrite existing title", () => {
    const store = buildStore();
    store.beginTurn("first message text");
    const firstSnapshot = store.getSnapshot();
    expect(firstSnapshot.session.title).toBe("First Message Text");
    store.completeTurn(firstSnapshot.turn.turnId!, "assistant response");
    store.beginTurn("second message");
    const snapshot = store.getSnapshot();
    expect(snapshot.session.title).toBe("First Message Text");
  });

  test("generate title falls back to New Session for empty input", () => {
    const store = buildStore();
    store.beginTurn("   ");
    const snapshot = store.getSnapshot();
    expect(snapshot.session.title).toBe("New Session");
  });

  test("generate title falls back to New Session for whitespace-only input", () => {
    const store = buildStore();
    store.beginTurn("\n\t  ");
    const snapshot = store.getSnapshot();
    expect(snapshot.session.title).toBe("New Session");
  });

  test("generate title truncates long messages", () => {
    const longMessage = "a".repeat(200);
    const store = buildStore();
    store.beginTurn(longMessage);
    const snapshot = store.getSnapshot();
    expect(snapshot.session.title?.length).toBeLessThanOrEqual(60);
  });

  test("generate title strips punctuation except hyphens and apostrophes", () => {
    const store = buildStore();
    store.beginTurn("Hello, world! How's it going?");
    const snapshot = store.getSnapshot();
    expect(snapshot.session.title).toBe("Hello World How's It Going");
  });

  test("generate title preserves hyphens in words", () => {
    const store = buildStore();
    store.beginTurn("test my-api endpoint");
    const snapshot = store.getSnapshot();
    expect(snapshot.session.title).toBe("Test My-api Endpoint");
  });

  test("beginTurn auto-generates title when constructor had no title", () => {
    const store = buildStore();
    expect(store.getSnapshot().session.title).toBeUndefined();
    store.beginTurn("start a new project today");
    const snapshot = store.getSnapshot();
    expect(snapshot.session.title).toBe("Start A New Project Today");
  });
});
