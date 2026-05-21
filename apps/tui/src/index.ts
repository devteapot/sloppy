import { SessionClient } from "./backend/session-client";
import { handleSessionEvent } from "./handlers/event-handlers";
import { AppUi } from "./ui/app";

function readSocketArg(argv: string[]): string | null {
  const index = argv.indexOf("--socket");
  if (index === -1) {
    return null;
  }
  return argv[index + 1] ?? null;
}

if (!process.stdin.isTTY || !process.stdout.isTTY) {
  console.error("sloppy tui requires an interactive TTY.");
  process.exit(1);
}

const socketPath = readSocketArg(process.argv.slice(2));
if (!socketPath) {
  console.error("Usage: bun run tui -- --socket /path/to/session.sock");
  process.exit(1);
}

const client = new SessionClient(socketPath);
const app = new AppUi(client);

client.on((event) => handleSessionEvent(app, event));
process.on("SIGINT", () => {
  app.stop();
  client.disconnect();
  process.exit(0);
});

await client.connect();
app.start();
