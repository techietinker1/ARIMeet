"use client";

import { useEffect } from "react";

import { Button } from "@/components/ui/button";

const MeetingError = ({ reset }: { reset: () => void }) => {
  useEffect(() => {
    // Optionally we could log to an error reporting service here.
  }, []);

  return (
    <div className="flex min-h-screen flex-col items-center justify-center gap-4 bg-dark-2 px-4 text-center text-white">
      <h1 className="text-2xl font-semibold">Something went wrong in the meeting.</h1>
      <p className="max-w-md text-sm text-sky-2">
        Try reloading this meeting tab. If the issue keeps happening, check your
        network connection and camera/microphone permissions.
      </p>
      <div className="flex gap-3">
        <Button
          className="bg-blue-1 px-5 py-2 text-sm font-semibold"
          type="button"
          onClick={() => reset()}
        >
          Retry
        </Button>
        <Button
          variant="outline"
          type="button"
          className="border-dark-3 bg-transparent px-5 py-2 text-sm font-semibold text-sky-1 hover:bg-dark-3"
          onClick={() => {
            if (typeof window !== "undefined") {
              window.location.href = "/";
            }
          }}
        >
          Back to home
        </Button>
      </div>
    </div>
  );
};

export default MeetingError;
