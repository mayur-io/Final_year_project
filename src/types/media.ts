export interface Media {
  id: string;
  filename: string;
  filepath: string;
  filesize: number;
  mimetype: string;

  assetType:
    | "IMAGE"
    | "VIDEO"
    | "MESH"
    | "POINT_CLOUD"
    | "GAUSSIAN_SPLAT"
    | "UNKNOWN";

  workspace: "UPLOADER" | "VIEWER_360";

  createdAt: string;
  projectId: string;
}
