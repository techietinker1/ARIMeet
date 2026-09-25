"use client";

import Head from "next/head";
import Script from "next/script";
import { useEffect } from "react";
import { useUser } from "@clerk/nextjs";

// Ensure Ari Meet meeting styles are loaded even if the <link> tag fails.
// This imports the same CSS used by the original Express app.
import "../../public/css/meeting.css";

// Inline body markup from ari_meet/public/meeting.html (without scripts).
// This keeps all ids/classes and inline onclick handlers exactly as
// expected by /public/js/meeting.js.
const meetingBodyHtml = `
  <!-- Pre-join overlay: lets the user choose mic/camera state before entering -->
  <div class="prejoin-overlay" id="prejoinOverlay">
    <div class="prejoin-card">
      <h2 class="prejoin-title">Join meeting</h2>
      <p class="prejoin-subtitle">Choose how you&apos;d like to join before entering.</p>
      <p class="prejoin-subtitle">Tip: For the best experience, use a laptop instead of a phone.</p>

      <div class="prejoin-options">
        <label class="prejoin-option">
          <input type="checkbox" id="prejoinCam" checked />
          <span>Camera on</span>
        </label>
        <label class="prejoin-option">
          <input type="checkbox" id="prejoinMic" checked />
          <span>Microphone on</span>
        </label>
      </div>

      <button
        class="prejoin-button"
        id="prejoinButton"
        type="button"
        onclick="if (typeof window.startMeetingFromPrejoin === 'function') window.startMeetingFromPrejoin();"
      >
        Join now
      </button>
    </div>
  </div>

  <!-- Host Controls Panel (visible only to host) -->
  <div class="host-controls-panel" id="hostControlsPanel">
    <h3> ...  .    🧑‍💼 Host Controls</h3>
    <div id="hostControlsContent"></div>
  </div>

  <div class="meeting-container">
    <!-- Participant List -->
    <div class="participant-list" id="participantList">
      <div class="participant-list-header">
        <div class="flex-between-center">
          Participants
          <button class="close-btn" onclick="window.toggleParticipantList()" type="button">✕</button>
        </div>
      </div>
      <div id="participantItems"></div>
    </div>

    <!-- Videos Grid -->
    <div class="videos-grid" id="videosGrid"></div>

    <!-- Controls -->
    <div class="controls">
      <button id="micBtn" title="Toggle Microphone" onclick="window.toggleMic()" type="button">
        🎤
      </button>
      <button id="cameraBtn" title="Toggle Camera" onclick="window.toggleCamera()" type="button">
        📹
      </button>
      <button id="screenShareBtn" title="Share Screen" onclick="window.toggleScreenShare()" type="button">
        🖥️
      </button>
      <button id="chatBtn" title="Chat" onclick="window.toggleChat()" type="button">
        💬
      </button>
      <button title="Participants" onclick="window.toggleParticipantList()" type="button">
        👥
      </button>
      <button id="ccBtn" title="Live Captions" onclick="window.toggleLiveCaptions()" type="button">
        CC
      </button>
      <button id="reactionBtn" title="Send Reaction" onclick="window.openReactions()" type="button">
        😊
      </button>
      <button id="recordBtn" title="Start Recording" onclick="window.toggleRecording()" type="button">
        ⚫
      </button>
      <!-- Breakout rooms are host-only; hidden by default and shown when server confirms host -->
      <button id="breakoutBtn" style="display: none;" title="Breakout Rooms" onclick="window.toggleBreakoutRoomsPanel()" type="button">
        👨‍💻
      </button>
      <!-- Visible only when user is in a breakout room -->
      <button id="leaveBreakoutBtn" class="hidden" title="Leave Breakout Room" type="button" onclick="window.leaveBreakoutRoom()">
        🚪
      </button>
      <button class="danger" title="End Call" onclick="window.endMeeting()" type="button">
        📞
      </button>
    </div>

    <!-- Chat Panel -->
    <div class="chat-panel" id="chatPanel">
      <div class="chat-header">
        <div class="flex-between-center">
          Chat
          <button class="close-btn" onclick="window.toggleChat()" type="button">✕</button>
        </div>
      </div>
      <div class="chat-messages" id="chatMessages"></div>
      <div class="chat-input-area">
        <button class="chat-attach-btn" type="button" onclick="window.openImagePicker()">
          +
        </button>
        <input
          type="text"
          id="messageInput"
          placeholder="Type message..."
          onkeypress="window.handleChatKeypress(event)"
        />
        <button onclick="window.sendMessage()" class="chat-send-btn" type="button">
          Send
        </button>
      </div>
    </div>
  </div>
`;

export default function MeetingPage() {
  const { user } = useUser();
  const email =
    user?.primaryEmailAddress?.emailAddress ||
    (user?.emailAddresses && user.emailAddresses[0]?.emailAddress) ||
    "";
  const displayName =
    user?.username ||
    user?.fullName ||
    user?.firstName ||
    (email ? email.split("@")[0] : "");

  // Ensure initializeMeeting runs on client-side navigations as well.
  useEffect(() => {
    if (typeof window === "undefined") return;
    // Add a body class so meeting.css can override the dashboard background
    // and match the original Ari Meet dark theme.
    document.body.classList.add("ari-meet-meeting-page");

    return () => {
      document.body.classList.remove("ari-meet-meeting-page");
    };
  }, []);

  useEffect(() => {
    if (typeof window === "undefined") return;
    if (email) {
      try {
        window.localStorage.setItem("userEmail", email);
      } catch (e) {
        console.warn("Unable to persist userEmail to localStorage", e);
      }
    }
  }, [email]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    if (displayName) {
      try {
        window.localStorage.setItem("userName", displayName);
      } catch (e) {
        console.warn("Unable to persist userName to localStorage", e);
      }
    }
  }, [displayName]);

  useEffect(() => {
    const joinButton = document.getElementById("prejoinButton");
    if (!joinButton) return;

    const handleJoin = () => {
      let attempts = 0;
      const invokeStartMeeting = () => {
        if (typeof window.startMeetingFromPrejoin === "function") {
          window.startMeetingFromPrejoin();
          return;
        }

        if (attempts++ < 20) {
          window.setTimeout(invokeStartMeeting, 250);
        }
      };

      invokeStartMeeting();
    };

    joinButton.addEventListener("click", handleJoin);
    return () => joinButton.removeEventListener("click", handleJoin);
  }, []);

  return (
    <>
      <Head>
        <title>Ari Meet - Video Conference</title>
        <link rel="stylesheet" href="/css/meeting.css" />
      </Head>

      <div dangerouslySetInnerHTML={{ __html: meetingBodyHtml }} />

      {/* Load Socket.IO and meeting logic before/with hydration so
          the DOMContentLoaded handler in meeting.js runs correctly. */}
      {/* Inject Socket.IO backend URL so public/js/meeting.js knows where to connect. */}
      <Script
        id="socket-config"
        strategy="afterInteractive"
      >{`
        window.SMALO_SOCKET_URL = "${process.env.NEXT_PUBLIC_SOCKET_SERVER_URL || ""}";
      `}</Script>
      <Script
        src="https://cdn.socket.io/4.5.4/socket.io.min.js"
        strategy="afterInteractive"
      />
      <Script
        src="/js/meeting.js?v=20260918-join-fix"
        strategy="afterInteractive"
      />
    </>
  );
}
