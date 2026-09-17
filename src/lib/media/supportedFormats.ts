export const SUPPORTED_IMAGE_EXTENSIONS = [
  ".jpg",
  ".jpeg",
  ".png",
  ".webp",
  ".tif",
  ".tiff",
  ".bmp",
] as const;

export const SUPPORTED_VIDEO_EXTENSIONS = [
  ".mp4",
  ".mov",
  ".avi",
  ".mkv",
  ".webm",
] as const;

export const SUPPORTED_EXTENSIONS = [
  ...SUPPORTED_IMAGE_EXTENSIONS,
  ...SUPPORTED_VIDEO_EXTENSIONS,
] as const;

export const RECONSTRUCTION_INPUT_ACCEPT = SUPPORTED_EXTENSIONS.join(",");
export const VIDEO_INPUT_ACCEPT = SUPPORTED_VIDEO_EXTENSIONS.join(",");
export const IMAGE_SEQUENCE_INPUT_ACCEPT = SUPPORTED_IMAGE_EXTENSIONS.join(",");
