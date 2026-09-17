"use client";

import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";

import { useProjectMedia } from "@/hooks/useProjectMedia";
import Viewer360 from "@/modules/360-player/components/Viewer360";
import type { Media } from "@/types/media";

import FrameGallery, { type GalleryFrame } from "./FrameGallery";
import ReconstructionStage from "./ReconstructionStage";
import UploadScene from "./upload/UploadScene";
import VideoPreparationStage from "./VideoPreparationStage";

interface UploadStageProps {
  projectId: string;
  onStateChange?: (state: string) => void;
}

function mediaUrl(projectId: string, filepath: string) {
  return `/api/projects/${projectId}/media/${filepath.replace(/\\/g, "/").split("/").map(encodeURIComponent).join("/")}`;
}

export default function UploadStage({ projectId, onStateChange }: UploadStageProps) {
  const { media, loading, refreshMedia } = useProjectMedia(projectId);
  const [frames, setFrames] = useState<string[]>([]);
  const [candidates, setCandidates] = useState<string[]>([]);
  const [convertedViews, setConvertedViews] = useState(0);
  const [summary, setSummary] = useState({ sampled: 0, rejected: 0 });
  const [reconstructionOpen, setReconstructionOpen] = useState(false);
  const [processJob, setProcessJob] = useState<{ pipeline: string; state: string } | null>(null);

  const refreshProcessed = useCallback(async () => {
    const response = await fetch(`/api/projects/${projectId}/processed`);
    if (!response.ok) return;
    const result = (await response.json()) as {
      frames: string[];
      candidates: string[];
      convertedVideos: string[];
    };
    setFrames(result.frames);
    setCandidates(result.candidates);
    setConvertedViews(result.convertedVideos.length);
  }, [projectId]);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      void refreshProcessed();
    }, 0);

    return () => window.clearTimeout(timer);
  }, [refreshProcessed]);

  useEffect(() => {
    async function refreshJob() {
      const response = await fetch(`/api/projects/${projectId}/process`);
      if (!response.ok) return;
      const result = await response.json() as { job: { pipeline: string; state: string } | null };
      setProcessJob(result.job);
      if (result.job?.state === "complete") void refreshProcessed();
    }
    void refreshJob();
    const timer = window.setInterval(() => void refreshJob(), 900);
    return () => window.clearInterval(timer);
  }, [projectId, refreshProcessed]);

  const source = media[0] ?? null;
  const galleryFrames = useMemo<GalleryFrame[]>(() => {
    const visibleFrames = frames.length ? frames : candidates;
    const visibleDirectory = frames.length ? "frames" : "candidates";
    if (source?.assetType === "IMAGE") {
      if (visibleFrames.length) return visibleFrames.map((filename) => ({ id: filename, filename, url: mediaUrl(projectId, `projects/${projectId}/processed/${visibleDirectory}/${filename}`) }));
      return media.map((item) => ({
        id: item.id,
        filename: item.filename,
        url: mediaUrl(projectId, item.filepath),
      }));
    }
    return visibleFrames.map((filename) => ({
      id: filename,
      filename,
      url: mediaUrl(
        projectId,
        `projects/${projectId}/processed/${visibleDirectory}/${filename}`,
      ),
    }));
  }, [candidates, frames, media, projectId, source?.assetType]);

  const processingFrames = Boolean(processJob && ["frame-extraction", "image-preparation"].includes(processJob.pipeline) && ["queued", "running", "cancelling"].includes(processJob.state));
  const processingConversion = Boolean(processJob?.pipeline === "360-conversion" && ["queued", "running", "cancelling"].includes(processJob.state));

  useEffect(() => {
    if (!processingFrames) return;

    void refreshProcessed();
    const timer = window.setInterval(() => void refreshProcessed(), 700);
    return () => window.clearInterval(timer);
  }, [processingFrames, refreshProcessed]);

  useEffect(() => {
    if (!source) onStateChange?.("Source capture");
    else if (reconstructionOpen) onStateChange?.("Reconstruction");
    else if (processingConversion) onStateChange?.("Creating projected views");
    else if (processingFrames) onStateChange?.(`Extracting frames · ${galleryFrames.length} visible`);
    else if (galleryFrames.length) onStateChange?.("Image gallery");
    else if (source.workspace === "VIEWER_360" && convertedViews === 0) onStateChange?.("360° projection");
    else onStateChange?.("Video preparation");
  }, [convertedViews, galleryFrames.length, onStateChange, processingConversion, processingFrames, reconstructionOpen, source]);

  let content: ReactNode = <UploadScene projectId={projectId} media={media} loading={loading} onUploadComplete={refreshMedia} />;
  if (source && reconstructionOpen) content = <ReconstructionStage projectId={projectId} frameCount={galleryFrames.length} />;
  else if (source && processingFrames) content = <FrameGallery projectId={projectId} frames={galleryFrames} processing summary={summary} onFramesChanged={() => void refreshProcessed()} />;
  else if (source?.assetType === "IMAGE") content = <FrameGallery projectId={projectId} frames={galleryFrames} processing={processingFrames} summary={summary} onReconstruct={() => setReconstructionOpen(true)} onFramesChanged={() => void refreshProcessed()} />;
  else if (source && galleryFrames.length > 0 && !processingFrames) content = <FrameGallery projectId={projectId} frames={galleryFrames} summary={summary} onReconstruct={() => setReconstructionOpen(true)} onFramesChanged={() => void refreshProcessed()} />;
  else if (source?.workspace === "VIEWER_360" && (convertedViews === 0 || processingConversion)) content = <Viewer360 projectId={projectId} media={[source]} onReturnToUploader={() => undefined} onConversionComplete={() => void refreshProcessed()} />;
  else if (source) content = <VideoPreparationStage projectId={projectId} video={source} convertedViews={convertedViews} onComplete={(nextSummary) => { setSummary(nextSummary); void refreshProcessed(); }} />;
  return <div className="stage-enter h-full min-h-0">{content}</div>;
}
