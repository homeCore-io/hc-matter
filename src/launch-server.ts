// Runs matter-server so that it cannot outlive the plugin.
//
//   node launch-server.js <matter-server bin.js> <its arguments...>
//
// Its stdin is a pipe from the plugin. When the plugin goes, however it goes
// (a SIGKILL included), the pipe closes and this stops the server, which
// would otherwise keep the Matter ports and the socket, and make the next
// start of the plugin fight an orphan for them.

import { pathToFileURL } from "node:url";

const [bin, ...args] = process.argv.slice(2);
if (!bin) {
  console.error("usage: launch-server <matter-server bin.js> [args...]");
  process.exit(2);
}

process.stdin.on("end", () => {
  // matter-server closes its storage on SIGTERM; give it a moment, then go.
  process.kill(process.pid, "SIGTERM");
  setTimeout(() => process.exit(0), 3000).unref();
});
process.stdin.resume();

// matter-server reads its options from process.argv, as if run directly.
process.argv = [process.argv[0], bin, ...args];
await import(pathToFileURL(bin).href);
