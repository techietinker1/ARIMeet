"use client";

import { AriMeetingsList } from "@/components/ari-meetings-list";
import { MeetingTypeList } from "@/components/meeting-type-list";
import { useGetCalls } from "@/hooks/use-get-calls";
import { useGetMeetings } from "@/hooks/use-get-meetings";

const HomePage = () => {
  const now = new Date();
  const { upcomingCalls } = useGetCalls();
  const { upcomingMeetings } = useGetMeetings();

  const time = now.toLocaleTimeString("en-US", {
    hour: "2-digit",
    minute: "2-digit",
  });

  const date = new Intl.DateTimeFormat("en-US", { dateStyle: "full" }).format(
    now
  );

  // Prefer scheduled meetings from our database for the banner,
  // fall back to Stream upcoming calls if there are no scheduled meetings.
  let bannerText = "No upcoming meeting";

  if (upcomingMeetings && upcomingMeetings.length > 0) {
    let nextTime: Date | undefined = undefined;

    upcomingMeetings.forEach((m) => {
      const when = new Date(m.scheduledFor);
      if (!nextTime || when < nextTime) {
        nextTime = when;
      }
    });

    if (nextTime) {
      const formatted = (nextTime as Date).toLocaleTimeString("en-US", {
        hour: "2-digit",
        minute: "2-digit",
      });
      bannerText = `Upcoming meeting at: ${formatted}`;
    }
  } else if (upcomingCalls && upcomingCalls.length > 0) {
    const lastCall = upcomingCalls[upcomingCalls.length - 1];
    const startsAt = lastCall.state?.startsAt;
    if (startsAt) {
      bannerText = `Upcoming meeting at: ${startsAt.toLocaleTimeString("en-US", {
        hour: "2-digit",
        minute: "2-digit",
      })}`;
    }
  }

  return (
    <section className="flex size-full flex-col gap-10 text-white">
      <div className="h-[300px] w-full rounded-[20px] bg-hero bg-cover">
        <div className="flex h-full flex-col justify-between max-md:px-5 max-md:py-8 lg:p-11">
          <h2 className="glassmorphism max-w-[270px] rounded py-2 text-center text-base font-normal">
            {bannerText}
          </h2>

          <div className="flex flex-col gap-2">
            <h1 className="text-4xl font-extrabold lg:text-7xl">{time}</h1>

            <p className="text-lg font-medium text-sky-1 lg:text-2xl">{date}</p>
          </div>
        </div>
      </div>

      <MeetingTypeList />

      {/* Live Ari meeting links + basic telemetry (who/when) */}
      <AriMeetingsList />
    </section>
  );
};

export default HomePage;
