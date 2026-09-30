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

  // Publish panel content whenever the stage recomputes it.
  useEffect(() => {
    setPanels(panels);
  }, [panels, setPanels]);

  // Clear only when the stage actually unmounts. Returning the reset from the
  // publish effect blanked the panels and immediately restored them on every
  // content change, which both flickered the sidebar and re-rendered the whole
  // workspace twice per update — enough to trip React's update-depth limit
  // while a stage was recomputing panels on a timer.
  useEffect(() => () => setPanels(emptyPanels), [setPanels]);
}
