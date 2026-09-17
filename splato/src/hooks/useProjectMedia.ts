import { useCallback, useEffect, useState } from "react";
import { Media } from "@/types/media";

export function useProjectMedia(projectId: string) {
  const [media, setMedia] = useState<Media[]>([]);
  const [loading, setLoading] = useState(true);

  const refreshMedia = useCallback(async () => {
    try {
      const response = await fetch(`/api/projects/${projectId}/media`);

      if (!response.ok) {
        throw new Error("Failed to fetch media");
      }

      const data = await response.json();

      setMedia(data);
    } catch (error) {
      console.error(error);
    } finally {
      setLoading(false);
    }
  }, [projectId]);

  useEffect(() => {
    refreshMedia();
  }, [refreshMedia]);

  return {
    media,
    loading,
    refreshMedia,
  };
}
