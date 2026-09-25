"use client";

import Head from "next/head";
import Script from "next/script";
import { useEffect } from "react";

// Inline body markup from ari_meet/public/breakout-room.html (without scripts).
// All ids/classes and inline handlers are preserved for
// /public/js/breakout-room.js.
const breakoutBodyHtml = `
  <div class="room-container">
    <header class="room-header">
      <h2 id="roomName">Breakout Room</h2>
      <p id="participantCount">Participants: 0</p>
      <button class="back-to-main" type="button" onclick="handleReturnToMainRoom()">
        ← Return to Main Room
      </button>
    </header>

    <main class="room-main">
      <section class="video-grid" id="videoGrid"></section>

      <aside class="chat-panel" id="chatPanel">
        <div class="chat-header">Room Chat</div>
        <div class="chat-messages" id="chatMessages"></div>
        <div class="chat-input-area">
          <input
            type="text"
            id="messageInput"
            placeholder="Type message..."
            onkeypress="handleChatKeypress(event)"
          />
          <button onclick="sendMessage()" class="chat-send-btn" type="button">
            Send
          </button>
        </div>
      </aside>
    </main>

    <footer class="bottom-controls">
      <button id="micBtn" onclick="toggleMic()" type="button">🎤</button>
      <button id="cameraBtn" onclick="toggleCamera()" type="button">📹</button>
      <button id="screenShareBtn" onclick="toggleScreenShare()" type="button">🖥️</button>
      <button id="chatBtn" onclick="toggleChat()" type="button">💬</button>
      <button class="danger" id="leaveRoomBtn" type="button" onclick="openLeaveModal()">Leave Room</button>
    </footer>
  </div>

  <!-- Leave Confirmation Modal -->
  <div id="leaveModal" class="modal hidden">
    <div class="modal-content">
      <h3>Leave Breakout Room?</h3>
      <p>You can rejoin from the main meeting if invited again.</p>
      <div class="modal-actions">
        <button onclick="closeLeaveModal()" type="button">Cancel</button>
        <button class="danger" onclick="handleLeaveRoom()" type="button">Leave</button>
      </div>
    </div>
  </div>
`;

export default function BreakoutRoomPage() {
  useEffect(() => {
    if (typeof window === "undefined") return;
    const anyWindow = window as any;
    if (typeof anyWindow.initializeAriBreakout === "function") {
      anyWindow.initializeAriBreakout();
    }
  }, []);

  return (
    <>
      <Head>
        <title>Ari Meet - Breakout Room</title>
        <link rel="stylesheet" href="/css/breakout-room.css" />
      </Head>

      <div dangerouslySetInnerHTML={{ __html: breakoutBodyHtml }} />

      <Script
        src="https://cdn.socket.io/4.5.4/socket.io.min.js"
        strategy="beforeInteractive"
      />
      <Script src="/js/breakout-room.js" strategy="beforeInteractive" />
    </>
  );
}
