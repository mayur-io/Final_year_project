// Engine protocol smoke test — run with: node scripts/test-protocol.mjs
// Verifies hello handshake, engines list, and a full demo job round-trip.
import WebSocket from "ws";

const URL = process.env.SPLATO_ENGINE_WS ?? "ws://localhost:4380";
const socket = new WebSocket(URL);
const timeout = setTimeout(() => {
  console.error("✗ timed out — is the engine running on " + URL + "?");
  process.exit(1);
}, 15000);

const events = [];
let exitCode = 0;

function pass(message) { console.log("✓ " + message); }
function fail(message) { console.error("✗ " + message); exitCode = 1; }

socket.on("open", () => {
  pass("connected to " + URL);
  socket.send(JSON.stringify({ type: "hello", version: "0.1.0", name: "smoke-test" }));
});

socket.on("message", (data) => {
  const message = JSON.parse(String(data));
  events.push(message.type);

  switch (message.type) {
    case "hello": {
      pass("hello reply — tier " + message.hardware.tier + ", GPU " + (message.hardware.gpu?.name ?? "none"));
      if (!Array.isArray(message.engines) || !message.engines.includes("demo")) {
        fail("expected 'demo' engine in engines list, got " + JSON.stringify(message.engines));
      } else {
        pass("engines: " + message.engines.join(", "));
      }
      const jobId = "smoke-" + Date.now();
      socket.send(JSON.stringify({ type: "submit", jobId, projectId: "smoke-test", pipeline: "demo", payload: {} }));
      break;
    }
    case "job.accepted":
      pass("job accepted " + message.jobId);
      break;
    case "job.progress":
      if (events.filter((type) => type === "job.progress").length <= 3) {
        console.log("  progress · " + message.phase + " " + message.progress + "%");
      }
      break;
    case "job.complete":
      pass("job complete — artifacts: " + JSON.stringify(message.artifacts));
      if (Object.keys(message.artifacts ?? {}).length === 0) fail("expected at least one artifact URL");
      socket.close();
      clearTimeout(timeout);
      console.log(exitCode === 0 ? "\nProtocol round-trip OK." : "\nProtocol round-trip FAILED.");
      process.exit(exitCode);
      break;
    case "job.failed":
      fail("job failed: " + message.error);
      socket.close();
      clearTimeout(timeout);
      process.exit(1);
      break;
    case "job.rejected":
      fail("job rejected: " + message.reason);
      socket.close();
      clearTimeout(timeout);
      process.exit(1);
      break;
    default:
      break;
  }
});

socket.on("error", (error) => {
  fail("websocket error: " + error.message);
  clearTimeout(timeout);
  process.exit(1);
});