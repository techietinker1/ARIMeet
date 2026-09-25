"use client";

import {
  CallControls,
  CallParticipantsList,
  CallStatsButton,
  CallingState,
  PaginatedGridLayout,
  SpeakerLayout,
  useCallStateHooks,
} from "@stream-io/video-react-sdk";
import { LayoutList, Users } from "lucide-react";
import { useRouter, useSearchParams } from "next/navigation";
import { useMemo, useState } from "react";

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";

import { EndCallButton } from "./end-call-button";
import { Loader } from "./loader";

type CallLayoutType = "grid" | "speaker-left" | "speaker-right";

export const MeetingRoom = () => {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [showParticipants, setShowParticipants] = useState(false);
  const [layout, setLayout] = useState<CallLayoutType>("speaker-left");

  const { useCallCallingState } = useCallStateHooks();
  const callingState = useCallCallingState();

  const meetingIdFromUrl = searchParams?.get("id") || "";
  const meetingName = useMemo(() => {
    const fallback = meetingIdFromUrl || "Live meeting";
    return fallback;
  }, [meetingIdFromUrl]);

  const isPersonalRoom = !!searchParams?.get("personal");

  if (callingState !== CallingState.JOINED) return <Loader />;

  const CallLayout = () => {
    switch (layout) {
      case "grid":
        return <PaginatedGridLayout />;
      case "speaker-right":
        return <SpeakerLayout participantsBarPosition="left" />;
      default:
        return <SpeakerLayout participantsBarPosition="right" />;
    }
  };

  return (
    <div className="relative h-screen w-full overflow-hidden bg-dark-2 text-white">
      {/* Top bar with meeting name */}
      <div className="flex items-center justify-between border-b border-dark-3 bg-black/40 px-4 py-2 text-xs sm:text-sm">
        <div className="flex flex-col gap-0.5">
          <span className="font-semibold text-sky-1">{meetingName}</span>
          <span className="text-[11px] text-sky-2">You&apos;re live · Check mic & camera before sharing</span>
        </div>
      </div>

      <div className="relative flex h-[calc(100vh_-_80px)] items-center justify-center pt-2 sm:pt-4">
        <div className="flex size-full max-w-[1000px] items-center">
          <CallLayout />
        </div>

        <div
          className={cn("ml-2 hidden h-[calc(100vh_-_86px)]", {
            "show-block": showParticipants,
          })}
        >
          <CallParticipantsList onClose={() => setShowParticipants(false)} />
        </div>
      </div>

      <div className="fixed bottom-0 flex w-full flex-wrap items-center justify-center gap-3 px-3 pb-3 pt-2 sm:gap-5 sm:px-0 sm:pb-4">
        <CallControls onLeave={() => router.push("/")} />

        <DropdownMenu>
          <div className="flex items-center">
            <DropdownMenuTrigger
              className="cursor-pointer rounded-2xl bg-[#19232D] px-4 py-2 hover:bg-[#4C535B]"
              title="Call layout"
            >
              <LayoutList size={20} className="text-white" />
            </DropdownMenuTrigger>
          </div>
          <DropdownMenuContent className="border-dark-1 bg-dark-1 text-white">
            {["Grid", "Speaker Left", "Speaker Right"].map((item, i) => (
              <div key={item + "-" + i}>
                <DropdownMenuItem
                  className="cursor-pointer"
                  onClick={() =>
                    setLayout(
                      item.toLowerCase().replace(" ", "-") as CallLayoutType
                    )
                  }
                >
                  {item}
                </DropdownMenuItem>

                <DropdownMenuSeparator className="border-dark-1" />
              </div>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>

        <CallStatsButton />

        <button
          onClick={() =>
            setShowParticipants((prevShowParticipants) => !prevShowParticipants)
          }
          title="Show participants"
        >
          <div className="cursor-pointer rounded-2xl bg-[#19232D] px-4 py-2 hover:bg-[#4C535B]">
            <Users size={20} className="text-white" />
          </div>
        </button>

        {!isPersonalRoom && <EndCallButton />}
      </div>
    </div>
  );
};
