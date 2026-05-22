import { SessionClient } from "./backend/session-client";
import { SessionSupervisorClient } from "./backend/supervisor-client";
import { handleSessionEvent, handleSupervisorEvent } from "./handlers/event-handlers";
import { AppUi } from "./ui/app";

function readArg(argv: string[], name: string): string | null {
  const index = argv.indexOf(name);
  if (index === -1) {
    return null;
  }
  return argv[index + 1] ?? null;
}

if (!process.stdin.isTTY || !process.stdout.isTTY) {
  console.error("sloppy tui requires an interactive TTY.");
  process.exit(1);
}

const args = process.argv.slice(2);
const socketPath = readArg(args, "--socket");
const supervisorSocketPath = readArg(args, "--supervisor");
if (!socketPath && !supervisorSocketPath) {
  console.error("Usage: bun run tui -- --socket /path/to/session.sock");
  console.error("   or: bun run tui -- --supervisor /path/to/supervisor.sock");
  process.exit(1);
}

const supervisor = supervisorSocketPath
  ? new SessionSupervisorClient(supervisorSocketPath)
  : undefined;
if (supervisor) {
  await supervisor.connect();
}
const initialSocketPath =
  socketPath ??
  supervisor?.getSnapshot().activeSocketPath ??
  supervisor?.getSnapshot().sessions[0]?.socketPath;
if (!initialSocketPath) {
  console.error("No active session socket found.");
  process.exit(1);
}

const client = new SessionClient(initialSocketPath);
const app = new AppUi(client, {
  supervisor,
  onSwitchSocket: async (nextSocketPath) => {
    await client.switchSocket(nextSocketPath);
  },
});

client.on((event) => handleSessionEvent(app, event));
supervisor?.on((event) => handleSupervisorEvent(app, event));
process.on("SIGINT", () => {
  app.stop();
  client.disconnect();
  supervisor?.disconnect();
  process.exit(0);
});

await client.connect();
app.start();
