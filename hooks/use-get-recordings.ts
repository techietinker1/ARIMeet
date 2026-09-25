"use client";

import { useEffect, useState } from "react";

export type RecordingDto = {
  id: string;
  type: "AUDIO" | "MEETING";
  userName?: string | null;
  userEmail?: string | null;
  filePath: string;
  fileName: string;
  savedAt: string;
  startedAt?: string | null;
  endedAt?: string | null;
  durationMs?: number | null;
  transcript?: string | null;
  meeting: {
    id: string;
    roomId: string;
    topic?: string | null;
    description?: string | null;
    hostEmail: string;
    scheduledFor: string;
    createdAt: string;
  };
};

export const useGetRecordings = () => {
  const [recordings, setRecordings] = useState<RecordingDto[]>([]);
  const [isLoading, setIsLoading] = useState(false);

  useEffect(() => {
    const loadRecordings = async () => {
      setIsLoading(true);
      try {
        const res = await fetch("/api/recordings?type=MEETING");
        if (!res.ok) {
          console.error("Failed to load recordings", res.status);
          setRecordings([]);
          return;
        }

        const data = await res.json();
        setRecordings(data.recordings || []);
      } catch (error) {
        console.error("useGetRecordings", error);
        setRecordings([]);
      } finally {
        setIsLoading(false);
      }
    };

    loadRecordings();
  }, []);

  return { recordings, isLoading };
};
