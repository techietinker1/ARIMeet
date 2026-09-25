"use client";

import { useRouter } from "next/navigation";

import { Loader } from "@/components/loader";
import { MeetingCard } from "@/components/meeting-card";
import { useGetMeetings } from "@/hooks/use-get-meetings";

type MeetingListProps = {
  type: "ended" | "upcoming";
  emptyMessage?: string;
};

export const MeetingList = ({ type, emptyMessage }: MeetingListProps) => {
  const router = useRouter();
  const { endedMeetings, upcomingMeetings, isLoading } = useGetMeetings();

  const list = type === "ended" ? endedMeetings : upcomingMeetings;

  if (isLoading) return <Loader />;

  if (!list || list.length === 0) {
    return (
      <h1 className="text-sky-2 text-sm">
        {emptyMessage ?? (type === "ended" ? "No previous meetings." : "No upcoming meetings.")}
      </h1>
    );
  }

  return (
    <div className="grid grid-cols-1 gap-5 xl:grid-cols-2">
      {list.map((m) => (
        <MeetingCard
          key={m.id}
          title={m.topic || "Personal meeting"}
          date={new Date(m.scheduledFor).toLocaleString()}
          icon={type === "ended" ? "/icons/previous.svg" : "/icons/upcoming.svg"}
          isPreviousMeeting={type === "ended"}
          buttonText="Start"
          fullDescription={m.description || null}
          handleClick={() => router.push(`/meeting?roomId=${encodeURIComponent(m.roomId)}`)}
          link={`${process.env.NEXT_PUBLIC_BASE_URL || ""}/meeting?roomId=${encodeURIComponent(m.roomId)}`}
        />
      ))}
    </div>
  );
};
