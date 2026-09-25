"use client";

import { useUser } from "@clerk/nextjs";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import ReactDatePicker from "react-datepicker";

import { MeetingModal } from "@/components/modals/meeting-modal";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { useToast } from "@/components/ui/use-toast";

import { HomeCard } from "./home-card";
import { Loader } from "./loader";

type MeetingState =
  | "isScheduleMeeting"
  | "isScheduleCreated"
  | "isJoiningMeeting"
  | undefined;

export const MeetingTypeList = () => {
  const router = useRouter();
  const { toast } = useToast();
  const { user } = useUser();

  const [isLoading, setIsLoading] = useState(false);
  const [meetingLink, setMeetingLink] = useState<string | null>(null);
  const [hostMeetingLink, setHostMeetingLink] = useState<string | null>(null);
  const [meetingId, setMeetingId] = useState<string | null>(null);
  const [hostEmail, setHostEmail] = useState<string>("");
  const [meetingState, setMeetingState] = useState<MeetingState>(undefined);
  const [values, setValues] = useState({
    dateTime: new Date(),
    topic: "",
    link: "",
  });

  // Prefer the logged-in Clerk user's email as default host email
  useEffect(() => {
    if (!user || hostEmail) return;

    const emailFromUser =
      user.primaryEmailAddress?.emailAddress ||
      user.emailAddresses[0]?.emailAddress ||
      "";

    if (emailFromUser) {
      setHostEmail(emailFromUser);
    }
  }, [user, hostEmail]);

  const createMeeting = async (opts?: { instant?: boolean }) => {
    try {
      if (!opts?.instant && !values.dateTime) {
        toast({
          title: "Please select a date and time.",
          variant: "destructive",
        });
        return;
      }

      setIsLoading(true);

      const trimmedTopic = values.topic.trim();
      // For scheduled meetings, topic is required. For instant meetings,
      // fall back to a generic topic so you don't see an extra popup.
      if (!opts?.instant && !trimmedTopic) {
        toast({
          title: "Please enter a topic.",
          variant: "destructive",
        });
        setIsLoading(false);
        return;
      }

      // Follow Ari Meet pattern: generate room- style id
      const id = `room-${Math.random().toString(36).slice(2, 11)}`;
      const baseUrl = `/meeting?roomId=${encodeURIComponent(id)}`;
      const hostUrl = `${baseUrl}&host=true`;

      const effectiveHostEmail =
        hostEmail ||
        user?.primaryEmailAddress?.emailAddress ||
        user?.emailAddresses[0]?.emailAddress ||
        "";

      if (!effectiveHostEmail) {
        toast({
          title: "Host email is required.",
          variant: "destructive",
        });
        if (!opts?.instant) {
          setMeetingState("isScheduleMeeting");
        }
        setIsLoading(false);
        return;
      }

      const scheduledFor = opts?.instant ? new Date() : values.dateTime!;

      try {
        const res = await fetch("/api/meetings", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            roomId: id,
            topic: trimmedTopic || "Personal meeting",
            hostEmail: effectiveHostEmail,
            scheduledFor: scheduledFor.toISOString(),
          }),
        });

        const data = await res.json().catch(() => ({}));

        if (!res.ok || (data as any)?.success === false) {
          const message = (data as any)?.message || "Failed to save meeting.";
          throw new Error(message);
        }
      } catch (err) {
        console.error("CREATE_MEETING_API:", err);
        const message =
          err instanceof Error && err.message
            ? err.message
            : "Failed to save meeting.";
        toast({
          title: message,
          variant: "destructive",
        });
        if (!opts?.instant) {
          setMeetingState("isScheduleMeeting");
        }
        setIsLoading(false);
        return;
      }

      // Participant link (no host flag) is what we share/copy.
      setMeetingLink(baseUrl);
      // Host link (with host flag) is what the scheduler uses to join.
      setHostMeetingLink(hostUrl);
      setMeetingId(id);

      if (opts?.instant) {
        if (typeof window !== "undefined") {
          const emailToStore = effectiveHostEmail;

          if (emailToStore) {
            window.localStorage.setItem("userEmail", emailToStore);
          }

          // Force a full page load so Ari Meet host
          // features (host panel, breakout, recordings)
          // always initialise cleanly.
          window.location.href = hostUrl;
          return;
        }

        router.push(hostUrl);
      } else {
        setMeetingState("isScheduleCreated");
      }
    } catch (error) {
      console.error("CREATE_MEETING:", error);

      toast({
        title: "Failed to create meeting.",
        variant: "destructive",
      });
      if (!opts?.instant) {
        setMeetingState("isScheduleMeeting");
      } else {
        setMeetingState(undefined);
      }
    } finally {
      setIsLoading(false);
    }
  };

  // Loader is kept for future auth/loading gates; currently always ready.
  const isReady = true;
  if (!isReady) return <Loader />;

  const fullMeetingLink =
    (process.env.NEXT_PUBLIC_BASE_URL || "") + (meetingLink || "");

  return (
    <section className="grid grid-cols-1 gap-5 md:grid-cols-2 xl:grid-cols-4">
      <HomeCard
        img="/icons/add-meeting.svg"
        title="New Meeting"
        description="Start an instant meeting"
        handleClick={() => {
          createMeeting({ instant: true });
        }}
        className="bg-orange-1"
      />

      <HomeCard
        img="/icons/schedule.svg"
        title="Schedule Meeting"
        description="Plan your meeting"
        handleClick={() => setMeetingState("isScheduleMeeting")}
        className="bg-blue-1"
      />

      <HomeCard
        img="/icons/join-meeting.svg"
        title="Join Meeting"
        description="Via meeting link"
        handleClick={() => setMeetingState("isJoiningMeeting")}
        className="bg-purple-1"
      />
      {/* Step 1: Schedule form (topic + time + host email) */}
      <MeetingModal
        isOpen={meetingState === "isScheduleMeeting"}
        onClose={() => setMeetingState(undefined)}
        title={isLoading ? "Creating your meeting" : "Create meeting"}
        handleClick={() => createMeeting({ instant: false })}
        buttonText="Schedule Meeting"
        isLoading={isLoading}
      >
        <div className="flex flex-col gap-2.5">
          <label className="text-normal text-base leading-[22px] text-sky-2">
            Host email
            <Input
              type="email"
              placeholder="you@example.com"
              className="mt-2 border-none bg-dark-3"
              value={hostEmail}
              onChange={(e) => setHostEmail(e.target.value)}
            />
          </label>
        </div>

        <div className="flex flex-col gap-2.5">
          <label className="text-normal text-base leading-[22px] text-sky-2">
            Topic
            <Input
              type="text"
              placeholder="e.g. Sachin Tendulkar"
              className="mt-2 border-none bg-dark-3"
              value={values.topic}
              onChange={(e) => {
                setValues({ ...values, topic: e.target.value });
              }}
            />
          </label>
        </div>

        <div className="flex w-full flex-col gap-2.5">
          <label className="text-normal flex flex-col text-base leading-[22px] text-sky-2">
            Select Date and Time
            <ReactDatePicker
              selected={values.dateTime}
              onChange={(date) =>
                setValues({
                  ...values,
                  dateTime: date || new Date(),
                })
              }
              showTimeSelect
              timeFormat="HH:mm"
              timeIntervals={15}
              timeCaption="time"
              dateFormat="MMMM d, yyyy h:mm aa"
              className="mt-2 w-full rounded bg-dark-3 p-2"
            />
          </label>
        </div>
      </MeetingModal>

      {/* separate creating modal removed; schedule modal shows loading via disabled button */}

      {/* Step 2: Meeting summary after creation */}
      {meetingId && meetingLink && hostMeetingLink && (
        <MeetingModal
          isOpen={meetingState === "isScheduleCreated"}
          onClose={() => setMeetingState(undefined)}
          title="Meeting created"
          className="text-left"
          buttonText="Copy participant link"
          handleClick={() => {
            if (!fullMeetingLink) return;
            navigator.clipboard.writeText(fullMeetingLink);
            toast({ title: "Participant link copied." });
          }}
          image="/icons/checked.svg"
          buttonIcon="/icons/copy.svg"
          isLoading={isLoading}
        >
          <div className="space-y-3 text-sm text-sky-2">
            <p>
              <span className="font-semibold">Meeting ID:</span> {meetingId}
            </p>
            {hostEmail && (
              <p>
                <span className="font-semibold">Host Email:</span> {hostEmail}
              </p>
            )}

            <div className="mt-4 space-y-2">
              <p className="font-semibold text-white">Host link</p>
              <Input
                readOnly
                value={(process.env.NEXT_PUBLIC_BASE_URL || "") + hostMeetingLink}
                className="border-none bg-dark-3 text-xs"
                onFocus={(e) => e.currentTarget.select()}
              />
            </div>

            <div className="mt-3 space-y-2">
              <p className="font-semibold text-white">Participant link</p>
              <Input
                readOnly
                value={fullMeetingLink}
                className="border-none bg-dark-3 text-xs"
                onFocus={(e) => e.currentTarget.select()}
              />
            </div>
          </div>

          <div className="mt-4 flex flex-col gap-2 text-sm text-sky-2">
            <label className="text-normal text-base leading-[22px] text-sky-2">
              Invite participants (comma-separated emails)
              <Textarea
                id="inviteEmailsReact"
                rows={3}
                placeholder="email1@example.com, email2@example.com"
                className="mt-2 resize-none border-none bg-dark-3"
              />
            </label>
            <button
              className="mt-1 rounded-md bg-blue-1 px-3 py-2 text-sm font-medium text-white"
              type="button"
              onClick={async () => {
                const textarea = document.getElementById(
                  "inviteEmailsReact",
                ) as HTMLTextAreaElement | null;
                const raw = textarea?.value.trim() || "";
                const effectiveHostEmail =
                  hostEmail ||
                  user?.primaryEmailAddress?.emailAddress ||
                  user?.emailAddresses[0]?.emailAddress ||
                  "";

                if (!raw || !meetingId || !effectiveHostEmail) {
                  toast({
                    title:
                      "Add participant emails first (host email comes from your account or Host email field).",
                    variant: "destructive",
                  });
                  return;
                }

                const participantEmails = raw
                  .split(",")
                  .map((e) => e.trim())
                  .filter(Boolean);

                try {
                  const res = await fetch("/api/send-invite", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({
                      meetingId,
                      hostEmail: effectiveHostEmail,
                      participantEmails,
                    }),
                  });
                  const data = await res.json();
                  toast({
                    title: (data as any).success
                      ? "Invites sent successfully."
                      : (data as any).message || "Failed to send invites.",
                    variant: (data as any).success ? "default" : "destructive",
                  });
                } catch (err) {
                  console.error("SEND_INVITES:", err);
                  toast({
                    title: "Failed to send invites.",
                    variant: "destructive",
                  });
                }
              }}
            >
              Send invites
            </button>

            <div className="mt-2 flex gap-2">
              <button
                type="button"
                className="flex-1 rounded-md bg-green-500 px-3 py-2 text-sm font-semibold text-white"
                onClick={() => {
                  if (typeof window !== "undefined") {
                    const emailToStore =
                      hostEmail ||
                      user?.primaryEmailAddress?.emailAddress ||
                      user?.emailAddresses[0]?.emailAddress ||
                      "";

                    if (emailToStore) {
                      window.localStorage.setItem("userEmail", emailToStore);
                    }

                    // Use a hard navigation so the meeting
                    // page and Socket/WebRTC scripts
                    // bootstrap from a clean load.
                    window.location.href =
                      (process.env.NEXT_PUBLIC_BASE_URL || "") +
                      hostMeetingLink;
                    return;
                  }

                  router.push(hostMeetingLink);
                }}
              >
                Start as host
              </button>
            </div>
          </div>
        </MeetingModal>
      )}

      <MeetingModal
        isOpen={meetingState === "isJoiningMeeting"}
        onClose={() => setMeetingState(undefined)}
        title="Join a meeting"
        className="text-left"
        buttonText="Join"
        handleClick={() => {
          const link = values.link.trim();
          if (!link) {
            toast({
              title: "Please paste the meeting link.",
              variant: "destructive",
            });
            return;
          }

          if (typeof window !== "undefined") {
            window.location.href = link;
          } else {
            router.push(link);
          }
        }}
        isLoading={isLoading}
      >
        <div className="flex flex-col gap-2.5">
          <label className="text-normal text-base leading-[22px] text-sky-2">
            Paste meeting link
            <Input
              type="text"
              placeholder="Paste host or participant link here"
              className="mt-2 border-none bg-dark-3"
              value={values.link}
              onChange={(e) =>
                setValues({
                  ...values,
                  link: e.target.value,
                })
              }
            />
          </label>
        </div>
      </MeetingModal>
    </section>
  );
};
