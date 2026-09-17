import { AssetType } from "./fileUtils";

export type ProcessingPipeline =
  | "frame-extraction"
  | "image-normalization"
  | "360-conversion"
  | "unknown";

export function getAvailablePipelines(
  assetType:
    | "image"
    | "video"
    | "mesh"
    | "point-cloud"
    | "gaussian-splat"
    | "unknown",
): ProcessingPipeline[] {
  switch (assetType) {
    case "video":
      return ["frame-extraction"];

    case "image":
      return ["image-normalization"];

    default:
      return [];
  }
}
