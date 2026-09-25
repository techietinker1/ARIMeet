"use client";

import { useEffect, useState } from "react";

import { cn } from "@/lib/utils";

type ParticipantSummary = {
  id: string;
  userName: string;
  email?: string;
  joinedAt?: string;
  isHost?: boolean;
};

type MeetingSummary = {
  id: string;
  createdAt?: string;
  participantCount: number;
  host: string | null;
  participants: ParticipantSummary[];
};

export const AriMeetingsList = () => {
  const [meetings, setMeetings] = useState<MeetingSummary[]>([]);
  const [isLoading, setIsLoading] = useState(false);

  useEffect(() => {
    const load = async () => {
      try {
        setIsLoading(true);
        const res = await fetch("/api/socket?summary=true");
        if (!res.ok) return;
        const data = await res.json();
        setMeetings(data.meetings || []);
      } catch (e) {
        console.error("Failed to load meeting summaries", e);
      } finally {
        setIsLoading(false);
      }
    };

    load();
    const id = setInterval(load, 10000);
    return () => clearInterval(id);
  }, []);

  if (isLoading && meetings.length === 0) {
    return (
      <div className="rounded-2xl bg-dark-1 p-4 text-xs text-sky-2">
        Loading live meetings...
      </div>
    );
  }

  if (!meetings.length) {
    return (
      <div className="rounded-2xl bg-dark-1 p-4 text-xs text-sky-2">
        No live Ari meetings right now.
      </div>
    );
  }

  return (
    <div className="rounded-2xl bg-dark-1 p-4 text-xs text-sky-2">
      <div className="mb-2 flex items-center justify-between">
        <p className="text-sm font-semibold text-white">Live Ari meetings</p>
        <span className="text-[11px] text-sky-2">Auto-refreshing every 10s</span>
      </div>

      <div className="flex flex-col gap-2">
        {meetings.map((m) => {
          const hostName = m.host || "Unknown host";
          const created = m.createdAt
            ? new Date(m.createdAt).toLocaleTimeString("en-US", {
                hour: "2-digit",
                minute: "2-digit",
              })
            : "";

          return (
            <a
              key={m.id}
              href={`/meeting?roomId=${encodeURIComponent(m.id)}`}
              className={cn(
                "flex flex-col gap-1 rounded-xl bg-dark-2 p-3 transition-colors hover:bg-[#111827]"
              )}
            >
              <div className="flex items-center justify-between gap-2">
                <div className="flex flex-col">
                  <span className="text-xs font-semibold text-white">
                    {m.id}
                  </span>
                  <span className="text-[11px] text-sky-2">
                    Host: {hostName}
                    {created && ` · Started at ${created}`}
                  </span>
                </div>

                <span className="rounded-full bg-[#020617] px-2 py-1 text-[11px] font-medium text-sky-1">
                  {m.participantCount} live
                </span>
              </div>

              {m.participants.length > 0 && (
                <div className="mt-1 flex flex-wrap gap-1">
                  {m.participants.slice(0, 4).map((p) => (
                    <span
                      key={p.id}
                      className={cn(
                        "rounded-full px-2 py-0.5 text-[11px]",
                        p.isHost ? "bg-blue-900/70 text-sky-1" : "bg-slate-800 text-sky-2"
                      )}
                    >
                      {p.userName}
                      {p.isHost ? " (Host)" : ""}
                    </span>
                  ))}
                  {m.participants.length > 4 && (
                    <span className="text-[11px] text-sky-3">
                      +{m.participants.length - 4} more
                    </span>
                  )}
                </div>
              )}
            </a>
          );
        })}
      </div>
    </div>
  );
};
