"use client";

import { useUser } from "@clerk/nextjs";
import { StreamCall, StreamTheme } from "@stream-io/video-react-sdk";
import dynamic from "next/dynamic";
import { useState } from "react";

import { Loader } from "@/components/loader";
import { useGetCallById } from "@/hooks/use-get-call-by-id";

const MeetingRoom = dynamic(
  () => import("@/components/meeting-room").then((m) => m.MeetingRoom),
  {
    ssr: false,
    loading: () => <Loader />,
  }
);

const MeetingSetup = dynamic(
  () => import("@/components/meeting-setup").then((m) => m.MeetingSetup),
  {
    ssr: false,
    loading: () => <Loader />,
  }
);

type MeetingIdPageProps = {
  params: {
    id: string;
  };
};

const MeetingIdPage = ({ params }: MeetingIdPageProps) => {
  const [isSetupComplete, setIsSetupComplete] = useState(false);
  const { user, isLoaded } = useUser();

  const { call, isCallLoading } = useGetCallById(params.id);

  if (!isLoaded || isCallLoading) return <Loader />;

  return (
    <main className="h-screen w-full">
      <StreamCall call={call}>
        <StreamTheme>
          {!isSetupComplete ? (
            <MeetingSetup setIsSetupComplete={setIsSetupComplete} />
          ) : (
            <MeetingRoom />
          )}
        </StreamTheme>
      </StreamCall>
    </main>
  );
};

export default MeetingIdPage;
