"use client";

import { useEffect, useState } from "react";

export type MeetingDto = {
  id: string;
  roomId: string;
  topic?: string | null;
  description: string | null;
  hostEmail: string;
  scheduledFor: string; // ISO from API
  createdAt: string;
};

export const useGetMeetings = () => {
  const [meetings, setMeetings] = useState<MeetingDto[]>([]);
  const [isLoading, setIsLoading] = useState(false);

  useEffect(() => {
    const load = async () => {
      setIsLoading(true);
      try {
        const res = await fetch("/api/meetings");
        if (!res.ok) return;
        const data = await res.json();
        setMeetings(data.meetings || []);
      } catch (e) {
        console.error("useGetMeetings", e);
      } finally {
        setIsLoading(false);
      }
    };

    load();
  }, []);

  const now = new Date();

  const endedMeetings = meetings.filter((m) => {
    const when = new Date(m.scheduledFor);
    return when <= now;
  });

  const upcomingMeetings = meetings.filter((m) => {
    const when = new Date(m.scheduledFor);
    return when > now;
  });

  return { endedMeetings, upcomingMeetings, isLoading };
};
