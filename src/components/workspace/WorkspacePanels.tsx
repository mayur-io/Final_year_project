"use client";

import { createContext, type ReactNode, useContext, useEffect, useMemo, useState } from "react";

type WorkspacePanels = {
  left: ReactNode;
  right: ReactNode;
};

type WorkspacePanelsContextValue = {
  panels: WorkspacePanels;
  setPanels: (panels: WorkspacePanels) => void;
};

const emptyPanels: WorkspacePanels = {
  left: <p className="text-sm leading-6 text-zinc-500">Select a source to reveal its controls.</p>,
  right: <p className="text-sm leading-6 text-zinc-500">Activity and selected-item details appear here.</p>,
};

const WorkspacePanelsContext = createContext<WorkspacePanelsContextValue | null>(null);

export function WorkspacePanelsProvider({ children }: { children: ReactNode }) {
  const [panels, setPanels] = useState<WorkspacePanels>(emptyPanels);
  const value = useMemo(() => ({ panels, setPanels }), [panels]);
  return <WorkspacePanelsContext.Provider value={value}>{children}</WorkspacePanelsContext.Provider>;
}

export function useWorkspacePanels() {
  const context = useContext(WorkspacePanelsContext);
  if (!context) throw new Error("useWorkspacePanels must be used inside WorkspacePanelsProvider.");
  return context;
}

export function useStagePanels(panels: WorkspacePanels) {
  const { setPanels } = useWorkspacePanels();
  useEffect(() => {
    setPanels(panels);
    return () => setPanels(emptyPanels);
  }, [panels, setPanels]);
}
