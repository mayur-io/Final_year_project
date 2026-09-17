import {
  SUPPORTED_EXTENSIONS,
  SUPPORTED_IMAGE_EXTENSIONS,
  SUPPORTED_VIDEO_EXTENSIONS,
} from "./supportedFormats";

export type AssetType =
  | "image"
  | "video"
  | "mesh"
  | "point-cloud"
  | "gaussian-splat"
  | "unknown";

export function getFileExtension(filename: string): string {
  const lastDot = filename.lastIndexOf(".");

  if (lastDot === -1) {
    return "";
  }

  return filename.substring(lastDot).toLowerCase();
}

export function isSupportedExtension(filename: string): boolean {
  const extension = getFileExtension(filename);

  return SUPPORTED_EXTENSIONS.includes(extension as never);
}

export function detectAssetType(filename: string): AssetType {
  const extension = getFileExtension(filename);

  if (SUPPORTED_IMAGE_EXTENSIONS.includes(extension as never)) {
    return "image";
  }

  if (SUPPORTED_VIDEO_EXTENSIONS.includes(extension as never)) {
    return "video";
  }

  return "unknown";
}
