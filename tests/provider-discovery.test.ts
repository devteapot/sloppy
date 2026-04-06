import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  type ProviderDescriptor,
  type ProviderDiscoveryUpdate,
  watchProviderDescriptors,
} from "../src/providers/discovery";

const tempPaths: string[] = [];

function createDescriptor(path: string): ProviderDescriptor {
  return {
    id: "demo",
    name: "Demo",
    transport: {
      type: "unix",
      path,
    },
  };
}

async function waitForUpdate(
  updates: ProviderDiscoveryUpdate[],
  predicate: (update: ProviderDiscoveryUpdate) => boolean,
): Promise<ProviderDiscoveryUpdate> {
  const timeoutAt = Date.now() + 5000;

  while (Date.now() < timeoutAt) {
    const match = updates.find(predicate);
    if (match) {
      return match;
    }

    await Bun.sleep(50);
  }

  throw new Error("Timed out waiting for provider discovery update.");
}

afterEach(async () => {
  while (tempPaths.length > 0) {
    const path = tempPaths.pop();
    if (!path) {
      continue;
    }

    await rm(path, { recursive: true, force: true });
  }
});

describe("watchProviderDescriptors", () => {
  test("emits add, update, and remove changes for descriptor files", async () => {
    const directory = await mkdtemp(join(tmpdir(), "sloppy-discovery-"));
    const descriptorPath = join(directory, "demo.json");
    const updates: ProviderDiscoveryUpdate[] = [];
    tempPaths.push(directory);

    const stop = watchProviderDescriptors({
      paths: [directory],
      onChange: (update) => {
        updates.push(update);
      },
    });

    try {
      await writeFile(descriptorPath, JSON.stringify(createDescriptor("/tmp/demo.sock")), "utf8");
      const added = await waitForUpdate(updates, (update) =>
        update.added.some((descriptor) => descriptor.id === "demo"),
      );

      expect(added.added).toEqual([createDescriptor("/tmp/demo.sock")]);
      updates.length = 0;

      await writeFile(
        descriptorPath,
        JSON.stringify(createDescriptor("/tmp/demo-next.sock")),
        "utf8",
      );
      const updated = await waitForUpdate(updates, (update) =>
        update.updated.some((descriptor) => descriptor.id === "demo"),
      );

      expect(updated.updated).toEqual([createDescriptor("/tmp/demo-next.sock")]);
      updates.length = 0;

      await rm(descriptorPath, { force: true });
      const removed = await waitForUpdate(updates, (update) =>
        update.removed.some((descriptor) => descriptor.id === "demo"),
      );

      expect(removed.removed).toEqual([createDescriptor("/tmp/demo-next.sock")]);
    } finally {
      stop();
    }
  });
});
