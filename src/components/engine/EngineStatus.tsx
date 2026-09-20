"use client";

import { useEffect, useState } from "react";

type EngineState = {
  status: "connecting" | "online" | "offline";
  gpu: string | null;
  tier: string | null;
  ready: boolean;
};

const ENGINE_URL = "ws://localhost:4380";

function Dot({ color }: { color: string }) {
  return <span aria-hidden className={`h-2 w-2 shrink-0 rounded-full ${color}`} />;
}

/**
 * Live indicator for the local Splato Engine (M1).
 * The browser connects straight to ws://localhost:4380 — the engine never
 * needs to be reachable from the internet, only from this machine.
 */
export default function EngineStatus() {
  const [state, setState] = useState<EngineState>({
    status: "connecting",
    gpu: null,
    tier: null,
    ready: false,
  });

  useEffect(() => {
    let cancelled = false;
    let socket: WebSocket | null = null;
    let timeout: number | undefined;

    try {
      socket = new WebSocket(ENGINE_URL);
    } catch {
      setState({ status: "offline", gpu: null, tier: null, ready: false });
      return;
    }

    timeout = window.setTimeout(() => {
      socket?.close();
      if (!cancelled) {
        setState({ status: "offline", gpu: null, tier: null, ready: false });
      }
    }, 2500);

    socket.onopen = () => {
      socket?.send(JSON.stringify({ type: "hello", version: "0.1.0", name: "web-ui" }));
    };
    socket.onmessage = (event) => {
      try {
        const message = JSON.parse(String(event.data)) as {
          type?: string;
          ready?: boolean;
          hardware?: { gpu?: { name?: string | null }; tier?: string };
        };
        if (message.type === "hello" && !cancelled) {
          window.clearTimeout(timeout);
          setState({
            status: "online",
            gpu: message.hardware?.gpu?.name ?? null,
            tier: message.hardware?.tier ?? null,
            ready: message.ready ?? false,
          });
          socket?.close();
        }
      } catch {
        // Ignore malformed replies; the timeout still applies.
      }
    };
    socket.onerror = () => {
      if (!cancelled) {
        window.clearTimeout(timeout);
        setState({ status: "offline", gpu: null, tier: null, ready: false });
      }
    };

    return () => {
      cancelled = true;
      window.clearTimeout(timeout);
      socket?.close();
    };
  }, []);

  if (state.status === "connecting") {
    return (
      <span className="inline-flex items-center gap-1.5 rounded-full border border-white/10 px-2.5 py-1 text-xs text-gray-400">
        <Dot color="bg-gray-500" /> Engine · connecting…
      </span>
    );
  }

  if (state.status === "offline") {
    return (
      <span
        title="Start the engine: cd engine && npm start"
        className="inline-flex items-center gap-1.5 rounded-full border border-rose-500/30 px-2.5 py-1 text-xs text-rose-300"
      >
        <Dot color="bg-rose-400" /> Engine offline
      </span>
    );
  }

  return (
    <span className="inline-flex items-center gap-1.5 rounded-full border border-emerald-500/30 px-2.5 py-1 text-xs text-emerald-300">
      <Dot color="bg-emerald-400" />
      Engine · {state.gpu ?? "local"} · {state.tier ?? ""} tier
    </span>
  );
}