export type ViewerMode = "inside" | "sphere" | "flat";

export type MaskingProfile = "raw" | "recommended" | "custom";

export interface ObjectMaskingConfiguration {
  videoId: string;
  profile: MaskingProfile;

  /*
    Every profile removes dynamic objects. Profiles only change how much
    control the user receives before entering the masking stage.
  */
  removePeople: boolean;
  removeVehicles: boolean;
  removeOtherMovingObjects: boolean;

  sensitivity: number;
  temporalConsistency: number;

  startTime: number;
  endTime: number | null;
}

export interface ViewerState {
  mode: ViewerMode;
  playing: boolean;
  currentTime: number;
  duration: number;
}
