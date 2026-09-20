// Minimal .env loader for the engine.
// Reads the repository-root .env (../.env relative to engine/) so the engine shares
// the same configuration as the web app without needing a dotenv dependency.
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const engineDirectory = path.dirname(fileURLToPath(import.meta.url));
const candidates = [
  path.join(engineDirectory, "..", ".env"), // engine/.env
  path.join(engineDirectory, "..", "..", ".env"), // repo root .env
];

function parseEnvFile(contents: string): Record<string, string> {
  const values: Record<string, string> = {};
  for (const rawLine of contents.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const equals = line.indexOf("=");
    if (equals < 1) continue;
    const key = line.slice(0, equals).trim();
    let value = line.slice(equals + 1).trim();
    // Strip surrounding quotes and unescape common patterns.
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    values[key] = value.replace(/\\"/g, '"').replace(/\\\\/g, "\\");
  }
  return values;
}

let loaded = false;

export function loadEnvironment() {
  if (loaded) return;
  loaded = true;
  for (const file of candidates) {
    if (!existsSync(file)) continue;
    const values = parseEnvFile(readFileSync(file, "utf8"));
    for (const [key, value] of Object.entries(values)) {
      if (process.env[key] === undefined) process.env[key] = value;
    }
    break;
  }
}