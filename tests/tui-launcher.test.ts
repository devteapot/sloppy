import { expect, test } from "bun:test";

import { supervisorLaunchArgv } from "../apps/tui/src/index";

test("dev (.ts) entry spawns the dev bin entry via bun run", () => {
  const argv = supervisorLaunchArgv({
    execPath: "/opt/bun",
    script: "/repo/src/bin/sloppy.ts",
    devEntry: "/repo/src/bin/sloppy.ts",
    socketPath: "/tmp/slop/supervisor.sock",
  });
  expect(argv.slice(0, 3)).toEqual(["/opt/bun", "run", "/repo/src/bin/sloppy.ts"]);
  expect(argv).toContain("session");
  expect(argv).toContain("supervisor");
  expect(argv[argv.indexOf("--socket") + 1]).toBe("/tmp/slop/supervisor.sock");
});

test("direct TUI dev entry still spawns the bin entry, not itself", () => {
  const argv = supervisorLaunchArgv({
    execPath: "/opt/bun",
    script: "/repo/apps/tui/src/index.ts",
    devEntry: "/repo/src/bin/sloppy.ts",
    socketPath: "/tmp/slop/supervisor.sock",
  });
  expect(argv.slice(0, 3)).toEqual(["/opt/bun", "run", "/repo/src/bin/sloppy.ts"]);
});

test("built (.js) entry spawns the bundled script directly", () => {
  const argv = supervisorLaunchArgv({
    execPath: "/opt/bun",
    script: "/app/dist/bin/sloppy.js",
    devEntry: "/repo/src/bin/sloppy.ts",
    socketPath: "/tmp/slop/supervisor.sock",
  });
  expect(argv.slice(0, 2)).toEqual(["/opt/bun", "/app/dist/bin/sloppy.js"]);
  expect(argv).not.toContain("run");
});
