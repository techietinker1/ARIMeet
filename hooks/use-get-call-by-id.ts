import { useStreamVideoClient, type Call } from "@stream-io/video-react-sdk";
import { useEffect, useState } from "react";

export const useGetCallById = (id: string | string[]) => {
  const [call, setCall] = useState<Call>();
  const [isCallLoading, setIsCallLoading] = useState(true);

  const streamClient = useStreamVideoClient();

  useEffect(() => {
    if (!streamClient) return;

    const callId = Array.isArray(id) ? id[0] : id;

    const loadCall = async () => {
      try {
        const streamCall = streamClient.call("default", callId);
        setCall(streamCall as Call);
      } finally {
        setIsCallLoading(false);
      }
    };

    loadCall();
  }, [streamClient, id]);

  return { call, isCallLoading };
};
