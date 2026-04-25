import { describe, expect, test } from "bun:test";

import { ApprovalQueue } from "../src/core/approvals";

function makeQueue() {
  return new ApprovalQueue();
}

describe("ApprovalQueue", () => {
  test("reject keeps the record visible in list() with status='rejected'", () => {
    const queue = makeQueue();
    const id = queue.enqueue({
      providerId: "terminal",
      path: "/session",
      action: "execute",
      reason: "test",
      execute: async () => ({ status: "ok" }),
    });

    queue.reject(id, "user said no");

    const items = queue.list();
    expect(items).toHaveLength(1);
    expect(items[0]?.status).toBe("rejected");
    expect(items[0]?.resolutionReason).toBe("user said no");
  });

  test("cancel removes the record from list() entirely", () => {
    const queue = makeQueue();
    const id = queue.enqueue({
      providerId: "terminal",
      path: "/session",
      action: "execute",
      reason: "test",
      execute: async () => ({ status: "ok" }),
    });

    let rejectedFired = 0;
    queue.on("rejected", () => {
      rejectedFired++;
    });

    queue.cancel(id, "system cancelled");

    expect(queue.list()).toHaveLength(0);
    expect(rejectedFired).toBe(1);
  });

  test("cancel throws if the approval was already resolved", () => {
    const queue = makeQueue();
    const id = queue.enqueue({
      providerId: "terminal",
      path: "/session",
      action: "execute",
      reason: "test",
      execute: async () => ({ status: "ok" }),
    });
    queue.reject(id);
    expect(() => queue.cancel(id)).toThrow(/already resolved/);
  });
});
