"use client";

import { Button } from "@/components/ui/button";

const BreakoutError = ({ reset }: { reset: () => void }) => {
  return (
    <div className="flex min-h-screen flex-col items-center justify-center gap-4 bg-dark-2 px-4 text-center text-white">
      <h1 className="text-2xl font-semibold">We couldn&apos;t load this breakout room.</h1>
      <p className="max-w-md text-sm text-sky-2">
        Please try again. If the problem persists, return to the main meeting and
        ask the host to re-open the breakout.
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
              window.location.href = "/meeting";
            }
          }}
        >
          Back to main meeting
        </Button>
      </div>
    </div>
  );
};

export default BreakoutError;
