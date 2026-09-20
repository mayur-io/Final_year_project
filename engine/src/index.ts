import { ensureDataDirectory, resolveDataDirectory } from "./storage.ts";
import { EngineServer } from "./server.ts";
import { generateHardwareProfile } from "./hardware.ts";

const VERSION = "0.1.0";
const DEFAULT_PORT = 4380;

const port = Number(process.env.SPLATO_ENGINE_PORT) || DEFAULT_PORT;
const dataDirectory = resolveDataDirectory();

await ensureDataDirectory(dataDirectory);

const hardware = await generateHardwareProfile(dataDirectory);
const server = new EngineServer({ port, dataDirectory, version: VERSION, name: "Splato Engine" });
const actualPort = await server.listen();

const gpu = hardware.gpu.detected ? `${hardware.gpu.name} (${hardware.gpu.memoryGB} GB)` : "no CUDA GPU detected";
console.log("┌──────────────────────────────────────────────────┐");
console.log(`  Splato Engine v${VERSION} — local reconstruction runtime`);
console.log(`  Listening:  http://localhost:${actualPort}`);
console.log(`  WebSocket:  ws://localhost:${actualPort}`);
console.log(`  Data dir:   ${dataDirectory}`);
console.log(`  Hardware:   ${hardware.cpu.cores} cores · ${Math.round(hardware.memory.totalGB)} GB RAM · ${gpu}`);
console.log(`  Tier:       ${hardware.tier}  (hardware-adaptive planning target)`);
console.log("└──────────────────────────────────────────────────┘");