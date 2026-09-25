// WebRTC Configuration
const rtcConfig = {
    iceServers: [
        { urls: ["stun:stun.l.google.com:19302"] },
        { urls: ["stun:stun1.l.google.com:19302"] },
        { urls: ["stun:stun2.l.google.com:19302"] },
        { urls: ["stun:stun3.l.google.com:19302"] },
        { urls: ["stun:stun4.l.google.com:19302"] },
        // Free TURN servers for better connectivity
        {
            urls: "turn:openrelay.metered.ca:80",
            username: "openrelayproject",
            credential: "openrelayproject"
        },
        {
            urls: "turn:openrelay.metered.ca:443",
            username: "openrelayproject",
            credential: "openrelayproject"
        },
        {
            urls: "turn:openrelay.metered.ca:443?transport=tcp",
            username: "openrelayproject",
            credential: "openrelayproject"
        }
    ],
    iceCandidatePoolSize: 10
};

// Global variables
let socket = null;
let socketListenersAttached = false;
let meetingInitialized = false;
let meetingInitializationInProgress = false;
let isBreakoutPage = false; // true when URL has breakoutId

async function ensureSocket() {
    if (socket) return;

    // Hit /api/socket once to initialise the Socket.IO server
    try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 8000);
        await fetch("/api/socket", { signal: controller.signal });
        clearTimeout(timeoutId);
    } catch (e) {
        console.error("Error initialising Socket.IO server:", e);
    }

    if (typeof io === "undefined") {
        console.error("Socket.IO client library (io) is not available. Realtime features disabled.");
        socket = {
            on() {},
            emit() {},
        };
        return;
    }

    const socketUrl = typeof window !== "undefined" && window.SMALO_SOCKET_URL ?
        window.SMALO_SOCKET_URL :
        undefined;

    socket = socketUrl ?
        io(socketUrl, {
            transports: ["websocket"],
            reconnection: true,
            reconnectionAttempts: Infinity,
            reconnectionDelay: 1000,
            reconnectionDelayMax: 5000,
        }) :
        io({
            transports: ["websocket"],
            reconnection: true,
            reconnectionAttempts: Infinity,
            reconnectionDelay: 1000,
            reconnectionDelayMax: 5000,
        });

    // Socket error handling & reconnection feedback
    socket.on("connect_error", (error) => {
        console.error("Socket connection error:", error);
        showNotification("❌ Connection error. Attempting to reconnect...");
    });

    socket.on("reconnect_attempt", (attempt) => {
        console.log("Socket reconnect attempt", attempt);
        if (attempt === 1) {
            showNotification("⚠️ Network issue detected. Reconnecting...");
        }
    });

    socket.on("reconnect", () => {
        console.log("Socket reconnected");
        showNotification("✅ Connection restored");
        // Re-join current meeting/breakout so participant list and peers recover.
        if (meetingInitialized && meetingId && userName) {
            const storedEmail = localStorage.getItem("userEmail") || "";
            socket.emit("join-meeting", {
                meetingId,
                userName,
                email: storedEmail,
                isHost,
                isBreakout: isBreakoutPage,
            });

            if (isInBreakoutRoom && currentBreakoutId) {
                socket.emit("join-breakout-room", {
                    meetingId,
                    breakoutId: currentBreakoutId,
                    userName,
                });
            }
        }
    });

    socket.on("reconnect_failed", () => {
        console.error("Socket reconnection failed");
        showNotification("❌ Unable to reconnect. Please check your internet.");
    });

    socket.on("disconnect", (reason) => {
        console.log("Socket disconnected:", reason);
        if (reason === "io server disconnect") {
            showNotification("⚠️ Disconnected from server");
        } else {
            showNotification("⚠️ Connection lost. Trying to reconnect...");
        }
    });

    socket.on("error", (error) => {
        console.error("Socket error:", error);
        showNotification("❌ Socket error: " + (error.message || "Unknown error"));
    });
}
let localStream;
let screenStream;
let peers = {}; // Map of userId -> peer connection
let userName = "";
let meetingId = "";
const LOCAL_USER_ID = "self";
let isRecording = false;
let mediaRecorder;
let recordedChunks = [];
let isMicOn = true;
let isCameraOn = true;
let cameraStates = {}; // socketId -> boolean (camera on/off)
let isScreenSharing = false;
let isHost = false;
let recordingsMap = {}; // userName -> file URL
let hostToken = null;
let mutedParticipants = {}; // socketId -> isMuted
let recordingParticipants = {}; // socketId -> isRecording
let lastKnownParticipants = [];
let initialMicOn = true;
let initialCameraOn = true;
let isLiveCaptionsOn = false;
let speechRecognition = null;
let liveCaptionsContainer = null;
let liveCaptionsTimeout = null;
let raisedHands = {}; // socketId -> hand raised
let isPrejoinJoining = false;
let waitingParticipants = []; // lobby users for this meeting (host view only)
let presenterId = null; // userId of active presenter (screen sharing)
let participantRemovalTimers = {}; // socketId -> timeout handle for delayed cleanup
let participantSocketByKey = {}; // participant identity key -> socketId

function getLocalParticipantId() {
    return (socket && socket.id) || LOCAL_USER_ID;
}

function getParticipantKey(participant = {}) {
    const email = typeof participant.email === "string" ? participant.email.trim().toLowerCase() : "";
    if (email) return `email:${email}`;

    const id = typeof participant.id === "string" ? participant.id : "";
    return id ? `id:${id}` : "";
}

function removeParticipantBySocketId(socketId) {
    if (!socketId) return;

    if (peers[socketId]) {
        try {
            peers[socketId].connection.close();
        } catch (e) {
            console.error("Error closing duplicate peer:", e);
        }
        delete peers[socketId];
    }

    scheduleVideoStreamRemoval(socketId);
    delete cameraStates[socketId];
    delete raisedHands[socketId];
}

function registerParticipantIdentity(participant = {}) {
    const key = getParticipantKey(participant);
    if (!key || !participant.id) return;

    const existingSocketId = participantSocketByKey[key];
    if (existingSocketId && existingSocketId !== participant.id) {
        removeParticipantBySocketId(existingSocketId);
    }

    participantSocketByKey[key] = participant.id;
}

function resetParticipantIdentityMap(participants = []) {
    const nextMap = {};

    participants.forEach((participant) => {
        const key = getParticipantKey(participant);
        if (!key || !participant.id) return;
        nextMap[key] = participant.id;
    });

    participantSocketByKey = nextMap;
}

async function initializeMeeting() {
    if (meetingInitialized || meetingInitializationInProgress) {
        console.log("initializeMeeting already called, skipping duplicate init");
        return;
    }
    meetingInitializationInProgress = true;
    const storedName = localStorage.getItem("userName") || "";
    const storedEmail = localStorage.getItem("userEmail") || "";
    userName = storedName || (storedEmail ? storedEmail.split("@")[0] : "Anonymous");
    const urlParams = new URLSearchParams(window.location.search);
    meetingId = urlParams.get("roomId") || generateMeetingId();
    const breakoutIdFromUrl = urlParams.get("breakoutId");
    isBreakoutPage = !!breakoutIdFromUrl;

    try {
        await ensureSocket();

        // Ensure breakout leave button is hidden on initial join
        isInBreakoutRoom = false;
        currentBreakoutId = null;
        updateLeaveBreakoutButton();

        // Get user's media
        localStream = await navigator.mediaDevices.getUserMedia({
            audio: true,
            video: { width: 640, height: 480 },
        });

        // Use a stable local tile id so UI state (camera avatar,
        // raised hand, etc.) does not depend on socket.id timing.
        addVideoStream(localStream, userName, true, getLocalParticipantId());

        // Apply initial mic/camera preferences from the pre-join screen
        isMicOn = initialMicOn;
        isCameraOn = initialCameraOn;

        if (localStream) {
            localStream.getAudioTracks().forEach((track) => {
                track.enabled = isMicOn;
            });
            localStream.getVideoTracks().forEach((track) => {
                track.enabled = isCameraOn;
            });
        }

        const micBtn = document.getElementById("micBtn");
        if (micBtn) {
            micBtn.classList.toggle("active", isMicOn);
            micBtn.textContent = isMicOn ? "🎤" : "🔇";
        }

        const cameraBtn = document.getElementById("cameraBtn");
        if (cameraBtn) {
            cameraBtn.classList.toggle("active", isCameraOn);
            cameraBtn.textContent = isCameraOn ? "📹" : "🚫";
        }
        // Ensure local tile matches initial camera state (show avatar if off)
        updateVideoPlaceholder(getLocalParticipantId(), isCameraOn, userName);
        isHost = window.location.search.includes("host=true");

        // Set initial host flag from URL; server will confirm via host-token.
        // This ensures that when you open a link with `host=true`, you
        // immediately see host UI (host panel + breakout button), even if the
        // host-token event arrives a bit later.
        document.body.setAttribute('data-is-host', isHost ? 'true' : 'false');

        // Hide the main recording button for participants so only the
        // host can start/stop meeting recordings from the control bar.
        const initialRecordBtn = document.getElementById("recordBtn");
        if (initialRecordBtn) {
            if (!isHost) {
                initialRecordBtn.style.display = "none";
            } else {
                initialRecordBtn.style.display = "";
            }
        }
        if (isHost) {
            // Show host-specific controls on initial load
            addRecordingsControlButton();
            showBreakoutButton();

            const panel = document.getElementById('hostControlsPanel');
            if (panel) {
                panel.classList.add('show');
                panel.style.display = '';
                panel.style.visibility = '';
                panel.style.pointerEvents = '';
                setTimeout(() => addPanelToggle(), 100);
            }
        }

        // Register host-token listener BEFORE emitting join-meeting to avoid
        // any race conditions.
        socket.on('host-token', (data) => {
            if (data && data.hostToken) {
                hostToken = data.hostToken;
                // Trust server: anyone receiving host-token is the host for this meeting
                isHost = true;
                document.body.setAttribute('data-is-host', 'true');

                const promotedRecordBtn = document.getElementById('recordBtn');
                if (promotedRecordBtn) {
                    promotedRecordBtn.style.display = '';
                }

                addRecordingsControlButton();
                showBreakoutButton();

                const panel = document.getElementById('hostControlsPanel');
                if (panel) {
                    panel.classList.add('show');
                    panel.style.display = '';
                    panel.style.visibility = '';
                    panel.style.pointerEvents = '';
                    setTimeout(() => addPanelToggle(), 100);
                }

                // If the host recordings panel is already open when we
                // are promoted to host, refresh it so it stops showing
                // the "Only host can view recordings" message.
                const recordingsPanel = document.getElementById('recordingsPanel');
                if (recordingsPanel) {
                    fetchAndRenderRecordings();
                }
            }
        });

        setupSocketListeners();

        socket.emit("join-meeting", {
            meetingId,
            userName,
            email: storedEmail,
            isHost,
            isBreakout: isBreakoutPage,
        });

        // If this URL represents a breakout room, immediately join it.
        if (breakoutIdFromUrl) {
            socket.emit("join-breakout-room", {
                meetingId,
                breakoutId: breakoutIdFromUrl,
                userName,
            });
        }

        // Now that the meeting has been initialised, hide the
        // prejoin overlay completely so the videos and controls
        // are fully visible (any waiting-for-host overlay will
        // appear separately for participants).
        const overlay = document.getElementById("prejoinOverlay");
        if (overlay) {
            overlay.style.display = "none";
            overlay.style.pointerEvents = "";
            overlay.style.opacity = "";
        }
        meetingInitialized = true;
        meetingInitializationInProgress = false;
    } catch (error) {
        console.error("Error accessing media devices:", error);
        const errorMsg = error.name === 'NotAllowedError' ?
            "Camera/microphone permissions denied. Please enable them in browser settings." :
            error.name === 'NotFoundError' ?
            "No camera/microphone device found. Please check your hardware." :
            "Cannot access camera/microphone. Check permissions.";
        showNotification("❌ " + errorMsg);
        // allow retry if initialisation failed
        meetingInitialized = false;
        meetingInitializationInProgress = false;
        // Restore the pre-join UI so the user can try again
        resetPrejoinJoinState();
        const overlay = document.getElementById("prejoinOverlay");
        if (overlay) {
            overlay.style.display = "flex";
        }
    }
}

// Expose initializer for SPA navigations (Next.js client routing)
window.initializeAriMeeting = initializeMeeting;

// Ensure control functions are available for inline HTML handlers
window.toggleMic = toggleMic;
window.toggleCamera = toggleCamera;
window.toggleScreenShare = toggleScreenShare;
window.toggleChat = toggleChat;
window.toggleParticipantList = toggleParticipantList;
window.toggleRecording = toggleRecording;
window.toggleBreakoutRoomsPanel = toggleBreakoutRoomsPanel;
window.leaveBreakoutRoom = leaveBreakoutRoom;
window.endMeeting = endMeeting;
window.handleChatKeypress = handleChatKeypress;
window.sendMessage = sendMessage;
window.toggleLiveCaptions = toggleLiveCaptions;
window.openReactions = openReactions;
window.openImagePicker = openImagePicker;

// Pre-join entry point called from the overlay button
window.startMeetingFromPrejoin = function() {
    if (isPrejoinJoining) {
        return;
    }
    isPrejoinJoining = true;

    const joinBtn = document.querySelector('.prejoin-button');
    if (joinBtn) {
        const originalText = joinBtn.textContent || 'Join now';
        joinBtn.dataset.originalText = originalText;
        // Keep the button enabled at the browser level. A stalled media or
        // socket request must not leave the mobile user with a dead control.
        joinBtn.disabled = false;
        joinBtn.setAttribute('aria-busy', 'true');
        joinBtn.style.opacity = '0.8';
        joinBtn.style.cursor = 'default';
        joinBtn.textContent = '';

        // Simple circular loader inside the button
        const spinner = document.createElement('span');
        spinner.className = 'prejoin-spinner';
        spinner.style.width = '18px';
        spinner.style.height = '18px';
        spinner.style.border = '2px solid rgba(249,250,251,0.3)';
        spinner.style.borderTopColor = '#f9fafb';
        spinner.style.borderRadius = '50%';
        spinner.style.display = 'inline-block';
        spinner.style.animation = 'prejoin-spin 0.8s linear infinite';
        joinBtn.appendChild(spinner);

        // For mobile users, also show a quick text label so it's
        // obvious that joining has started even before any other
        // popup appears.
        const joiningText = document.createElement('span');
        joiningText.className = 'prejoin-joining-text';
        joiningText.textContent = ' Joining…';
        joiningText.style.fontSize = '13px';
        joiningText.style.marginLeft = '8px';
        joinBtn.appendChild(joiningText);
    }

    const camCheckbox = document.getElementById("prejoinCam");
    const micCheckbox = document.getElementById("prejoinMic");
    const emailInput = document.getElementById("prejoinEmail");

    initialCameraOn = camCheckbox ? camCheckbox.checked : true;
    initialMicOn = micCheckbox ? micCheckbox.checked : true;

    // Persist email from prejoin, so that refresh/rejoin keeps
    // the same identity and the server can auto-admit.
    if (emailInput && emailInput.value.trim()) {
        const enteredEmail = emailInput.value.trim();
        localStorage.setItem("userEmail", enteredEmail);
        // Also default userName from email prefix if not already set
        if (!localStorage.getItem("userName")) {
            const prefix = enteredEmail.split("@")[0] || "";
            if (prefix) {
                localStorage.setItem("userName", prefix);
            }
        }
    }

    const overlay = document.getElementById("prejoinOverlay");
    if (overlay) {
        // Keep the overlay visible while we connect so the
        // user sees the loading state and then, for
        // participants, the "waiting for host" popup.
        overlay.style.pointerEvents = "none";
        overlay.style.opacity = "0.85";
    }

    // Failsafe: if for some reason the meeting does not
    // initialise within a few seconds (e.g. permission
    // dialog dismissed, unexpected error), automatically
    // reset the button so the user can try again without
    // needing to refresh.
    try {
        initializeMeeting();
    } catch (e) {
        console.error("Error starting meeting from prejoin:", e);
        resetPrejoinJoinState();
        const overlayAgain = document.getElementById("prejoinOverlay");
        if (overlayAgain) {
            overlayAgain.style.display = "flex";
        }
        return;
    }

    // Extra timeout guard in case initialise never completes
    // or throws after the first await.
    setTimeout(() => {
        if (meetingInitializationInProgress && !meetingInitialized) {
            meetingInitializationInProgress = false;
            resetPrejoinJoinState();
            const overlayAgain = document.getElementById("prejoinOverlay");
            if (overlayAgain) {
                overlayAgain.style.display = "flex";
            }
            showNotification("❌ Connection timed out. Please try again.");
        }
    }, 15000);
};

// Ensure the prejoin button works reliably on mobile/touch devices
// even if the inline onclick handler is ignored by the browser.
document.addEventListener('DOMContentLoaded', () => {
    const joinBtn = document.querySelector('.prejoin-button');
    if (!joinBtn) return;
    if (joinBtn.dataset.bound === 'true') return;
    joinBtn.dataset.bound = 'true';

    joinBtn.addEventListener('click', () => {
        if (typeof window.startMeetingFromPrejoin === 'function') {
            window.startMeetingFromPrejoin();
        }
    });

    joinBtn.addEventListener('touchstart', (e) => {
        // Prevent ghost double-clicks on some mobile browsers
        e.preventDefault();
        if (typeof window.startMeetingFromPrejoin === 'function') {
            window.startMeetingFromPrejoin();
        }
    }, { passive: false });
});

function resetPrejoinJoinState() {
    isPrejoinJoining = false;
    const joinBtn = document.querySelector('.prejoin-button');
    if (!joinBtn) return;

    joinBtn.disabled = false;
    joinBtn.removeAttribute('aria-busy');
    joinBtn.style.opacity = '';
    joinBtn.style.cursor = '';

    const originalText = joinBtn.dataset.originalText || 'Join now';
    joinBtn.textContent = originalText;

    // Remove any existing spinner elements
    const spinners = joinBtn.querySelectorAll('.prejoin-spinner');
    spinners.forEach((el) => el.remove());
}

// === Lobby waiting overlay for participants ===
function showWaitingForHostOverlay() {
    let overlay = document.getElementById('waitingForHostOverlay');
    if (!overlay) {
        overlay = document.createElement('div');
        overlay.id = 'waitingForHostOverlay';
        overlay.style.position = 'fixed';
        overlay.style.top = '0';
        overlay.style.left = '0';
        overlay.style.width = '100%';
        overlay.style.height = '100%';
        overlay.style.display = 'flex';
        overlay.style.alignItems = 'center';
        overlay.style.justifyContent = 'center';
        overlay.style.background = 'rgba(15,23,42,0.96)';
        overlay.style.zIndex = '350';
        overlay.style.color = '#e5e7eb';
        overlay.style.fontFamily = 'system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';

        const card = document.createElement('div');
        card.style.padding = '24px 28px';
        card.style.borderRadius = '16px';
        card.style.background = '#020617';
        card.style.boxShadow = '0 20px 60px rgba(0,0,0,0.85)';
        card.style.textAlign = 'center';
        card.style.maxWidth = '360px';
        card.style.width = '90%';

        const title = document.createElement('h2');
        title.textContent = 'Waiting for host to admit you';
        title.style.margin = '0 0 8px 0';
        title.style.fontSize = '18px';
        title.style.color = '#f9fafb';

        const subtitle = document.createElement('p');
        subtitle.textContent = 'You will join the meeting automatically once the host lets you in.';
        subtitle.style.margin = '0 0 16px 0';
        subtitle.style.fontSize = '13px';
        subtitle.style.color = '#9ca3af';

        const spinner = document.createElement('div');
        spinner.style.width = '28px';
        spinner.style.height = '28px';
        spinner.style.border = '3px solid rgba(148,163,184,0.35)';
        spinner.style.borderTopColor = '#38bdf8';
        spinner.style.borderRadius = '999px';
        spinner.style.margin = '0 auto';
        spinner.style.animation = 'prejoin-spin 0.9s linear infinite';

        card.appendChild(title);
        card.appendChild(subtitle);
        card.appendChild(spinner);
        overlay.appendChild(card);
        document.body.appendChild(overlay);
    } else {
        overlay.style.display = 'flex';
    }
}

function hideWaitingForHostOverlay() {
    const overlay = document.getElementById('waitingForHostOverlay');
    if (overlay) {
        overlay.style.display = 'none';
    }
}

function showMeetingClosedModal(message = 'Meeting closed by host') {
    const existing = document.getElementById('meetingClosedModal');
    if (existing) {
        const msg = existing.querySelector('.meeting-closed-message');
        if (msg) {
            msg.textContent = message;
        }
        existing.style.display = 'flex';
        return;
    }

    const modal = document.createElement('div');
    modal.id = 'meetingClosedModal';
    modal.style.position = 'fixed';
    modal.style.top = '0';
    modal.style.left = '0';
    modal.style.width = '100%';
    modal.style.height = '100%';
    modal.style.background = 'rgba(0,0,0,0.80)';
    modal.style.display = 'flex';
    modal.style.alignItems = 'center';
    modal.style.justifyContent = 'center';
    modal.style.zIndex = '400';

    const card = document.createElement('div');
    card.style.background = '#020617';
    card.style.borderRadius = '18px';
    card.style.padding = '22px 26px';
    card.style.boxShadow = '0 24px 80px rgba(0,0,0,0.9)';
    card.style.maxWidth = '360px';
    card.style.width = '90%';
    card.style.textAlign = 'center';
    card.style.color = '#e5e7eb';

    const title = document.createElement('h2');
    title.textContent = 'Meeting closed';
    title.style.margin = '0 0 8px 0';
    title.style.fontSize = '18px';
    title.style.color = '#f9fafb';

    const msg = document.createElement('p');
    msg.className = 'meeting-closed-message';
    msg.textContent = message;
    msg.style.margin = '0 0 18px 0';
    msg.style.fontSize = '13px';
    msg.style.color = '#9ca3af';

    const btn = document.createElement('button');
    btn.textContent = 'OK';
    btn.style.display = 'block';
    btn.style.margin = '0 auto';
    btn.style.width = 'auto';
    btn.style.height = 'auto';
    btn.style.padding = '8px 18px';
    btn.style.borderRadius = '999px';
    btn.style.border = 'none';
    btn.style.background = '#16a34a';
    btn.style.color = '#f9fafb';
    btn.style.cursor = 'pointer';
    btn.style.fontSize = '14px';
    btn.onclick = () => {
        window.location.href = '/';
    };

    card.appendChild(title);
    card.appendChild(msg);
    card.appendChild(btn);
    modal.appendChild(card);
    document.body.appendChild(modal);
}

function setupSocketListeners() {
    if (!socket || socketListenersAttached) return;
    socketListenersAttached = true;
    // User joined
    socket.on("user-joined", (data) => {
        // On breakout-specific pages we don't want to build WebRTC peers
        // against the main meeting; connections inside breakout are driven
        // by user-joined-breakout events instead.
        if (isBreakoutPage) return;

        updateParticipants(data.participants);
        registerParticipantIdentity(data);
        if (data.id === socket.id) return;
        if (peers[data.id]) return; // 🔥 duplicate peer stop

        // Another user just joined, so create a peer connection and
        // send them an offer. The newly joined client will respond via
        // the "offer" handler, which avoids double-offer races.
        createPeerConnection(data.id, data.userName, true);
    });
    // handle mic control
    socket.on("mic-control", ({ allowed }) => {
        localStream.getAudioTracks().forEach(t => t.enabled = allowed);
    });
    socket.on("force-mute", () => {
        localStream.getAudioTracks().forEach(track => {
            track.enabled = false;
        });

        isMicOn = false;

        const btn = document.getElementById("micBtn");
        btn.textContent = "🔇";
        btn.classList.remove("active");

        showNotification("Host muted your microphone");
    });

    // Receive offer
    socket.on("offer", async(data) => {
        const { offer, from, userName: remoteName } = data;
        if (!peers[from]) {
            createPeerConnection(from, remoteName, false);
        }

        const peerConnection = peers[from].connection;
        await peerConnection.setRemoteDescription(new RTCSessionDescription(offer));
        const answer = await peerConnection.createAnswer();
        await peerConnection.setLocalDescription(answer);

        socket.emit("answer", {
            to: from,
            answer: peerConnection.localDescription,
            from: socket.id,
        });
    });

    // Receive answer
    socket.on("answer", async(data) => {
        const { answer, from } = data;
        if (peers[from]) {
            const peerConnection = peers[from].connection;
            await peerConnection.setRemoteDescription(new RTCSessionDescription(answer));
        }
    });

    // Receive ICE candidate
    socket.on("ice-candidate", async(data) => {
        const { candidate, from } = data;
        if (peers[from]) {
            try {
                await peers[from].connection.addIceCandidate(new RTCIceCandidate(candidate));
            } catch (error) {
                console.error("Error adding ICE candidate:", error);
            }
        }
    });

    // User left
    socket.on("user-left", (data) => {
        console.log("User left:", data);
        if (peers[data.id]) {
            peers[data.id].connection.close();
            delete peers[data.id];
        }
        scheduleVideoStreamRemoval(data.id);
        delete cameraStates[data.id];
        delete raisedHands[data.id];
        Object.keys(participantSocketByKey).forEach((key) => {
            if (participantSocketByKey[key] === data.id) {
                delete participantSocketByKey[key];
            }
        });
        updateParticipants(data.participants);
        showNotification(`${data.userName} left the meeting`);
    });

    // Chat message (supports optional image payloads)
    socket.on("receive-message", (data = {}) => {
        addChatMessage(data.userName, data.message || "", data.image || "");
    });

    // Participant list refresh (e.g. host role changes)
    socket.on('participants-updated', (data = {}) => {
        if (!data || !Array.isArray(data.participants)) return;
        updateParticipants(data.participants);
    });

    // Emoji reactions (short-lived bubbles)
    socket.on('reaction', (data) => {
        if (!data || !data.emoji) return;
        const from = data.from || 'Someone';
        showReaction(data.emoji, from);
    });

    // Camera on/off state updates from other participants
    socket.on('camera-state-changed', (data = {}) => {
        const { socketId, cameraOn, userName: fromName } = data;
        if (!socketId || typeof cameraOn === 'undefined') return;
        const name = fromName || (peers[socketId] && peers[socketId].userName) || '';
        updateVideoPlaceholder(socketId, !!cameraOn, name);
    });

    // Host role updates (promote / demote)
    socket.on('host-role-updated', (data = {}) => {
        const { meetingId: evtMeetingId, targetId, isHost: targetIsHost, targetName } = data;
        if (!evtMeetingId || evtMeetingId !== meetingId || !targetId || typeof targetIsHost !== 'boolean') return;

        if (targetName) {
            if (targetIsHost) {
                showNotification(`🧑‍💼 ${targetName} is now a host`);
            } else {
                showNotification(`ℹ️ ${targetName} is no longer a host`);
            }
        }

        // If this client is the one whose role changed, update local host UI
        if (targetId === socket.id) {
            if (targetIsHost) {
                isHost = true;
                document.body.setAttribute('data-is-host', 'true');

                const promotedRecordBtn = document.getElementById('recordBtn');
                if (promotedRecordBtn) {
                    promotedRecordBtn.style.display = '';
                }

                addRecordingsControlButton();
                showBreakoutButton();

                const panel = document.getElementById('hostControlsPanel');
                if (panel) {
                    panel.classList.add('show');
                    panel.style.display = '';
                    panel.style.visibility = '';
                    panel.style.pointerEvents = '';
                    setTimeout(() => addPanelToggle(), 100);
                }
            } else {
                isHost = false;
                document.body.setAttribute('data-is-host', 'false');

                const recordBtn = document.getElementById('recordBtn');
                if (recordBtn) {
                    recordBtn.style.display = 'none';
                }

                const panel = document.getElementById('hostControlsPanel');
                if (panel) {
                    panel.classList.remove('show');
                    panel.style.display = 'none';
                }
            }
        }
    });

    // Legacy host-transfer events (kept for backwards-compatibility)
    socket.on('host-transferred', (data = {}) => {
        const { meetingId: evtMeetingId, newHostName } = data;
        if (!evtMeetingId || evtMeetingId !== meetingId) return;
        if (newHostName) {
            showNotification(`🧑‍💼 ${newHostName} is now the host`);
        }
    });

    // Persistent raise-hand indicator
    socket.on('hand-toggled', (data = {}) => {
        const { socketId, userName: fromName, raised } = data;
        if (!socketId) return;
        try {
            setHandRaised(socketId, !!raised);

            // Show a brief notification for other users so the
            // host clearly sees who raised or lowered their hand.
            if (fromName && fromName !== userName && typeof raised === 'boolean') {
                const action = raised ? 'raised' : 'lowered';
                showNotification(`${fromName} ${action} their hand`);
            }
        } catch (e) {
            console.error('Error handling hand-toggled event:', e);
        }
    });

    // Lobby (waiting room) events
    socket.on('waiting-for-host', () => {
        try {
            showWaitingForHostOverlay();
        } catch (e) {
            console.error('Error showing waiting-for-host overlay:', e);
        }
    });

    socket.on('admitted-to-meeting', () => {
        try {
            hideWaitingForHostOverlay();
        } catch (e) {
            console.error('Error hiding waiting-for-host overlay:', e);
        }
    });

    socket.on('lobby-updated', (data = {}) => {
        try {
            const { waiting } = data;
            if (!Array.isArray(waiting)) return;
            waitingParticipants = waiting;
            if (isHost) {
                renderHostControlsPanel(lastKnownParticipants);
            }
        } catch (e) {
            console.error('Error handling lobby-updated:', e);
        }
    });

    // When host closes the meeting for everyone
    socket.on('meeting-closed', (data = {}) => {
        try {
            const closedBy = data.closedBy || 'Host';
            showMeetingClosedModal(`${closedBy} has ended this meeting for everyone.`);

            // Also stop local media and socket
            try {
                if (localStream) {
                    localStream.getTracks().forEach((t) => t.stop());
                }
                if (screenStream) {
                    screenStream.getTracks().forEach((t) => t.stop());
                }
                if (socket && typeof socket.disconnect === 'function') {
                    socket.disconnect();
                }
            } catch (e) {
                console.error('Error cleaning up after meeting-closed:', e);
            }
        } catch (e) {
            console.error('Error handling meeting-closed:', e);
        }
    });

    socket.on('meeting-closed-by-host', () => {
        try {
            showMeetingClosedModal('Meeting closed by host');
            if (localStream) {
                localStream.getTracks().forEach((t) => t.stop());
            }
            if (screenStream) {
                screenStream.getTracks().forEach((t) => t.stop());
            }
            if (socket && typeof socket.disconnect === 'function') {
                socket.disconnect();
            }
        } catch (e) {
            console.error('Error handling meeting-closed-by-host:', e);
        }
    });

    // Recording notifications
    socket.on("recording-started", (data) => {
        showNotification(`${data.recordedBy} started recording`);
    });

    socket.on("recording-stopped", (data) => {
        showNotification(`${data.recordedBy} stopped recording`);
    });

    socket.on("recording-saved", (data) => {
        // data: { userName, file }
        if (data && data.userName && data.file) {
            recordingsMap[data.userName] = data.file;
            // refresh participant list to show links
            const participantsEl = document.getElementById("participantItems");
            if (participantsEl) {
                // request updated participants from server by forcing UI refresh via existing state
                // if the server sent participants elsewhere, updateParticipants will be called; otherwise we can attempt to refresh by emitting a lightweight event
                // For now, simply re-render using last known participants if available via meetings API is not present; caller will update soon.
                // A safe approach: find existing list entries and append links where possible
                // Only show download links to the host
                if (isHost) {
                    Array.from(participantsEl.querySelectorAll('.participant-item')).forEach(item => {
                        const nameEl = item.querySelector('strong');
                        if (!nameEl) return;
                        const name = nameEl.textContent;
                        if (recordingsMap[name]) {
                            if (!item.querySelector('.recording-link')) {
                                const a = document.createElement('a');
                                a.href = recordingsMap[name];
                                a.textContent = 'Download';
                                a.target = '_blank';
                                a.className = 'recording-link';
                                a.style.marginLeft = '8px';
                                item.appendChild(a);
                            }
                        }
                    });
                }
            }
        }
    });

    // Host receives an updated recordings list
    socket.on('recordings-updated', (data) => {
        if (!data || !data.recordings) return;
        // update local map
        recordingsMap = {};
        data.recordings.forEach(r => {
            recordingsMap[r.userName] = r.file;
        });
        // if panel is open, refresh it
        if (document.getElementById('recordingsPanel')) {
            renderRecordingsList(data.recordings);
        }
    });

    // Server instructs this client to start/stop recording (host requested)
    socket.on("start-audio-record", (data) => {
        const { fileName } = data || {};
        startAudioRecording(fileName);
    });

    socket.on("stop-audio-record", () => {
        if (mediaRecorder && mediaRecorder.state !== "inactive") {
            mediaRecorder.stop();
        }
    });

    // Screen share
    socket.on("screen-share-started", (data = {}) => {
        showNotification(`${data.userName || 'Someone'} started screen sharing`);
        if (data.userId) {
            presenterId = data.userId;
            applyPresenterLayout();
        }
    });

    socket.on("screen-share-stopped", (data = {}) => {
        showNotification("Screen sharing stopped");
        if (presenterId && data.userId === presenterId) {
            presenterId = null;
            applyPresenterLayout();
        }
    });

    // Breakout rooms created
    socket.on("breakout-rooms-created", (data) => {
        const { rooms, createdBy } = data;
        breakoutRoomsData = {};
        rooms.forEach(room => {
            breakoutRoomsData[room.id] = room;
        });
        showNotification(`👨‍💻 ${createdBy} created ${rooms.length} breakout room(s)`);
        // Re-render panel if it exists
        const panel = document.getElementById('breakoutRoomsPanel');
        if (panel) {
            renderBreakoutRooms(panel);
        }
    });

    // Participant assignment broadcast
    socket.on("participant-assigned-to-breakout", (data) => {
        showNotification(`👥 ${data.userName} assigned to ${data.roomName}`);
    });

    socket.on("room-assignment-updated", (data) => {
        const { allRooms } = data;
        if (allRooms) {
            breakoutRoomsData = {};
            allRooms.forEach(room => {
                breakoutRoomsData[room.id] = room;
            });
            // Re-render panel if it exists
            const panel = document.getElementById('breakoutRoomsPanel');
            if (panel) {
                renderBreakoutRooms(panel);
            }
            // If this user was auto-assigned via room update, show invite popup
            maybeShowBreakoutInviteFromRooms(allRooms);
        }
    });

    // Auto-assign notification + optional popup
    socket.on("participants-auto-assigned", (data) => {
        const { rooms } = data;
        breakoutRoomsData = {};
        rooms.forEach(room => {
            breakoutRoomsData[room.id] = room;
        });
        showNotification("✅ Participants auto-assigned");
        const panel = document.getElementById('breakoutRoomsPanel');
        if (panel) {
            renderBreakoutRooms(panel);
        }
        // When auto-assigned, also trigger invite popup for this user
        maybeShowBreakoutInviteFromRooms(rooms);
    });

    socket.on("user-returned-to-main", (data) => {
        const { userName: returnedName } = data;
        if (returnedName !== userName) {
            showNotification(`${returnedName} returned to main meeting`);
        }
    });

    // === BREAKOUT ROOM INVITES & ROOM LIFECYCLE ===

    // Receive direct invitation from server when host assigns this user
    socket.on("breakout-room-invite", (data) => {
        const { roomId, roomName, link, invitedBy, meetingId: inviteMeetingId } = data;
        showBreakoutRoomInvitation(roomName, link, invitedBy, roomId, inviteMeetingId);
    });

    // Confirmation when this client has joined a breakout room
    socket.on("joined-breakout-room", (data) => {
        const { breakoutId, meetingId: joinMeetingId, roomName, isHost: joiningAsHost } = data;
        currentBreakoutId = breakoutId;
        isInBreakoutRoom = true;

        // Close old WebRTC connections
        closeAllPeerConnections();

        // Clear video grid
        const grid = document.getElementById('videosGrid');
        if (grid) grid.innerHTML = '';

        // Re-add local video
        if (localStream) {
            addVideoStream(localStream, userName, true);
        }
        updateLeaveBreakoutButton();

        showNotification(`✅ Joined ${roomName}`);
        console.log("Joined breakout room:", breakoutId);

        if (joiningAsHost) {
            showNotification(`🧑‍💼 You (Host) joined ${roomName}`);
        }
    });

    // Someone else joined this breakout room
    socket.on("user-joined-breakout", (data) => {
        const { userName: remoteName, socketId } = data;
        if (socketId !== socket.id && !peers[socketId]) {
            createPeerConnection(socketId, remoteName, true);
        }
    });

    // Host joined this breakout room
    socket.on("host-joined-breakout", (data) => {
        const { userName: hostName } = data;
        showNotification(`🧑‍💼 ${hostName} (Host) joined the room`);
    });

    // Someone left this breakout room
    socket.on("user-left-breakout", (data) => {
        const { socketId, userName: leftUserName } = data;
        if (peers[socketId]) {
            peers[socketId].connection.close();
            delete peers[socketId];
        }
        scheduleVideoStreamRemoval(socketId);
        delete raisedHands[socketId];
        Object.keys(participantSocketByKey).forEach((key) => {
            if (participantSocketByKey[key] === socketId) {
                delete participantSocketByKey[key];
            }
        });
        if (leftUserName) {
            showNotification(`${leftUserName} left the room`);
        }
    });

    // Full list of breakout rooms (for host panel refresh)
    socket.on("breakout-rooms-list", (rooms) => {
        breakoutRoomsData = {};
        rooms.forEach(room => {
            breakoutRoomsData[room.id] = room;
        });
        const panel = document.getElementById('breakoutRoomsPanel');
        if (panel) {
            renderBreakoutRooms(panel);
        }
    });

    // Update rooms when participants move
    socket.on("breakout-rooms-updated", (data) => {
        const { rooms } = data;
        breakoutRoomsData = {};
        rooms.forEach(room => {
            breakoutRoomsData[room.id] = room;
        });
        const panel = document.getElementById('breakoutRoomsPanel');
        if (panel) {
            renderBreakoutRooms(panel);
        }
        // Also refresh host controls so Individual Controls keeps showing
        // users who moved into breakout rooms.
        if (isHost) {
            renderHostControlsPanel(lastKnownParticipants);
        }
    });

    // Room closed by host – send everyone back to main
    socket.on("breakout-room-closing", (data) => {
        const { roomName, returnTo, message } = data;
        showNotification(`⏱️ ${message}`);
        setTimeout(() => {
            window.location.href = `/meeting?roomId=${encodeURIComponent(returnTo || meetingId)}`;
        }, 1500);
    });

    socket.on("all-breakout-rooms-closing", (data) => {
        const { returnTo, message } = data;
        showNotification(`🔴 ${message}`);
        setTimeout(() => {
            window.location.href = `/meeting?roomId=${encodeURIComponent(returnTo || meetingId)}`;
        }, 1500);
    });

    socket.on("returned-to-main-room", (data) => {
        const { meetingId: returnMeetingId } = data;
        showNotification("✅ Returned to main meeting");
        isInBreakoutRoom = false;
        currentBreakoutId = null;
        updateLeaveBreakoutButton();
    });

    // Room closed notifications (host + observers)
    socket.on("breakout-room-closed", (data) => {
        const { roomId, roomName, closedBy, remainingRooms } = data;
        showNotification(`🔴 ${closedBy} closed "${roomName}"`);

        if (remainingRooms) {
            breakoutRoomsData = {};
            remainingRooms.forEach(room => {
                breakoutRoomsData[room.id] = room;
            });
        } else {
            delete breakoutRoomsData[roomId];
        }

        const panel = document.getElementById('breakoutRoomsPanel');
        if (panel) {
            renderBreakoutRooms(panel);
        }
    });

    socket.on("all-breakout-rooms-closed", (data) => {
        const { count, closedBy } = data;
        showNotification(`🔴 ${closedBy} closed all ${count} breakout room(s)`);
        breakoutRoomsData = {};
        const panel = document.getElementById('breakoutRoomsPanel');
        if (panel) {
            renderBreakoutRooms(panel);
        }
    });
}

function createPeerConnection(userId, remoteName, initiator) {
    try {
        const peerConnection = new RTCPeerConnection(rtcConfig);
        peers[userId] = { connection: peerConnection, userName: remoteName };

        // Add local tracks - use screen share track if currently sharing
        const streamToSend = isScreenSharing && screenStream ? screenStream : localStream;

        // Always add audio from localStream
        localStream.getAudioTracks().forEach((track) => {
            peerConnection.addTrack(track, localStream);
        });

        // Add video from appropriate stream (screen or camera)
        streamToSend.getVideoTracks().forEach((track) => {
            peerConnection.addTrack(track, streamToSend);
        });

        // Handle remote stream
        peerConnection.ontrack = (event) => {
            const existingVideo = document.getElementById(`video-${userId}`);
            if (existingVideo) {
                if (existingVideo.srcObject !== event.streams[0]) {
                    existingVideo.srcObject = event.streams[0];
                }
                return;
            }

            addVideoStream(event.streams[0], remoteName, false, userId);
        };

        // Handle ICE candidates
        peerConnection.onicecandidate = (event) => {
            if (event.candidate) {
                socket.emit("ice-candidate", {
                    to: userId,
                    candidate: event.candidate,
                    from: socket.id,
                });
            }
        };

        // Connection state changes with error handling
        peerConnection.onconnectionstatechange = () => {
            console.log("Peer connection state:", peerConnection.connectionState);

            // Ignore stale callbacks from an older connection that was
            // already replaced by a newer peer object for this user.
            if (!peers[userId] || peers[userId].connection !== peerConnection) {
                return;
            }

            if (peerConnection.connectionState === "failed" ||
                peerConnection.connectionState === "closed") {
                console.log("Peer connection closed/failed:", userId);
                delete peers[userId];
                scheduleVideoStreamRemoval(userId);
            } else if (peerConnection.connectionState === "disconnected") {
                console.warn("Peer temporarily disconnected:", userId);
                showNotification("⚠️ Connection unstable with a participant");
            }
        };

        // ICE connection state changes
        peerConnection.oniceconnectionstatechange = () => {
            console.log("ICE connection state:", peerConnection.iceConnectionState);
            if (peerConnection.iceConnectionState === "failed") {
                console.error("ICE connection failed for", userId);
                try {
                    peerConnection.restartIce();
                } catch (e) {
                    console.error("ICE restart failed for", userId, e);
                }
                showNotification("⚠️ Connection issues detected");
            }
        };

        // Create and send offer if initiator
        if (initiator) {
            (async() => {
                try {
                    const offer = await peerConnection.createOffer();
                    await peerConnection.setLocalDescription(offer);
                    socket.emit("offer", {
                        to: userId,
                        offer: peerConnection.localDescription,
                        from: socket.id,
                        userName,
                    });
                } catch (err) {
                    console.error("Error creating offer:", err);
                    showNotification("❌ Failed to establish connection");
                }
            })();
        }
    } catch (err) {
        console.error("Error creating peer connection:", err);
        showNotification("❌ Failed to create peer connection");
    }
}

function addVideoStream(stream, name, isLocal = false, userId = socket.id) {
    if (participantRemovalTimers[userId]) {
        clearTimeout(participantRemovalTimers[userId]);
        delete participantRemovalTimers[userId];
    }

    if (document.getElementById(`card-${userId}`)) {
        return;
    }
    const videoElement = document.createElement("video");
    videoElement.id = `video-${userId}`;
    videoElement.autoplay = true;
    videoElement.playsinline = true;
    videoElement.muted = isLocal;
    videoElement.srcObject = stream;

    const videoCard = document.createElement("div");
    videoCard.className = "video-card";
    videoCard.id = `card-${userId}`;

    const label = document.createElement("div");
    label.className = "video-label";
    label.textContent = isLocal ? `${name} (You)` : name;

    videoCard.appendChild(videoElement);
    videoCard.appendChild(label);

    // Avatar placeholder (first letter) when camera is off
    let avatar = document.createElement('div');
    avatar.className = 'video-avatar-placeholder';
    const initial = (name || '?').trim().charAt(0).toUpperCase() || '?';
    avatar.textContent = initial;
    avatar.style.position = 'absolute';
    avatar.style.inset = '0';
    avatar.style.display = 'none';
    avatar.style.alignItems = 'center';
    avatar.style.justifyContent = 'center';
    avatar.style.fontSize = '42px';
    avatar.style.fontWeight = '700';
    avatar.style.color = '#e5e7eb';
    avatar.style.background = 'radial-gradient(circle at 30% 20%, #38bdf8, #0f172a)';
    avatar.style.zIndex = '5';
    videoCard.appendChild(avatar);

    const grid = document.getElementById("videosGrid");
    if (!grid) return;
    grid.appendChild(videoCard);
    updateVideoGridLayout();
    applyPresenterLayout();

    // Default camera state: local respects current isCameraOn, remote assumed on
    const cameraOn = isLocal ? isCameraOn : true;
    cameraStates[userId] = cameraOn;
    updateVideoPlaceholder(userId, cameraOn, name);

    // If this participant already has a raised hand in our
    // local state (e.g., event arrived before their tile was
    // created), reflect it visually.
    if (raisedHands[userId]) {
        setHandRaised(userId, true);
    }
}

function removeVideoStream(userId) {
    if (participantRemovalTimers[userId]) {
        clearTimeout(participantRemovalTimers[userId]);
        delete participantRemovalTimers[userId];
    }

    const videoCard = document.getElementById(`card-${userId}`);
    if (videoCard) {
        videoCard.remove();
    }
    updateVideoGridLayout();
    applyPresenterLayout();
}

function scheduleVideoStreamRemoval(userId, delayMs = 4000) {
    if (!userId) return;

    if (participantRemovalTimers[userId]) {
        clearTimeout(participantRemovalTimers[userId]);
    }

    participantRemovalTimers[userId] = setTimeout(() => {
        delete participantRemovalTimers[userId];

        // If a fresh peer exists (reconnect/re-negotiate), do not remove tile.
        if (peers[userId]) return;

        // If server still reports this participant, avoid premature cleanup.
        const stillInParticipantList = Array.isArray(lastKnownParticipants) &&
            lastKnownParticipants.some((p) => p && p.id === userId);
        if (stillInParticipantList) return;

        removeVideoStream(userId);
    }, delayMs);
}

function updateVideoPlaceholder(userId, cameraOn, name) {
    const card = document.getElementById(`card-${userId}`);
    if (!card) return;
    const videoEl = card.querySelector('video');
    let avatar = card.querySelector('.video-avatar-placeholder');

    if (!avatar) {
        avatar = document.createElement('div');
        avatar.className = 'video-avatar-placeholder';
        const initial = (name || '?').trim().charAt(0).toUpperCase() || '?';
        avatar.textContent = initial;
        avatar.style.position = 'absolute';
        avatar.style.inset = '0';
        avatar.style.display = 'none';
        avatar.style.alignItems = 'center';
        avatar.style.justifyContent = 'center';
        avatar.style.fontSize = '42px';
        avatar.style.fontWeight = '700';
        avatar.style.color = '#e5e7eb';
        avatar.style.background = 'radial-gradient(circle at 30% 20%, #38bdf8, #0f172a)';
        avatar.style.zIndex = '5';
        card.appendChild(avatar);
    }

    cameraStates[userId] = !!cameraOn;

    if (cameraOn) {
        avatar.style.display = 'none';
        if (videoEl) {
            videoEl.style.opacity = '1';
        }
    } else {
        avatar.style.display = 'flex';
        if (videoEl) {
            videoEl.style.opacity = '0';
        }
    }
}

function updateVideoGridLayout() {
    const grid = document.getElementById("videosGrid");
    if (!grid) return;

    const count = grid.querySelectorAll(".video-card").length;
    if (count === 0) {
        grid.style.gridTemplateColumns = "minmax(0, 1fr)";
        return;
    }
    const width = window.innerWidth || document.documentElement.clientWidth || 1024;
    const isMobile = width < 768;

    // Mobile (narrow screens): stack up to 2 participants vertically
    // so each tile stays large; then move to 2 columns for bigger groups.
    let cols;
    if (isMobile) {
        if (count <= 2) {
            cols = 1;
        } else if (count <= 4) {
            cols = 2;
        } else if (count <= 9) {
            cols = 2;
        } else {
            cols = 3;
        }
    } else {
        // Desktop / tablet: balanced gallery layout.
        if (count <= 1) {
            cols = 1;
        } else if (count === 2) {
            cols = 2;
        } else if (count <= 4) {
            cols = 2;
        } else if (count <= 6) {
            cols = 3;
        } else if (count <= 9) {
            cols = 3;
        } else {
            cols = 4;
        }
    }

    grid.style.gridTemplateColumns = `repeat(${cols}, minmax(0, 1fr))`;
    grid.style.justifyItems = "center";
}

// Presenter layout: when someone is screen sharing, show their
// tile as a large main video and everyone else as smaller
// thumbnails in a strip, similar to Zoom.
function applyPresenterLayout() {
    const grid = document.getElementById('videosGrid');
    if (!grid) return;

    const cards = Array.from(grid.querySelectorAll('.video-card'));
    if (!presenterId || cards.length <= 1) {
        grid.classList.remove('presenter-layout');
        cards.forEach((card) => {
            card.classList.remove('presenter-main', 'presenter-thumb');
            card.style.order = '';
        });
        return;
    }

    grid.classList.add('presenter-layout');

    cards.forEach((card) => {
        const isPresenter = card.id === `card-${presenterId}`;
        card.classList.remove('presenter-main', 'presenter-thumb');
        if (isPresenter) {
            card.classList.add('presenter-main');
            card.style.order = '2';
        } else {
            card.classList.add('presenter-thumb');
            card.style.order = '1';
        }
    });
}

function setHandRaised(userId, raised) {
    if (!userId) return;
    raisedHands[userId] = !!raised;

    const card = document.getElementById(`card-${userId}`);
    if (!card) return;

    let badge = card.querySelector('.hand-raise-badge');

    if (raised) {
        if (!badge) {
            badge = document.createElement('div');
            badge.className = 'hand-raise-badge';
            badge.textContent = '✋';
            badge.style.position = 'absolute';
            badge.style.top = '8px';
            badge.style.right = '8px';
            badge.style.fontSize = '22px';
            badge.style.zIndex = '15';
            badge.style.pointerEvents = 'none';
            badge.style.textShadow = '0 2px 4px rgba(0,0,0,0.6)';
            badge.style.filter = 'drop-shadow(0 2px 4px rgba(0,0,0,0.7))';
            card.appendChild(badge);
        }
    } else if (badge) {
        badge.remove();
    }
}

function toggleMic() {
    if (localStream) {
        isMicOn = !isMicOn;
        localStream.getAudioTracks().forEach((track) => {
            track.enabled = isMicOn;
        });

        const btn = document.getElementById("micBtn");
        btn.classList.toggle("active", isMicOn);
        btn.textContent = isMicOn ? "🎤" : "🔇";

        // If the mic is turned off while live captions are on,
        // automatically stop SpeechRecognition and hide the CC UI
        // so captions do not continue while muted.
        if (!isMicOn && isLiveCaptionsOn) {
            isLiveCaptionsOn = false;
            try {
                if (speechRecognition) {
                    speechRecognition.onresult = null;
                    speechRecognition.onend = null;
                    speechRecognition.onerror = null;
                    speechRecognition.stop();
                }
            } catch (e) {
                console.error('Error stopping SpeechRecognition on mic mute:', e);
            }

            if (liveCaptionsTimeout) {
                clearTimeout(liveCaptionsTimeout);
                liveCaptionsTimeout = null;
            }

            const box = ensureLiveCaptionsContainer();
            box.style.display = 'none';
            box.textContent = '';

            const ccBtn = document.getElementById('ccBtn');
            if (ccBtn) {
                ccBtn.classList.remove('cc-on');
            }

            showNotification('⏹️ Live captions off (mic muted)');
        }
    }
}

function toggleCamera() {
    if (localStream) {
        isCameraOn = !isCameraOn;
        localStream.getVideoTracks().forEach((track) => {
            track.enabled = isCameraOn;
        });

        const btn = document.getElementById("cameraBtn");
        btn.classList.toggle("active", isCameraOn);
        btn.textContent = isCameraOn ? "📹" : "🚫";

        // Update local placeholder and inform others
        updateVideoPlaceholder(getLocalParticipantId(), isCameraOn, userName);
        if (socket && typeof socket.emit === 'function') {
            socket.emit('camera-state-changed', { cameraOn: isCameraOn });
        }
    }
}

async function toggleScreenShare() {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getDisplayMedia) {
        showNotification("❌ Screen sharing isn't supported on this device or browser");
        return;
    }

    if (!isScreenSharing) {
        try {
            screenStream = await navigator.mediaDevices.getDisplayMedia({
                video: {
                    cursor: "always",
                    displaySurface: "monitor"
                },
                audio: false,
            });

            const screenTrack = screenStream.getVideoTracks()[0];
            const peerIds = Object.keys(peers);

            // Replace video track on ALL peer connections
            let replacedCount = 0;
            for (const peerId of peerIds) {
                const peer = peers[peerId];
                if (peer && peer.connection) {
                    const senders = peer.connection.getSenders();
                    const videoSender = senders.find(s => s.track && s.track.kind === "video");
                    if (videoSender) {
                        try {
                            await videoSender.replaceTrack(screenTrack);
                            replacedCount++;
                            console.log(`Replaced video track for peer ${peerId}`);
                        } catch (e) {
                            console.error(`Failed to replace track for peer ${peerId}:`, e);
                        }
                    } else {
                        // If no video sender exists, add the track
                        try {
                            peer.connection.addTrack(screenTrack, screenStream);
                            replacedCount++;
                            console.log(`Added screen track for peer ${peerId}`);
                        } catch (e) {
                            console.error(`Failed to add track for peer ${peerId}:`, e);
                        }
                    }
                }
            }

            // Update local video element to show screen share
            const localVideoCard = document.getElementById(`card-${getLocalParticipantId()}`);
            if (localVideoCard) {
                const localVideo = localVideoCard.querySelector('video');
                if (localVideo) {
                    localVideo.srcObject = screenStream;
                }
            }

            // Show a small self-preview (camera) in the corner while sharing
            showLocalCameraPreview();

            isScreenSharing = true;

            // Update button appearance
            const screenShareBtn = document.getElementById('screenShareBtn');
            if (screenShareBtn) {
                screenShareBtn.style.background = '#ef4444';
                screenShareBtn.textContent = '🛑';
                screenShareBtn.title = 'Stop Sharing';
            }

            socket.emit("screen-share-start");

            if (peerIds.length === 0) {
                showNotification("✅ Screen sharing started");
            } else {
                showNotification(`✅ Screen sharing with ${replacedCount} participant${replacedCount !== 1 ? 's' : ''}`);
            }

            // Handle when user stops screen share from browser UI
            screenTrack.onended = () => {
                stopScreenShare();
            };
        } catch (error) {
            if (error.name === 'NotAllowedError') {
                console.log("User cancelled screen share");
            } else {
                console.error("Error sharing screen:", error);
                showNotification("❌ Screen sharing failed: " + error.message);
            }
        }
    } else {
        stopScreenShare();
    }
}

async function stopScreenShare() {
    try {
        const videoTrack = localStream ? localStream.getVideoTracks()[0] : null;
        const peerIds = Object.keys(peers);

        // Replace screen track with camera track on ALL peer connections
        for (const peerId of peerIds) {
            const peer = peers[peerId];
            if (peer && peer.connection) {
                const senders = peer.connection.getSenders();
                const videoSender = senders.find(s => s.track && s.track.kind === "video");
                if (videoSender && videoTrack) {
                    try {
                        await videoSender.replaceTrack(videoTrack);
                        console.log(`Restored camera track for peer ${peerId}`);
                    } catch (e) {
                        console.error(`Failed to restore track for peer ${peerId}:`, e);
                    }
                }
            }
        }

        // Restore local video to camera
        const localVideoCard = document.getElementById(`card-${getLocalParticipantId()}`);
        if (localVideoCard) {
            const localVideo = localVideoCard.querySelector('video');
            if (localVideo && localStream) {
                localVideo.srcObject = localStream;
            }
        }

        // Remove self-preview overlay if present
        hideLocalCameraPreview();

        // Stop screen stream
        if (screenStream) {
            screenStream.getTracks().forEach((track) => track.stop());
        }
        screenStream = null;
        isScreenSharing = false;

        // Reset button appearance
        const screenShareBtn = document.getElementById('screenShareBtn');
        if (screenShareBtn) {
            screenShareBtn.style.background = '';
            screenShareBtn.textContent = '🖥️';
            screenShareBtn.title = 'Share Screen';
        }

        socket.emit("screen-share-stop");
        showNotification("✅ Screen sharing stopped");
    } catch (error) {
        console.error("Error stopping screen share:", error);
        showNotification("❌ Error stopping screen share");
        isScreenSharing = false;
    }
}

// Small picture-in-picture preview of your camera while sharing screen
function showLocalCameraPreview() {
    if (!localStream) return;

    // Avoid duplicates
    if (document.getElementById('localSharePreview')) return;

    const wrapper = document.createElement('div');
    wrapper.id = 'localSharePreview';
    wrapper.style.position = 'fixed';
    wrapper.style.right = '18px';
    wrapper.style.bottom = '110px';
    wrapper.style.width = '180px';
    wrapper.style.aspectRatio = '16 / 9';
    wrapper.style.borderRadius = '12px';
    wrapper.style.overflow = 'hidden';
    wrapper.style.boxShadow = '0 12px 30px rgba(0,0,0,0.7)';
    wrapper.style.border = '1px solid rgba(148,163,184,0.55)';
    wrapper.style.zIndex = '280';
    wrapper.style.background = '#000';

    const vid = document.createElement('video');
    vid.autoplay = true;
    vid.playsInline = true;
    vid.muted = true;
    vid.srcObject = localStream;
    vid.style.width = '100%';
    vid.style.height = '100%';
    vid.style.objectFit = 'cover';

    wrapper.appendChild(vid);
    document.body.appendChild(wrapper);
}

function hideLocalCameraPreview() {
    const el = document.getElementById('localSharePreview');
    if (el && el.parentNode) {
        el.parentNode.removeChild(el);
    }
}

function openImagePicker() {
    try {
        let input = document.getElementById('chatImageInput');
        if (!input) {
            input = document.createElement('input');
            input.type = 'file';
            input.accept = 'image/*';
            input.id = 'chatImageInput';
            input.style.display = 'none';
            input.addEventListener('change', (event) => {
                const target = event.target;
                if (!target || !target.files || !target.files[0]) return;
                const file = target.files[0];
                sendImage(file);
                target.value = '';
            });
            document.body.appendChild(input);
        }
        input.click();
    } catch (e) {
        console.error('Error opening image picker:', e);
        showNotification('❌ Unable to open image picker');
    }
}

function toggleChat() {
    document.getElementById("chatPanel").classList.toggle("open");
}

function toggleParticipantList() {
    const panel = document.getElementById("participantList");
    if (!panel) return;

    const isOpen = panel.classList.toggle("open");

    // Also toggle a body class so other UI elements (like the
    // host controls toggle button) can adjust their position
    // when the participant list is visible.
    try {
        document.body.classList.toggle("participants-open", isOpen);
    } catch (e) {
        console.error("Error toggling participants-open class:", e);
    }
}

function sendMessage() {
    const input = document.getElementById("messageInput");
    const message = input.value.trim();
    if (message) {
        socket.emit("send-message", { message });
        input.value = "";
    }
}

function sendImage(file) {
    if (!file || !file.type.startsWith("image/")) return;
    if (file.size > 8 * 1024 * 1024) {
        showNotification("❌ Image is too large. Please send a smaller image.");
        return;
    }

    const reader = new FileReader();
    reader.onload = () => {
        try {
            const sourceUrl = String(reader.result || "");
            const image = new window.Image();

            image.onload = () => {
                try {
                    const maxDimension = 1280;
                    const scale = Math.min(1, maxDimension / Math.max(image.width, image.height));
                    const canvas = document.createElement("canvas");
                    canvas.width = Math.max(1, Math.round(image.width * scale));
                    canvas.height = Math.max(1, Math.round(image.height * scale));

                    const ctx = canvas.getContext("2d");
                    if (!ctx) throw new Error("Canvas not available");

                    ctx.drawImage(image, 0, 0, canvas.width, canvas.height);

                    const quality = scale < 1 ? 0.82 : 0.9;
                    const compressedDataUrl = canvas.toDataURL("image/jpeg", quality);

                    if (compressedDataUrl.length > 300000) {
                        showNotification("❌ Image is still too large after compression. Please use a smaller file.");
                        return;
                    }

                    // Show locally immediately for quick feedback.
                    addChatMessage(userName || "You", "", compressedDataUrl);
                    socket.emit("send-message", {
                        message: "",
                        image: compressedDataUrl,
                    });
                } catch (e) {
                    console.error("Error compressing image:", e);
                    showNotification("❌ Unable to send image");
                }
            };

            image.onerror = () => {
                showNotification("❌ Unable to load image file");
            };

            image.src = sourceUrl;
        } catch (e) {
            console.error("Error sending image:", e);
            showNotification("❌ Unable to send image");
        }
    };
    reader.readAsDataURL(file);
}

function handleChatKeypress(event) {
    if (event.key === "Enter") {
        sendMessage();
    }
}

function addChatMessage(userName, message, imageData) {
    const chatMessages = document.getElementById("chatMessages");
    const messageDiv = document.createElement("div");
    messageDiv.className = "chat-message";

    const userDiv = document.createElement("div");
    userDiv.className = "chat-message-user";
    userDiv.textContent = userName;

    messageDiv.appendChild(userDiv);

    if (message) {
        const textDiv = document.createElement("div");
        textDiv.textContent = message;
        messageDiv.appendChild(textDiv);
    }

    if (imageData) {
        try {
            const img = document.createElement("img");
            img.src = imageData;
            img.alt = "Shared image";
            img.style.maxWidth = "220px";
            img.style.borderRadius = "10px";
            img.style.marginTop = "6px";
            img.style.display = "block";
            messageDiv.appendChild(img);
        } catch (e) {
            console.error("Error rendering chat image:", e);
        }
    }
    chatMessages.appendChild(messageDiv);
    chatMessages.scrollTop = chatMessages.scrollHeight;
}

function toggleRecording() {
    if (!isHost) {
        showNotification("Only the host can record the meeting");
        return;
    }

    const recordBtn = document.getElementById("recordBtn");
    if (!recordBtn) {
        return;
    }

    if (!isRecording) {
        if (socket) {
            socket.emit("recording-start");
        }
        startRecording();
        recordBtn.style.background = "#f44336";
        recordBtn.innerHTML = "🔴";
    } else {
        if (socket) {
            socket.emit("recording-stop");
        }
        stopRecording();
        recordBtn.style.background = "#404040";
        recordBtn.innerHTML = "⚫";
    }
}

async function startRecording() {
    // Capture the whole meeting/tab so all visible participants
    // and shared screens are included in the recording, not just
    // your own camera video.
    if (!navigator.mediaDevices || !navigator.mediaDevices.getDisplayMedia) {
        alert("Screen recording isn't supported in this browser/device");
        return;
    }

    try {
        const displayStream = await navigator.mediaDevices.getDisplayMedia({
            video: { frameRate: 30 },
            // Tab/system audio so you hear all participants in recording
            audio: true,
        });

        recordedChunks = [];

        const options = {
            mimeType: "video/webm;codecs=vp8,opus",
            videoBitsPerSecond: 2500000,
        };

        if (!MediaRecorder.isTypeSupported(options.mimeType)) {
            options.mimeType = "video/webm";
        }

        mediaRecorder = new MediaRecorder(displayStream, options);

        mediaRecorder.ondataavailable = (event) => {
            if (event.data.size > 0) {
                recordedChunks.push(event.data);
            }
        };

        mediaRecorder.onstop = () => {
            // Stop capturing the screen
            displayStream.getTracks().forEach((track) => track.stop());

            const blob = new Blob(recordedChunks, { type: options.mimeType });
            const fileName = `meeting-${new Date().getTime()}.webm`;

            if (socket && meetingId && userName) {
                socket.emit("upload-meeting-recording", {
                    meetingId,
                    userName,
                    fileName,
                    blob,
                });
                showNotification("✅ Meeting recording uploaded to server");
            } else {
                showNotification("⚠️ Meeting recording saved locally only");
            }

            const url = URL.createObjectURL(blob);
            const a = document.createElement("a");
            a.href = url;
            a.download = fileName;
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
        };

        mediaRecorder.start();
        isRecording = true;
        console.log("✅ Screen/meeting recording started");
        showNotification("🔴 Meeting recording started");
    } catch (err) {
        console.error("Recording error:", err);
        alert("❌ Recording error: " + err.message);
    }
}

function stopRecording() {
    if (mediaRecorder && isRecording) {
        mediaRecorder.stop();
        isRecording = false;
        console.log("✅ Recording stopped");
        showNotification("⏹️ Recording stopped");
    }
}

function startAudioRecording(fileName) {
    if (!localStream) {
        showNotification("❌ Local stream not ready");
        return;
    }

    const audioTrack = localStream.getAudioTracks()[0];
    if (!audioTrack) {
        showNotification("❌ Microphone not available");
        return;
    }

    try {
        const audioStream = new MediaStream([audioTrack]);
        recordedChunks = [];

        const audioOptions = {
            mimeType: "audio/webm;codecs=opus"
        };

        if (!MediaRecorder.isTypeSupported(audioOptions.mimeType)) {
            audioOptions.mimeType = "audio/webm";
        }

        mediaRecorder = new MediaRecorder(audioStream, audioOptions);

        mediaRecorder.ondataavailable = (e) => {
            if (e.data.size > 0) recordedChunks.push(e.data);
        };

        mediaRecorder.onstop = () => {
            if (!recordedChunks.length) {
                console.warn("No audio data captured for recording");
                showNotification("❌ No audio captured for this recording");
                return;
            }

            const blob = new Blob(recordedChunks, { type: audioOptions.mimeType });

            // If directed by server (fileName provided), upload it
            if (fileName) {
                socket.emit('upload-audio-recording', {
                    meetingId,
                    userName,
                    fileName: fileName || `audio_${meetingId}_${userName}.webm`,
                    blob
                });
                showNotification('✅ Uploaded recording to server');
            } else {
                // Otherwise download locally
                const a = document.createElement("a");
                a.href = URL.createObjectURL(blob);
                a.download = `audio_${meetingId}_${userName}.webm`;
                a.click();
                showNotification('✅ Recording saved locally');
            }
        };

        // Start recording without a timeslice so the browser
        // can write a single, well-formed WebM file. Using a
        // timeslice sometimes leads to odd duration metadata
        // (0:00 / 0:00) in some browsers.
        mediaRecorder.start();
        showNotification('🔴 Recording started');
    } catch (err) {
        console.error('Recording error:', err);
        showNotification("❌ Recording error: " + err.message);
    }
}

function stopAudioRecordingSocket() {
    if (clientMediaRecorderForSocket && clientMediaRecorderForSocket.state !== 'inactive') {
        clientMediaRecorderForSocket.stop();
    }
}

// --- Recordings panel (host only) ---
function addRecordingsControlButton() {
    const controls = document.querySelector('.controls');
    if (!controls || document.getElementById('recordingsBtn')) return;
    const btn = document.createElement('button');
    btn.id = 'recordingsBtn';
    btn.title = 'Recordings';
    btn.textContent = '📁';
    btn.onclick = () => toggleRecordingsPanel();
    // insert before the end-call button
    const endCall = controls.querySelector('.danger');
    if (endCall) controls.insertBefore(btn, endCall);
    else controls.appendChild(btn);
}

function toggleRecordingsPanel() {
    let panel = document.getElementById('recordingsPanel');
    if (panel) {
        panel.remove();
        return;
    }

    panel = document.createElement('div');
    panel.id = 'recordingsPanel';
    panel.className = 'recordings-panel';
    panel.style.position = 'fixed';
    panel.style.right = '0';
    panel.style.top = '0';
    panel.style.width = '360px';
    panel.style.height = '100%';
    panel.style.background = '#111';
    panel.style.borderLeft = '1px solid #333';
    panel.style.zIndex = '150';
    panel.style.color = '#fff';
    panel.style.display = 'flex';
    panel.style.flexDirection = 'column';

    const header = document.createElement('div');
    header.style.padding = '12px';
    header.style.borderBottom = '1px solid #333';
    header.style.display = 'flex';
    header.style.justifyContent = 'space-between';
    header.style.alignItems = 'center';
    const h = document.createElement('strong');
    h.textContent = 'Recordings';
    const close = document.createElement('button');
    close.className = 'close-btn';
    close.textContent = '✕';
    close.onclick = () => panel.remove();
    header.appendChild(h);
    header.appendChild(close);

    const list = document.createElement('div');
    list.id = 'recordingsList';
    list.style.flex = '1';
    list.style.overflowY = 'auto';
    list.style.padding = '12px';

    panel.appendChild(header);
    panel.appendChild(list);
    document.body.appendChild(panel);

    // Fetch recordings metadata (include host token header)
    fetchAndRenderRecordings();
}

async function fetchAndRenderRecordings() {
    try {
        if (!socket) return;

        // Ask the Socket.IO server for the current recordings
        // associated with this meeting. This keeps the list
        // intact even if the host refreshes or leaves and
        // comes back, as long as the meeting is still alive
        // on the server.
        socket.emit('get-recordings', { meetingId }, (response) => {
            try {
                if (!response) return;

                if (response.success && Array.isArray(response.recordings)) {
                    renderRecordingsList(response.recordings);
                } else if (response.message) {
                    const list = document.getElementById('recordingsList');
                    if (list) list.textContent = response.message;
                }
            } catch (e) {
                console.error('Error handling get-recordings response:', e);
            }
        });
    } catch (err) {
        console.error('Error requesting recordings:', err);
    }
}

function renderRecordingsList(recordings) {
    const list = document.getElementById('recordingsList');
    if (!list) return;
    list.innerHTML = '';
    if (!recordings || recordings.length === 0) {
        list.textContent = 'No recordings yet.';
        return;
    }

    // Show the generated topic/description at the very top of the
    // recordings panel so the host clearly sees the context being
    // used for scoring.
    let headerTopic = null;
    for (const r of recordings) {
        if (typeof r.topic === 'string' && r.topic.trim()) {
            headerTopic = r.topic.trim();
            break;
        }
    }

    if (headerTopic) {
        const topicBox = document.createElement('div');
        topicBox.style.marginBottom = '10px';
        topicBox.style.padding = '8px 10px';
        topicBox.style.borderRadius = '6px';
        topicBox.style.background = '#020617';
        topicBox.style.fontSize = '12px';
        topicBox.style.lineHeight = '1.4';
        topicBox.style.color = '#e5e7eb';
        topicBox.textContent = 'Topic: ' + headerTopic;
        list.appendChild(topicBox);
    }

    recordings.forEach(r => {
        const item = document.createElement('div');
        item.style.borderBottom = '1px solid #eee';
        item.style.padding = '8px 0';

        const title = document.createElement('div');
        title.textContent = `${r.userName} — ${new Date(r.savedAt).toLocaleString()}`;
        title.style.fontSize = '13px';
        title.style.marginBottom = '6px';

        // Optional: show scoring information if available from backend
        if (typeof r.score === 'number') {
            const scoreLine = document.createElement('div');
            scoreLine.style.fontSize = '12px';
            scoreLine.style.marginBottom = '4px';
            scoreLine.style.color = '#0f766e';
            const scoreValue = r.score.toFixed(1);
            const topicText = typeof r.topic === 'string' ? `  •  Topic: ${r.topic}` : '';
            scoreLine.textContent = `Score: ${scoreValue}/100${topicText}`;
            item.appendChild(scoreLine);
        }

        const audio = document.createElement('audio');
        audio.controls = true;
        audio.src = r.file;
        audio.preload = 'metadata';
        audio.style.width = '100%';

        const actions = document.createElement('div');
        actions.style.display = 'flex';
        actions.style.gap = '8px';
        actions.style.marginTop = '8px';
        actions.style.justifyContent = 'flex-end';

        const download = document.createElement('a');
        download.href = r.file;
        download.title = 'Download';
        download.target = '_blank';
        download.style.width = '32px';
        download.style.height = '32px';
        download.style.display = 'flex';
        download.style.alignItems = 'center';
        download.style.justifyContent = 'center';
        download.style.borderRadius = '999px';
        download.style.background = '#1d4ed8';
        download.style.color = '#f9fafb';
        download.style.fontSize = '16px';
        download.style.textDecoration = 'none';
        download.style.boxShadow = '0 2px 6px rgba(0,0,0,0.4)';
        download.textContent = '⭳';

        const del = document.createElement('button');
        del.title = 'Delete';
        del.style.width = '32px';
        del.style.height = '32px';
        del.style.display = 'flex';
        del.style.alignItems = 'center';
        del.style.justifyContent = 'center';
        del.style.borderRadius = '999px';
        del.style.border = 'none';
        del.style.background = '#b91c1c';
        del.style.color = '#fee2e2';
        del.style.fontSize = '16px';
        del.style.cursor = 'pointer';
        del.style.boxShadow = '0 2px 6px rgba(0,0,0,0.4)';
        del.textContent = '🗑';
        del.onclick = () => {
            if (!confirm('Delete this recording?')) return;
            socket.emit('host-delete-recording', { meetingId, fileName: r.fileName });
        };

        actions.appendChild(download);
        actions.appendChild(del);

        item.appendChild(title);
        item.appendChild(audio);

        // Optional transcript viewer when Whisper has processed this recording
        // Show the button as soon as the server sets a transcript field.
        if (typeof r.transcript === 'string') {
            const transcriptRow = document.createElement('div');
            transcriptRow.style.display = 'flex';
            transcriptRow.style.alignItems = 'center';
            transcriptRow.style.gap = '6px';
            transcriptRow.style.marginTop = '6px';

            const transcriptToggle = document.createElement('button');
            // Use a notes icon instead of text for a cleaner look
            transcriptToggle.textContent = '📝';
            transcriptToggle.style.width = '28px';
            transcriptToggle.style.height = '28px';
            transcriptToggle.style.display = 'flex';
            transcriptToggle.style.alignItems = 'center';
            transcriptToggle.style.justifyContent = 'center';
            transcriptToggle.style.fontSize = '15px';
            transcriptToggle.style.borderRadius = '999px';
            transcriptToggle.style.border = 'none';
            transcriptToggle.style.background = '#1f2937';
            transcriptToggle.style.color = '#e5e7eb';
            transcriptToggle.style.cursor = 'pointer';
            transcriptToggle.title = 'View transcript';

            const transcriptBox = document.createElement('div');
            transcriptBox.style.marginTop = '4px';
            transcriptBox.style.padding = '6px 8px';
            transcriptBox.style.borderRadius = '4px';
            transcriptBox.style.background = '#020617';
            transcriptBox.style.fontSize = '11px';
            transcriptBox.style.lineHeight = '1.4';
            transcriptBox.style.whiteSpace = 'pre-wrap';
            transcriptBox.style.display = 'none';

            // If the transcript is empty or only whitespace, show a
            // helpful placeholder instead of a completely blank box.
            const txt = (r.transcript || '').trim();
            transcriptBox.textContent = txt || 'No transcript available yet or transcription failed.';

            transcriptToggle.onclick = () => {
                const isVisible = transcriptBox.style.display === 'block';
                transcriptBox.style.display = isVisible ? 'none' : 'block';
                // Keep icon the same, just update tooltip
                transcriptToggle.title = isVisible ? 'View transcript' : 'Hide transcript';
            };

            // Allow host to download the transcript as a .txt file
            const downloadTranscriptBtn = document.createElement('button');
            downloadTranscriptBtn.textContent = '⬇️';
            downloadTranscriptBtn.style.width = '28px';
            downloadTranscriptBtn.style.height = '28px';
            downloadTranscriptBtn.style.display = 'flex';
            downloadTranscriptBtn.style.alignItems = 'center';
            downloadTranscriptBtn.style.justifyContent = 'center';
            downloadTranscriptBtn.style.fontSize = '15px';
            downloadTranscriptBtn.style.borderRadius = '999px';
            downloadTranscriptBtn.style.border = 'none';
            downloadTranscriptBtn.style.background = '#111827';
            downloadTranscriptBtn.style.color = '#e5e7eb';
            downloadTranscriptBtn.style.cursor = 'pointer';
            downloadTranscriptBtn.title = 'Download transcript as .txt';

            downloadTranscriptBtn.onclick = () => {
                const raw = (r.transcript || '').trim();
                if (!raw) {
                    alert('Transcript is not available yet.');
                    return;
                }

                const blob = new Blob([raw], { type: 'text/plain;charset=utf-8' });
                const url = URL.createObjectURL(blob);
                const a = document.createElement('a');
                const safeUser = (r.userName || 'recording').replace(/[^a-z0-9-_]/gi, '_');
                const ts = new Date(r.savedAt).toISOString().slice(0, 19).replace(/[.:T]/g, '-');
                a.href = url;
                a.download = `${safeUser}_${ts}.txt`;
                document.body.appendChild(a);
                a.click();
                setTimeout(() => {
                    document.body.removeChild(a);
                    URL.revokeObjectURL(url);
                }, 0);
            };

            transcriptRow.appendChild(transcriptToggle);
            transcriptRow.appendChild(downloadTranscriptBtn);

            item.appendChild(transcriptRow);
            item.appendChild(transcriptBox);
        }

        item.appendChild(actions);

        list.appendChild(item);
    });
}

function updateParticipants(participants) {
    const participantItems = document.getElementById("participantItems");
    participantItems.innerHTML = "";

    const dedupedParticipants = [];
    const seenKeys = new Set();

    (Array.isArray(participants) ? participants : []).forEach((participant) => {
        const key = getParticipantKey(participant);
        if (!key || seenKeys.has(key)) return;
        seenKeys.add(key);
        dedupedParticipants.push(participant);
        registerParticipantIdentity(participant);
    });

    // cache for host panel + breakout merge
    lastKnownParticipants = dedupedParticipants.slice();
    resetParticipantIdentityMap(dedupedParticipants);

    dedupedParticipants.forEach((participant) => {
        const item = document.createElement("div");
        item.className = "participant-item";
        // Store identifiers for later (e.g., breakout assignment modal)
        item.dataset.userName = participant.userName;
        item.dataset.socketId = participant.id;

        const left = document.createElement("div");
        left.style.display = "flex";
        left.style.gap = "10px";
        left.style.alignItems = "center";
        left.style.flex = "1";

        const status = document.createElement("div");
        status.className = "participant-status";

        const avatar = document.createElement("div");
        avatar.className = "participant-avatar";
        const initial = (participant.userName || "?").trim().charAt(0).toUpperCase();
        avatar.textContent = initial || "?";

        const info = document.createElement("div");
        const name = document.createElement("strong");
        name.textContent = participant.userName;

        // Show a small hand icon next to the name if this
        // participant currently has their hand raised.
        if (raisedHands[participant.id]) {
            const handSpan = document.createElement('span');
            handSpan.textContent = ' ✋';
            name.appendChild(handSpan);
        }

        info.appendChild(name);

        left.appendChild(status);
        left.appendChild(avatar);
        left.appendChild(info);

        item.appendChild(left);

        // Create actions container for buttons
        const actions = document.createElement("div");
        actions.className = "participant-action-buttons";

        // If current client is host, show host tools for other participants
        if (isHost && participant.id !== socket.id) {
            const isParticipantHost = !!participant.isHost;

            // Toggle host button (make/remove host) using make-admin / remove-admin icons
            const hostToggleBtn = document.createElement("button");
            hostToggleBtn.title = isParticipantHost ? "Remove host" : "Make host";
            hostToggleBtn.style.width = '28px';
            hostToggleBtn.style.height = '28px';
            hostToggleBtn.style.borderRadius = '999px';
            hostToggleBtn.style.border = 'none';
            hostToggleBtn.style.marginRight = '4px';
            hostToggleBtn.style.cursor = 'pointer';
            hostToggleBtn.style.backgroundColor = '#111827';
            hostToggleBtn.style.backgroundImage = isParticipantHost ?
                "url('/icons/remove-admin.png')" :
                "url('/icons/make-admin.png')";
            hostToggleBtn.style.backgroundRepeat = 'no-repeat';
            hostToggleBtn.style.backgroundPosition = 'center';
            hostToggleBtn.style.backgroundSize = '18px 18px';
            hostToggleBtn.onclick = () => {
                const makeHost = !isParticipantHost;
                const msg = makeHost ?
                    `Make ${participant.userName} a host?` :
                    `Remove host role from ${participant.userName}?`;
                if (!confirm(msg)) return;
                socket.emit('update-host-role', { meetingId, targetSocketId: participant.id, makeHost });
            };
            actions.appendChild(hostToggleBtn);

            const muteBtn = document.createElement("button");
            muteBtn.textContent = "🎤";
            muteBtn.title = "Mute participant";
            muteBtn.onclick = () => muteUser(participant.id);
            actions.appendChild(muteBtn);

            const recordBtn = document.createElement("button");
            recordBtn.textContent = "⏺️";
            recordBtn.title = "Record participant";
            recordBtn.onclick = () => {
                // toggle: if text is stop, send stop, else start
                if (recordBtn.dataset.recording === "true") {
                    recordBtn.dataset.recording = "false";
                    recordBtn.textContent = "⏺️";
                    socket.emit("host-stop-record-user", { meetingId, targetSocketId: participant.id });
                } else {
                    recordBtn.dataset.recording = "true";
                    recordBtn.textContent = "⏹️";
                    socket.emit("host-start-record-user", { meetingId, targetSocketId: participant.id });
                }
            };
            actions.appendChild(recordBtn);
        }

        // If a recording exists for this participant, show download link (host only)
        if (isHost && recordingsMap[participant.userName]) {
            const a = document.createElement('a');
            a.href = recordingsMap[participant.userName];
            a.textContent = '⬇️';
            a.title = 'Download recording';
            a.target = '_blank';
            a.className = 'recording-link';
            a.style.padding = '4px 8px';
            a.style.background = '#404040';
            a.style.color = '#fff';
            a.style.borderRadius = '4px';
            a.style.textDecoration = 'none';
            a.style.fontSize = '12px';
            a.style.transition = 'all 0.2s ease';
            a.style.cursor = 'pointer';
            actions.appendChild(a);
        }

        if (actions.children.length > 0) {
            item.appendChild(actions);
        }

        participantItems.appendChild(item);
    });

    // Also update the host controls panel
    if (isHost) {
        renderHostControlsPanel(lastKnownParticipants);
    }
}

// Add toggle button for host controls panel
function addPanelToggle() {
    const panel = document.getElementById('hostControlsPanel');
    if (!panel || document.querySelector('.panel-toggle-btn')) return; // Already added

    const toggleBtn = document.createElement('button');
    toggleBtn.className = 'panel-toggle-btn';
    toggleBtn.textContent = '◀';
    toggleBtn.title = 'Close Host Controls Panel';

    toggleBtn.onclick = () => {
        const isOpen = panel.classList.contains('show');
        if (isOpen) {
            panel.classList.remove('show');
            toggleBtn.textContent = '▶';
            toggleBtn.title = 'Open Host Controls Panel';
        } else {
            panel.classList.add('show');
            toggleBtn.textContent = '◀';
            toggleBtn.title = 'Close Host Controls Panel';
        }
    };

    // Append the toggle to the body; its CSS uses the
    // sibling selector .host-controls-panel.show ~ .panel-toggle-btn
    // so it visually tracks the animated panel edge.
    document.body.appendChild(toggleBtn);
}

// Render host controls panel with mute and record buttons
function renderHostControlsPanel(participants) {
    if (!isHost) return;
    const content = document.getElementById('hostControlsContent');
    if (!content) return;

    content.innerHTML = '';

    // Add global controls section
    const globalControlsSection = document.createElement('div');
    globalControlsSection.style.padding = '12px';
    globalControlsSection.style.borderBottom = '1px solid #333';
    globalControlsSection.style.background = '#0a0a0a';

    const globalTitle = document.createElement('div');
    globalTitle.textContent = 'Global Controls';
    globalTitle.style.fontSize = '12px';
    globalTitle.style.fontWeight = 'bold';
    globalTitle.style.marginBottom = '10px';
    globalTitle.style.color = '#4CAF50';
    globalControlsSection.appendChild(globalTitle);

    // Mute All button
    const muteAllBtn = document.createElement('button');
    muteAllBtn.textContent = '🔇 Mute All';
    muteAllBtn.style.width = '100%';
    muteAllBtn.style.padding = '8px';
    muteAllBtn.style.marginBottom = '8px';
    muteAllBtn.style.background = '#1d4ed8';
    muteAllBtn.style.color = '#fff';
    muteAllBtn.style.border = 'none';
    muteAllBtn.style.borderRadius = '4px';
    muteAllBtn.style.cursor = 'pointer';
    muteAllBtn.style.fontSize = '12px';
    muteAllBtn.style.fontWeight = 'bold';
    muteAllBtn.style.transition = 'all 0.2s ease';
    muteAllBtn.onmouseover = () => muteAllBtn.style.background = '#1e40af';
    muteAllBtn.onmouseout = () => muteAllBtn.style.background = '#1d4ed8';
    muteAllBtn.onclick = () => {
        participants.forEach(p => {
            if (p.id !== socket.id) {
                mutedParticipants[p.id] = true;
                muteUser(p.id);
            }
        });
        showNotification('🔇 All participants muted');
        renderHostControlsPanel(participants);
    };
    globalControlsSection.appendChild(muteAllBtn);

    // Unmute All button
    const unmuteAllBtn = document.createElement('button');
    unmuteAllBtn.textContent = '🔊 Unmute All';
    unmuteAllBtn.style.width = '100%';
    unmuteAllBtn.style.padding = '8px';
    unmuteAllBtn.style.marginBottom = '8px';
    unmuteAllBtn.style.background = '#667eea';
    unmuteAllBtn.style.color = '#fff';
    unmuteAllBtn.style.border = 'none';
    unmuteAllBtn.style.borderRadius = '4px';
    unmuteAllBtn.style.cursor = 'pointer';
    unmuteAllBtn.style.fontSize = '12px';
    unmuteAllBtn.style.fontWeight = 'bold';
    unmuteAllBtn.style.transition = 'all 0.2s ease';
    unmuteAllBtn.onmouseover = () => unmuteAllBtn.style.background = '#5568d3';
    unmuteAllBtn.onmouseout = () => unmuteAllBtn.style.background = '#667eea';
    unmuteAllBtn.onclick = () => {
        participants.forEach(p => {
            if (p.id !== socket.id) {
                delete mutedParticipants[p.id];
                muteUser(p.id);
            }
        });
        showNotification('🔊 All participants unmuted');
        renderHostControlsPanel(participants);
    };
    globalControlsSection.appendChild(unmuteAllBtn);

    // Record All button
    const recordAllBtn = document.createElement('button');
    recordAllBtn.textContent = '⏺️ Record All';
    recordAllBtn.style.width = '100%';
    recordAllBtn.style.padding = '8px';
    recordAllBtn.style.marginBottom = '8px';
    recordAllBtn.style.background = '#1d4ed8';
    recordAllBtn.style.color = '#fff';
    recordAllBtn.style.border = 'none';
    recordAllBtn.style.borderRadius = '4px';
    recordAllBtn.style.cursor = 'pointer';
    recordAllBtn.style.fontSize = '12px';
    recordAllBtn.style.fontWeight = 'bold';
    recordAllBtn.style.transition = 'all 0.2s ease';
    recordAllBtn.onmouseover = () => recordAllBtn.style.background = '#1e40af';
    recordAllBtn.onmouseout = () => recordAllBtn.style.background = '#1d4ed8';
    recordAllBtn.onclick = () => {
        let startedCount = 0;
        participants.forEach(p => {
            if (p.id !== socket.id && !recordingParticipants[p.id]) {
                recordingParticipants[p.id] = true;
                socket.emit('host-start-record-user', { meetingId, targetSocketId: p.id });
                startedCount++;
            }
        });

        if (startedCount > 0) {
            showNotification(`🔴 Recording started for ${startedCount} participant(s)`);
            renderHostControlsPanel(participants);
        } else {
            showNotification('ℹ️ No new participants to start recording');
        }
    };
    globalControlsSection.appendChild(recordAllBtn);

    // Stop All Recording button
    const stopAllRecordBtn = document.createElement('button');
    stopAllRecordBtn.textContent = '⏹️ Stop All Recording';
    stopAllRecordBtn.style.width = '100%';
    stopAllRecordBtn.style.padding = '8px';
    stopAllRecordBtn.style.background = '#1d4ed8';
    stopAllRecordBtn.style.color = '#fff';
    stopAllRecordBtn.style.border = 'none';
    stopAllRecordBtn.style.borderRadius = '4px';
    stopAllRecordBtn.style.cursor = 'pointer';
    stopAllRecordBtn.style.fontSize = '12px';
    stopAllRecordBtn.style.fontWeight = 'bold';
    stopAllRecordBtn.style.transition = 'all 0.2s ease';
    stopAllRecordBtn.onmouseover = () => stopAllRecordBtn.style.background = '#1e40af';
    stopAllRecordBtn.onmouseout = () => stopAllRecordBtn.style.background = '#1d4ed8';
    stopAllRecordBtn.onclick = () => {
        participants.forEach(p => {
            if (p.id !== socket.id && recordingParticipants[p.id]) {
                socket.emit('host-stop-record-user', { meetingId, targetSocketId: p.id });
                delete recordingParticipants[p.id];
            }
        });
        showNotification('⏹️ All recordings stopped');
        renderHostControlsPanel(participants);
    };
    globalControlsSection.appendChild(stopAllRecordBtn);

    // Lobby (waiting room) controls
    if (Array.isArray(waitingParticipants) && waitingParticipants.length > 0) {
        const lobbyTitle = document.createElement('div');
        lobbyTitle.textContent = 'Lobby (waiting room)';
        lobbyTitle.style.fontSize = '11px';
        lobbyTitle.style.fontWeight = 'bold';
        lobbyTitle.style.marginTop = '14px';
        lobbyTitle.style.marginBottom = '6px';
        lobbyTitle.style.color = '#22c55e';
        globalControlsSection.appendChild(lobbyTitle);

        const lobbySummary = document.createElement('div');
        lobbySummary.textContent = `${waitingParticipants.length} participant(s) waiting to join`;
        lobbySummary.style.fontSize = '11px';
        lobbySummary.style.color = '#9ca3af';
        lobbySummary.style.marginBottom = '8px';
        globalControlsSection.appendChild(lobbySummary);

        const admitAllBtn = document.createElement('button');
        admitAllBtn.textContent = `✅ Admit all (${waitingParticipants.length})`;
        admitAllBtn.style.width = '100%';
        admitAllBtn.style.padding = '8px';
        admitAllBtn.style.marginBottom = '6px';
        admitAllBtn.style.background = '#16a34a';
        admitAllBtn.style.color = '#fff';
        admitAllBtn.style.border = 'none';
        admitAllBtn.style.borderRadius = '4px';
        admitAllBtn.style.cursor = 'pointer';
        admitAllBtn.style.fontSize = '12px';
        admitAllBtn.style.fontWeight = 'bold';
        admitAllBtn.style.transition = 'all 0.2s ease';
        admitAllBtn.onmouseover = () => admitAllBtn.style.background = '#15803d';
        admitAllBtn.onmouseout = () => admitAllBtn.style.background = '#16a34a';
        admitAllBtn.onclick = () => {
            socket.emit('admit-all-participants', { meetingId });
        };
        globalControlsSection.appendChild(admitAllBtn);

        const lobbyList = document.createElement('div');
        lobbyList.style.display = 'flex';
        lobbyList.style.flexDirection = 'column';
        lobbyList.style.gap = '6px';

        waitingParticipants.forEach((wp) => {
            const row = document.createElement('div');
            row.style.display = 'flex';
            row.style.justifyContent = 'space-between';
            row.style.alignItems = 'center';
            row.style.fontSize = '11px';

            const label = document.createElement('div');
            const name = wp.userName || 'Guest';
            const email = wp.email || '';
            label.textContent = email ? `${name} (${email})` : name;
            label.style.color = '#e5e7eb';

            const acceptBtn = document.createElement('button');
            acceptBtn.textContent = 'Admit';
            acceptBtn.style.padding = '4px 8px';
            acceptBtn.style.background = '#1d4ed8';
            acceptBtn.style.color = '#fff';
            acceptBtn.style.border = 'none';
            acceptBtn.style.borderRadius = '4px';
            acceptBtn.style.cursor = 'pointer';
            acceptBtn.style.fontSize = '11px';
            acceptBtn.onclick = () => {
                if (!wp.socketId) return;
                socket.emit('admit-participant', { meetingId, targetSocketId: wp.socketId });
            };

            row.appendChild(label);
            row.appendChild(acceptBtn);
            lobbyList.appendChild(row);
        });

        globalControlsSection.appendChild(lobbyList);
    }

    content.appendChild(globalControlsSection);

    // Build a combined list of controllable participants:
    //  - main meeting participants
    //  - plus anyone currently in breakout rooms (using breakoutRoomsData)
    const mainOthers = participants.filter(p => p.id !== socket.id);

    const breakoutExtra = [];
    Object.values(breakoutRoomsData || {}).forEach(room => {
        const names = room.participants || [];
        const ids = room.socketIds || [];
        names.forEach((name, idx) => {
            const sid = ids[idx];
            if (!sid || sid === socket.id) return;
            breakoutExtra.push({
                id: sid,
                userName: typeof name === 'string' ? name : (name.userName || name.name || 'Unknown'),
                email: '',
                _roomName: room.name || 'Breakout',
            });
        });
    });

    // Merge and de-duplicate primarily by user name so that
    // a participant who has returned from a breakout room is
    // only shown once (we prefer the main meeting entry).
    const byKey = {};
    [...mainOthers, ...breakoutExtra].forEach(p => {
        if (!p || p.id === socket.id) return;
        const key = p.userName || p.id || `anon:${Math.random()}`;
        if (!byKey[key]) {
            byKey[key] = p;
        }
    });

    const otherParticipants = Object.values(byKey);

    if (otherParticipants.length === 0) {
        const noParticipants = document.createElement('div');
        noParticipants.style.padding = '20px';
        noParticipants.style.textAlign = 'center';
        noParticipants.style.color = '#999';
        noParticipants.style.fontSize = '12px';
        noParticipants.textContent = 'No other participants';
        content.appendChild(noParticipants);
        return;
    }

    // Add participants section
    const participantSection = document.createElement('div');
    participantSection.style.padding = '12px';
    participantSection.style.borderBottom = '1px solid #333';
    participantSection.style.background = '#0a0a0a';

    const participantTitle = document.createElement('div');
    participantTitle.textContent = 'Individual Controls';
    participantTitle.style.fontSize = '12px';
    participantTitle.style.fontWeight = 'bold';
    participantTitle.style.marginBottom = '10px';
    participantTitle.style.color = '#4CAF50';
    participantSection.appendChild(participantTitle);

    otherParticipants.forEach(participant => {
        const item = document.createElement('div');
        item.className = 'control-item';

        const userName = document.createElement('div');
        userName.className = 'user-name';
        userName.textContent = participant.userName + (participant._roomName ? ` (${participant._roomName})` : '');

        if (raisedHands[participant.id]) {
            const handSpan = document.createElement('span');
            handSpan.textContent = ' ✋';
            userName.appendChild(handSpan);
        }

        const buttons = document.createElement('div');
        buttons.className = 'control-buttons';

        // Mute/Unmute button (toggle)
        const muteBtn = document.createElement('button');
        const key = participant.id || `name:${participant.userName}`;
        const isMuted = mutedParticipants[key] || false;
        muteBtn.textContent = isMuted ? '🔊 Unmute' : '🎤 Mute';
        muteBtn.title = isMuted ? 'Unmute this participant' : 'Mute this participant';
        muteBtn.dataset.participantId = participant.id;
        muteBtn.onclick = () => {
            if (mutedParticipants[key]) {
                // Unmute
                delete mutedParticipants[key];
                muteBtn.textContent = '🎤 Mute';
                showNotification(`${participant.userName} has been unmuted`);
            } else {
                // Mute
                mutedParticipants[key] = true;
                muteBtn.textContent = '🔊 Unmute';
                showNotification(`${participant.userName} has been muted`);
            }
            muteUser(participant.id);
        };
        buttons.appendChild(muteBtn);

        // Record button (toggle)
        const recordBtn = document.createElement('button');
        const recKey = participant.id || `name:${participant.userName}`;
        const isRecording = recordingParticipants[recKey] || false;
        recordBtn.dataset.participantId = participant.id || '';
        recordBtn.dataset.recording = isRecording ? 'true' : 'false';
        recordBtn.textContent = isRecording ? '⏹️ Stop' : '⏺️ Record';
        recordBtn.title = isRecording ? 'Stop recording' : 'Start recording';
        if (isRecording) recordBtn.classList.add('recording');

        recordBtn.onclick = () => {
            const pId = recordBtn.dataset.participantId || '';
            const key = pId || `name:${participant.userName}`;
            if (recordingParticipants[key]) {
                // Stop recording
                delete recordingParticipants[key];
                recordBtn.dataset.recording = 'false';
                recordBtn.textContent = '⏺️ Record';
                recordBtn.classList.remove('recording');
                socket.emit('host-stop-record-user', { meetingId, targetSocketId: pId || null, targetUserName: participant.userName });
                showNotification(`⏹️ Stopped recording ${participant.userName}`);
            } else {
                // Start recording
                recordingParticipants[key] = true;
                recordBtn.dataset.recording = 'true';
                recordBtn.textContent = '⏹️ Stop';
                recordBtn.classList.add('recording');
                socket.emit('host-start-record-user', { meetingId, targetSocketId: pId || null, targetUserName: participant.userName });
                showNotification(`🔴 Started recording ${participant.userName}`);
            }
        };
        buttons.appendChild(recordBtn);

        item.appendChild(userName);
        item.appendChild(buttons);

        participantSection.appendChild(item);
    });

    content.appendChild(participantSection);
}

function endMeeting() {
    if (!isHost) {
        // Normal participant: just leave
        if (!confirm("Are you sure you want to leave the meeting?")) return;

        if (localStream) {
            localStream.getTracks().forEach((track) => track.stop());
        }
        if (screenStream) {
            screenStream.getTracks().forEach((track) => track.stop());
        }

        Object.values(peers).forEach((peer) => {
            try {
                if (peer && peer.connection) {
                    peer.connection.close();
                }
            } catch (e) {
                console.error("Error closing peer in endMeeting:", e);
            }
        });
        peers = {};

        if (socket && typeof socket.disconnect === "function") {
            socket.disconnect();
        }

        window.location.href = "/";
        return;
    }
    // Host: show popup with two options
    showEndMeetingHostPopup();
}

// Host-only popup: "End for you" vs "End for everyone"
function showEndMeetingHostPopup() {
    if (document.getElementById("endMeetingHostPopup")) return;

    const backdrop = document.createElement("div");
    backdrop.id = "endMeetingHostPopupBackdrop";
    backdrop.style.position = "fixed";
    backdrop.style.inset = "0";
    backdrop.style.background = "rgba(15,23,42,0.85)";
    backdrop.style.zIndex = "360";

    const modal = document.createElement("div");
    modal.id = "endMeetingHostPopup";
    modal.style.position = "fixed";
    modal.style.top = "50%";
    modal.style.left = "50%";
    modal.style.transform = "translate(-50%, -50%)";
    modal.style.background = "#020617";
    modal.style.borderRadius = "18px";
    modal.style.padding = "20px 22px 18px";
    modal.style.boxShadow = "0 24px 80px rgba(0,0,0,0.9)";
    modal.style.width = "min(380px, 92vw)";
    modal.style.color = "#e5e7eb";
    modal.style.zIndex = "370"; // above the backdrop
    modal.style.fontFamily = 'system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';

    const title = document.createElement("h2");
    title.textContent = "End meeting";
    title.style.margin = "0 0 6px 0";
    title.style.fontSize = "18px";
    title.style.color = "#f9fafb";

    const description = document.createElement("p");
    description.textContent = "Choose whether to leave only for you, or end the meeting for everyone.";
    description.style.margin = "0 0 14px 0";
    description.style.fontSize = "13px";
    description.style.color = "#9ca3af";

    const buttonsRow = document.createElement("div");
    buttonsRow.style.display = "flex";
    buttonsRow.style.gap = "10px";
    buttonsRow.style.marginTop = "10px";

    const leaveBtn = document.createElement("button");
    leaveBtn.textContent = "End for you";
    leaveBtn.style.flex = "1";
    leaveBtn.style.padding = "10px";
    leaveBtn.style.borderRadius = "999px";
    leaveBtn.style.border = "none";
    leaveBtn.style.background = "#374151";
    leaveBtn.style.color = "#e5e7eb";
    leaveBtn.style.cursor = "pointer";
    leaveBtn.style.fontSize = "13px";
    leaveBtn.style.fontWeight = "600";

    const endAllBtn = document.createElement("button");
    endAllBtn.textContent = "End for everyone";
    endAllBtn.style.flex = "1";
    endAllBtn.style.padding = "10px";
    endAllBtn.style.borderRadius = "999px";
    endAllBtn.style.border = "none";
    endAllBtn.style.background = "#dc2626";
    endAllBtn.style.color = "#fef2f2";
    endAllBtn.style.cursor = "pointer";
    endAllBtn.style.fontSize = "13px";
    endAllBtn.style.fontWeight = "700";

    function cleanup() {
        const m = document.getElementById("endMeetingHostPopup");
        const b = document.getElementById("endMeetingHostPopupBackdrop");
        if (m && m.parentNode) m.parentNode.removeChild(m);
        if (b && b.parentNode) b.parentNode.removeChild(b);
    }

    function doCleanupAndLeave(endForAll) {
        if (endForAll && socket) {
            socket.emit("close-meeting", { meetingId });
        }

        if (localStream) {
            localStream.getTracks().forEach((track) => track.stop());
        }
        if (screenStream) {
            screenStream.getTracks().forEach((track) => track.stop());
        }
        Object.values(peers).forEach((peer) => {
            try {
                if (peer && peer.connection) {
                    peer.connection.close();
                }
            } catch (e) {
                console.error("Error closing peer in host endMeeting:", e);
            }
        });
        peers = {};
        if (socket && typeof socket.disconnect === "function") {
            socket.disconnect();
        }
        window.location.href = "/";
    }

    leaveBtn.onclick = () => {
        cleanup();
        doCleanupAndLeave(false);
    };

    endAllBtn.onclick = () => {
        cleanup();
        doCleanupAndLeave(true);
    };

    modal.appendChild(title);
    modal.appendChild(description);
    buttonsRow.appendChild(leaveBtn);
    buttonsRow.appendChild(endAllBtn);
    modal.appendChild(buttonsRow);
    // Do NOT close on random backdrop clicks so the
    // host doesn't accidentally dismiss the popup.

    document.body.appendChild(backdrop);
    document.body.appendChild(modal);
}

function showNotification(message) {
    const notification = document.createElement("div");
    notification.className = "notification";
    notification.textContent = message;
    document.body.appendChild(notification);

    setTimeout(() => {
        notification.remove();
    }, 3000);
}

// === Live Captions (CC) ===
function ensureLiveCaptionsContainer() {
    if (liveCaptionsContainer) return liveCaptionsContainer;

    const el = document.createElement('div');
    el.id = 'liveCaptionsContainer';
    el.style.position = 'fixed';
    el.style.left = '50%';
    el.style.bottom = '80px';
    el.style.transform = 'translateX(-50%)';
    el.style.maxWidth = '80%';
    el.style.padding = '8px 14px';
    el.style.background = 'rgba(0,0,0,0.75)';
    el.style.borderRadius = '999px';
    el.style.color = '#f9fafb';
    el.style.fontSize = '14px';
    el.style.fontFamily = 'system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';
    el.style.textAlign = 'center';
    el.style.pointerEvents = 'none';
    el.style.zIndex = '260';
    el.style.whiteSpace = 'pre-wrap';
    el.style.display = 'none';

    document.body.appendChild(el);
    liveCaptionsContainer = el;
    return el;
}

function toggleLiveCaptions() {
    const ccBtn = document.getElementById('ccBtn');

    if (isLiveCaptionsOn) {
        isLiveCaptionsOn = false;
        if (speechRecognition) {
            try {
                speechRecognition.onresult = null;
                speechRecognition.onend = null;
                speechRecognition.onerror = null;
                speechRecognition.stop();
            } catch (e) {
                console.error('Error stopping SpeechRecognition:', e);
            }
        }
        if (liveCaptionsTimeout) {
            clearTimeout(liveCaptionsTimeout);
            liveCaptionsTimeout = null;
        }
        const box = ensureLiveCaptionsContainer();
        box.style.display = 'none';
        box.textContent = '';
        if (ccBtn) {
            ccBtn.classList.remove('cc-on');
        }
        showNotification('⏹️ Live captions off');
        return;
    }

    // Do not start live captions when the microphone is muted.
    if (!isMicOn) {
        showNotification('🎙️ Turn your mic on to use live captions');
        return;
    }

    const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SpeechRecognition) {
        showNotification('❌ Live captions not supported in this browser');
        return;
    }

    try {
        speechRecognition = new SpeechRecognition();
        speechRecognition.continuous = true;
        speechRecognition.interimResults = true;
        speechRecognition.lang = 'en-US';

        const box = ensureLiveCaptionsContainer();
        box.style.display = 'block';
        box.textContent = '';

        speechRecognition.onresult = (event) => {
            if (!event.results || event.results.length === 0) return;
            let transcript = '';
            for (let i = event.resultIndex; i < event.results.length; i++) {
                transcript += event.results[i][0].transcript;
            }
            transcript = transcript.trim();
            if (!transcript) return;

            box.textContent = `${userName || 'You'}: ${transcript}`;

            // Persist live captions to the backend with username and timestamp
            try {
                if (socket && meetingId) {
                    socket.emit("live-caption", {
                        meetingId,
                        userName,
                        text: transcript,
                        timestamp: new Date().toISOString(),
                    });
                }
            } catch (e) {
                console.error("Error emitting live-caption:", e);
            }

            if (liveCaptionsTimeout) {
                clearTimeout(liveCaptionsTimeout);
            }
            liveCaptionsTimeout = setTimeout(() => {
                if (!isLiveCaptionsOn) return;
                box.textContent = '';
            }, 5000);
        };

        speechRecognition.onend = () => {
            if (isLiveCaptionsOn) {
                // Some browsers require a small delay before restarting
                // recognition after onend, otherwise start() may throw.
                setTimeout(() => {
                    try {
                        speechRecognition.start();
                    } catch (e) {
                        console.error('Error restarting SpeechRecognition:', e);
                    }
                }, 250);
            }
        };

        speechRecognition.onerror = (e) => {
            console.error('SpeechRecognition error:', e);
            showNotification('⚠️ Live captions error');
            // Fail safe: turn CC off on hard errors so the
            // button state and overlay don't get stuck.
            isLiveCaptionsOn = false;
            const box = ensureLiveCaptionsContainer();
            box.style.display = 'none';
            box.textContent = '';
            if (ccBtn) {
                ccBtn.classList.remove('cc-on');
            }
        };

        // Mark CC as on before starting so that any
        // onend callbacks see the correct state.
        isLiveCaptionsOn = true;
        speechRecognition.start();
        if (ccBtn) {
            ccBtn.classList.add('cc-on');
        }
        showNotification('✅ Live captions on');
    } catch (e) {
        console.error('Failed to start SpeechRecognition:', e);
        showNotification('❌ Unable to start live captions');
    }
}

// === Emoji Reactions ===
function showReaction(emoji, fromUser) {
    try {
        const bubble = document.createElement('div');
        bubble.className = 'reaction-bubble';
        bubble.textContent = emoji;
        bubble.style.position = 'fixed';
        bubble.style.left = '50%';
        // Start near the bottom-center of the screen and
        // animate upwards using translateY so it travels
        // almost the full height on all devices.
        const isMobile = (window.innerWidth || 0) < 768;
        bubble.style.bottom = isMobile ? '8vh' : '10vh';
        bubble.style.transform = 'translate(-50%, 0)';
        bubble.style.fontSize = '32px';
        bubble.style.zIndex = '500';
        bubble.style.pointerEvents = 'none';
        bubble.style.transition = 'transform 1.2s ease-out, opacity 1.2s ease-out';
        bubble.style.textShadow = '0 2px 6px rgba(0,0,0,0.6)';

        document.body.appendChild(bubble);

        requestAnimationFrame(() => {
            const travel = isMobile ? '-72vh' : '-68vh';
            bubble.style.transform = `translate(-50%, ${travel})`;
            bubble.style.opacity = '0';
        });

        setTimeout(() => {
            bubble.remove();
        }, 1300);
    } catch (e) {
        console.error('Error showing reaction:', e);
    }
}

function openReactions() {
    const existing = document.getElementById('reactionsPopover');
    if (existing) {
        existing.remove();
        return;
    }

    const container = document.createElement('div');
    container.id = 'reactionsPopover';
    container.style.position = 'fixed';
    container.style.left = '50%';
    container.style.bottom = '130px';
    container.style.transform = 'translateX(-50%)';
    container.style.display = 'flex';
    container.style.gap = '8px';
    container.style.padding = '6px 10px';
    container.style.background = 'rgba(15,23,42,0.95)';
    container.style.borderRadius = '999px';
    container.style.boxShadow = '0 4px 20px rgba(0,0,0,0.5)';
    container.style.zIndex = '265';

    const emojis = ['👍', '❤️', '😂', '🎉', '👏', '😮', '✋'];
    emojis.forEach((emoji) => {
        const btn = document.createElement('button');
        btn.textContent = emoji;
        btn.style.fontSize = '20px';
        btn.style.background = 'transparent';
        btn.style.border = 'none';
        btn.style.cursor = 'pointer';
        btn.style.padding = '4px';
        btn.onclick = () => {
            container.remove();
            if (socket) {
                // Show the reaction locally immediately for snappy
                // feedback, then broadcast so everyone sees it.
                try {
                    showReaction(emoji, userName || 'You');
                } catch (e) {
                    console.error('Error showing local reaction:', e);
                }
                // For regular emojis, just send a reaction event. For
                // the hand emoji, also toggle the persistent raised-hand
                // state so a badge appears on the video tile.
                if (emoji === '✋') {
                    const localParticipantId = getLocalParticipantId();
                    const currentlyRaised = !!raisedHands[localParticipantId];
                    const nextState = !currentlyRaised;
                    setHandRaised(localParticipantId, nextState);
                    socket.emit('send-reaction', { emoji, meetingId });
                    socket.emit('toggle-hand', { raised: nextState });
                } else {
                    socket.emit('send-reaction', { emoji, meetingId });
                }
            }
        };
        container.appendChild(btn);
    });

    document.body.appendChild(container);

    setTimeout(() => {
        if (container.parentNode) {
            container.remove();
        }
    }, 8000);
}

function muteUser(socketId) {
    if (!isHost) {
        showNotification("Only the host can mute participants");
        return;
    }

    socket.emit("host-mute-user", {
        meetingId,
        targetSocketId: socketId
    });
}

function muteAll() {
    socket.emit("host-mute-all", { meetingId });
}

// Show invitation dialog when participant is invited to breakout room
// Unified version used for both direct invites and auto-assignment
function showBreakoutRoomInvitation(roomName, link, invitedBy, roomId, meetingIdParam) {
    const existing = document.getElementById('breakoutInviteModal');
    if (existing) existing.remove();

    const modal = document.createElement('div');
    modal.id = 'breakoutInviteModal';
    modal.style.position = 'fixed';
    modal.style.top = '50%';
    modal.style.left = '50%';
    modal.style.transform = 'translate(-50%, -50%)';
    modal.style.background = '#222';
    modal.style.border = '2px solid #4CAF50';
    modal.style.borderRadius = '12px';
    modal.style.padding = '30px';
    modal.style.zIndex = '300';
    modal.style.minWidth = '400px';
    modal.style.boxShadow = '0 4px 20px rgba(0,0,0,0.5)';
    modal.style.textAlign = 'center';
    modal.style.color = '#fff';

    const icon = document.createElement('div');
    icon.textContent = '👨‍💻';
    icon.style.fontSize = '48px';
    icon.style.marginBottom = '15px';
    modal.appendChild(icon);

    const title = document.createElement('h2');
    title.textContent = 'Join Breakout Room';
    title.style.margin = '0 0 10px 0';
    title.style.color = '#4CAF50';
    modal.appendChild(title);

    const message = document.createElement('p');
    message.style.margin = '0 0 15px 0';
    message.style.fontSize = '14px';
    message.style.color = '#ccc';
    message.innerHTML = `<strong>${invitedBy || 'Host'}</strong><br>is inviting you to<br><strong style="color: #4CAF50;">${roomName}</strong>`;
    modal.appendChild(message);

    const buttons = document.createElement('div');
    buttons.style.display = 'flex';
    buttons.style.gap = '10px';
    buttons.style.marginTop = '20px';

    const notNowBtn = document.createElement('button');
    notNowBtn.textContent = 'Not Now';
    notNowBtn.style.flex = '1';
    notNowBtn.style.padding = '12px';
    notNowBtn.style.background = '#404040';
    notNowBtn.style.color = '#fff';
    notNowBtn.style.border = 'none';
    notNowBtn.style.borderRadius = '6px';
    notNowBtn.style.cursor = 'pointer';
    notNowBtn.style.fontSize = '14px';
    notNowBtn.style.fontWeight = 'bold';

    const joinBtn = document.createElement('button');
    joinBtn.textContent = 'Join';
    joinBtn.style.flex = '1';
    joinBtn.style.padding = '12px';
    joinBtn.style.background = '#4CAF50';
    joinBtn.style.color = '#fff';
    joinBtn.style.border = 'none';
    joinBtn.style.borderRadius = '6px';
    joinBtn.style.cursor = 'pointer';
    joinBtn.style.fontSize = '14px';
    joinBtn.style.fontWeight = 'bold';

    // Build a safe breakout URL. Prefer explicit meetingId + roomId when
    // provided, so even if `link` is wrong we still go to
    // /meeting?roomId=<main>&breakoutId=<room>.
    let targetLink = link;
    try {
        const base = window.location.origin;
        const url = new URL('/meeting', base);
        const mainId = meetingIdParam || meetingId;
        if (mainId) url.searchParams.set('roomId', mainId);
        if (roomId) url.searchParams.set('breakoutId', roomId);
        targetLink = url.toString();
    } catch (e) {
        // fall back to provided link
    }

    notNowBtn.onclick = () => {
        modal.remove();
        const existingBackdrop = document.getElementById('breakoutBackdrop');
        if (existingBackdrop) existingBackdrop.remove();
    };

    joinBtn.onclick = () => {
        modal.remove();
        const existingBackdrop = document.getElementById('breakoutBackdrop');
        if (existingBackdrop) existingBackdrop.remove();
        // Redirect current tab into the breakout room URL. The meeting page
        // will see breakoutId in the URL and automatically emit
        // join-breakout-room from initializeMeeting.
        window.location.href = targetLink;
    };

    buttons.appendChild(notNowBtn);
    buttons.appendChild(joinBtn);
    modal.appendChild(buttons);

    const backdrop = document.createElement('div');
    backdrop.id = 'breakoutBackdrop';
    backdrop.style.position = 'fixed';
    backdrop.style.top = '0';
    backdrop.style.left = '0';
    backdrop.style.width = '100%';
    backdrop.style.height = '100%';
    backdrop.style.background = 'rgba(0,0,0,0.5)';
    backdrop.style.zIndex = '299';
    backdrop.onclick = () => {
        modal.remove();
        backdrop.remove();
    };

    document.body.appendChild(backdrop);
    document.body.appendChild(modal);

    // Auto-hide after 15 seconds if not interacted
    setTimeout(() => {
        if (document.getElementById('breakoutInviteModal')) {
            modal.remove();
            const existingBackdrop = document.getElementById('breakoutBackdrop');
            if (existingBackdrop) existingBackdrop.remove();
        }
    }, 15000);
}

// ============================================
// BREAKOUT ROOMS STATE MANAGEMENT
// ============================================
var breakoutRoomsData = {}; // roomId -> { name, link, participants, etc }
var currentBreakoutId = null;
var isInBreakoutRoom = false;
var assignmentMethod = 'manual';
var lastBreakoutInviteRoomId = null;

// Helper to show/hide the "Leave Breakout Room" button
function updateLeaveBreakoutButton() {
    const btn = document.getElementById('leaveBreakoutBtn');
    if (!btn) return;
    btn.style.display = isInBreakoutRoom ? 'inline-flex' : 'none';
}

function showBreakoutButton() {
    const btn = document.getElementById('breakoutBtn');
    if (btn) {
        btn.style.display = 'flex';
        btn.classList.remove('hidden');
    }
}

// Allow user to manually leave the current breakout room and return to main meeting
function leaveBreakoutRoom() {
    if (!isInBreakoutRoom) return;

    if (!confirm('Leave breakout room and return to main meeting?')) {
        return;
    }

    showNotification('⏱️ Returning to main meeting...');

    // Reload page to properly reconnect to main meeting
    setTimeout(() => {
        const base = `/meeting?roomId=${encodeURIComponent(meetingId)}`;
        // Preserve host role when the host leaves a breakout room so they
        // don't come back as a normal participant.
        const suffix = isHost ? '&host=true' : '';
        window.location.href = `${base}${suffix}`;
    }, 1000);
}

function toggleBreakoutRoomsPanel() {
    // Guard: only host should be able to open/manage breakout rooms
    if (!isHost) {
        showNotification("Only the host can manage breakout rooms");
        return;
    }

    let panel = document.getElementById('breakoutRoomsPanel');
    if (panel) {
        panel.remove();
        return;
    }

    panel = document.createElement('div');
    panel.id = 'breakoutRoomsPanel';
    panel.style.position = 'fixed';
    panel.style.right = '0';
    panel.style.top = '0';
    panel.style.width = '420px';
    panel.style.height = '100%';
    panel.style.background = '#111';
    panel.style.borderLeft = '1px solid #333';
    panel.style.zIndex = '150';
    panel.style.color = '#fff';
    panel.style.display = 'flex';
    panel.style.flexDirection = 'column';
    panel.style.boxShadow = '-2px 0 10px rgba(0,0,0,0.3)';
    panel.style.overflowY = 'auto';

    // Header
    const header = document.createElement('div');
    header.style.padding = '15px';
    header.style.borderBottom = '1px solid #333';
    header.style.display = 'flex';
    header.style.justifyContent = 'space-between';
    header.style.alignItems = 'center';
    header.style.position = 'sticky';
    header.style.top = '0';
    header.style.background = '#111';
    header.style.zIndex = '10';

    const title = document.createElement('strong');
    title.textContent = '👨‍💻 Breakout Rooms';
    title.style.fontSize = '14px';

    const closeBtn = document.createElement('button');
    closeBtn.textContent = '✕';
    closeBtn.style.background = 'none';
    closeBtn.style.border = 'none';
    closeBtn.style.color = '#fff';
    closeBtn.style.cursor = 'pointer';
    closeBtn.style.fontSize = '18px';
    closeBtn.onclick = () => panel.remove();

    header.appendChild(title);
    header.appendChild(closeBtn);
    panel.appendChild(header);

    // Create Rooms Section
    const createSection = document.createElement('div');
    createSection.style.padding = '15px';
    createSection.style.borderBottom = '1px solid #333';
    createSection.style.background = '#0a0a0a';

    const createTitle = document.createElement('div');
    createTitle.textContent = 'Create Breakout Rooms';
    createTitle.style.fontSize = '13px';
    createTitle.style.fontWeight = 'bold';
    createTitle.style.marginBottom = '12px';
    createTitle.style.color = '#4CAF50';
    createSection.appendChild(createTitle);

    // Number input for rooms
    const numberContainer = document.createElement('div');
    numberContainer.style.display = 'flex';
    numberContainer.style.alignItems = 'center';
    numberContainer.style.gap = '10px';
    numberContainer.style.marginBottom = '12px';

    const label = document.createElement('span');
    label.textContent = 'Create';
    label.style.fontSize = '12px';

    const numberInput = document.createElement('input');
    numberInput.type = 'number';
    numberInput.min = '1';
    numberInput.max = '10';
    numberInput.value = '3';
    numberInput.style.width = '50px';
    numberInput.style.padding = '6px';
    numberInput.style.background = '#262626';
    numberInput.style.border = '1px solid #404040';
    numberInput.style.color = '#fff';
    numberInput.style.borderRadius = '4px';
    numberInput.style.textAlign = 'center';
    numberInput.style.fontSize = '12px';

    const roomsLabel = document.createElement('span');
    roomsLabel.textContent = 'breakout rooms';
    roomsLabel.style.fontSize = '12px';

    numberContainer.appendChild(label);
    numberContainer.appendChild(numberInput);
    numberContainer.appendChild(roomsLabel);
    createSection.appendChild(numberContainer);

    // Assignment method
    const methodContainer = document.createElement('div');
    methodContainer.style.marginBottom = '12px';

    const methodLabel = document.createElement('div');
    methodLabel.textContent = 'Assignment Method';
    methodLabel.style.fontSize = '11px';
    methodLabel.style.fontWeight = 'bold';
    methodLabel.style.marginBottom = '8px';
    methodLabel.style.color = '#999';
    methodContainer.appendChild(methodLabel);

    const methods = [
        { value: 'automatic', label: 'Assign automatically' },
        { value: 'manual', label: 'Assign manually' },
        { value: 'participant-choice', label: 'Let participants choose room' }
    ];

    methods.forEach(method => {
        const radioContainer = document.createElement('div');
        radioContainer.style.display = 'flex';
        radioContainer.style.alignItems = 'center';
        radioContainer.style.marginBottom = '6px';

        const radio = document.createElement('input');
        radio.type = 'radio';
        radio.name = 'assignment-method';
        radio.value = method.value;
        radio.checked = method.value === 'manual';
        radio.style.cursor = 'pointer';
        radio.onchange = () => { assignmentMethod = method.value; };

        const radioLabel = document.createElement('label');
        radioLabel.textContent = method.label;
        radioLabel.style.marginLeft = '8px';
        radioLabel.style.fontSize = '11px';
        radioLabel.style.cursor = 'pointer';
        radioLabel.onclick = () => radio.click();

        radioContainer.appendChild(radio);
        radioContainer.appendChild(radioLabel);
        methodContainer.appendChild(radioContainer);
    });

    createSection.appendChild(methodContainer);

    // Create button
    const createBtn = document.createElement('button');
    createBtn.textContent = '✨ Create';
    createBtn.style.width = '100%';
    createBtn.style.padding = '10px';
    createBtn.style.background = '#1d4ed8';
    createBtn.style.color = '#fff';
    createBtn.style.border = 'none';
    createBtn.style.borderRadius = '4px';
    createBtn.style.cursor = 'pointer';
    createBtn.style.fontSize = '13px';
    createBtn.style.fontWeight = 'bold';
    createBtn.onmouseover = () => createBtn.style.background = '#1e40af';
    createBtn.onmouseout = () => createBtn.style.background = '#1d4ed8';
    createBtn.onclick = () => {
        const count = parseInt(numberInput.value);
        if (count > 0) {
            socket.emit('create-breakout-rooms', {
                meetingId,
                count,
                assignmentMethod
            });
            showNotification(`✅ Creating ${count} breakout room${count > 1 ? 's' : ''}...`);
        } else {
            showNotification('❌ Invalid number of rooms');
        }
    };
    createSection.appendChild(createBtn);
    panel.appendChild(createSection);

    // Rooms List
    const roomsList = document.createElement('div');
    roomsList.id = 'breakoutRoomsList';
    roomsList.style.flex = '1';
    roomsList.style.overflowY = 'auto';
    roomsList.style.padding = '15px';
    panel.appendChild(roomsList);

    // Footer
    const footer = document.createElement('div');
    footer.style.padding = '12px';
    footer.style.borderTop = '1px solid #333';
    footer.style.display = 'flex';
    footer.style.gap = '8px';
    footer.style.position = 'sticky';
    footer.style.bottom = '0';
    footer.style.background = '#111';

    const closeAllBtn = document.createElement('button');
    closeAllBtn.textContent = '🔴 Close All';
    closeAllBtn.style.flex = '1';
    closeAllBtn.style.padding = '10px';
    closeAllBtn.style.background = '#f44336';
    closeAllBtn.style.color = '#fff';
    closeAllBtn.style.border = 'none';
    closeAllBtn.style.borderRadius = '4px';
    closeAllBtn.style.cursor = 'pointer';
    closeAllBtn.style.fontSize = '12px';
    closeAllBtn.onclick = () => {
        if (confirm('Close all breakout rooms?')) {
            socket.emit('close-all-breakout-rooms', { meetingId });
        }
    };

    footer.appendChild(closeAllBtn);
    panel.appendChild(footer);

    document.body.appendChild(panel);
    renderBreakoutRooms(panel);

    // When the host opens the breakout panel, request the
    // latest rooms list from the server so rooms created
    // earlier (before a refresh or rejoin) still appear.
    if (socket) {
        try {
            socket.emit('get-breakout-rooms', { meetingId }, (response) => {
                try {
                    if (!response || !response.success || !Array.isArray(response.rooms)) return;

                    breakoutRoomsData = {};
                    response.rooms.forEach((room) => {
                        breakoutRoomsData[room.id] = room;
                    });
                    renderBreakoutRooms(panel);
                } catch (e) {
                    console.error('Error handling get-breakout-rooms response:', e);
                }
            });
        } catch (e) {
            console.error('Error requesting breakout rooms list:', e);
        }
    }
}

function renderBreakoutRooms(panel) {
    const roomsList = panel.querySelector('#breakoutRoomsList');
    if (!roomsList) return;

    roomsList.innerHTML = '';

    const rooms = Object.values(breakoutRoomsData || {});
    if (rooms.length === 0) {
        roomsList.innerHTML = '<div style="text-align: center; color: #999; font-size: 12px; padding: 20px;">No rooms created yet</div>';
        return;
    }

    rooms.forEach(room => {
        const roomCard = document.createElement('div');
        roomCard.style.background = '#1a1a1a';
        roomCard.style.border = '1px solid #333';
        roomCard.style.borderRadius = '6px';
        roomCard.style.padding = '12px';
        roomCard.style.marginBottom = '12px';
        roomCard.style.fontSize = '12px';

        // Room name header
        const roomHeader = document.createElement('div');
        roomHeader.style.display = 'flex';
        roomHeader.style.justifyContent = 'space-between';
        roomHeader.style.alignItems = 'center';
        roomHeader.style.marginBottom = '8px';

        const roomName = document.createElement('strong');
        roomName.textContent = room.name;
        roomName.style.color = '#4CAF50';

        const participantCount = document.createElement('span');
        participantCount.textContent = `${room.participants.length} participant${room.participants.length !== 1 ? 's' : ''}`;
        participantCount.style.color = '#999';
        participantCount.style.fontSize = '11px';

        roomHeader.appendChild(roomName);
        roomHeader.appendChild(participantCount);
        roomCard.appendChild(roomHeader);

        // Room link (copyable)
        const linkContainer = document.createElement('div');
        linkContainer.style.marginBottom = '8px';
        linkContainer.style.padding = '8px';
        linkContainer.style.background = '#262626';
        linkContainer.style.borderRadius = '4px';
        linkContainer.style.fontSize = '10px';

        const linkInput = document.createElement('input');
        linkInput.type = 'text';
        linkInput.value = room.link;
        linkInput.readOnly = true;
        linkInput.style.width = '100%';
        linkInput.style.padding = '6px';
        linkInput.style.background = '#333';
        linkInput.style.border = '1px solid #404040';
        linkInput.style.color = '#4CAF50';
        linkInput.style.fontSize = '9px';
        linkInput.style.borderRadius = '3px';
        linkInput.style.marginBottom = '6px';
        linkInput.style.fontFamily = 'monospace';
        linkInput.style.cursor = 'text';

        const copyLinkBtn = document.createElement('button');
        copyLinkBtn.textContent = '📋 Copy Link';
        copyLinkBtn.style.width = '100%';
        copyLinkBtn.style.padding = '6px';
        copyLinkBtn.style.background = '#404040';
        copyLinkBtn.style.color = '#fff';
        copyLinkBtn.style.border = 'none';
        copyLinkBtn.style.borderRadius = '3px';
        copyLinkBtn.style.cursor = 'pointer';
        copyLinkBtn.style.fontSize = '10px';
        copyLinkBtn.onclick = () => {
            linkInput.select();
            document.execCommand('copy');
            showNotification('✅ Link copied!');
        };

        linkContainer.appendChild(linkInput);
        linkContainer.appendChild(copyLinkBtn);
        roomCard.appendChild(linkContainer);

        // Participants list (with per-user record controls for host)
        if (room.participants.length > 0) {
            const participantsList = document.createElement('div');
            participantsList.style.marginBottom = '8px';
            participantsList.style.paddingLeft = '8px';
            participantsList.style.borderLeft = '2px solid #4CAF50';

            const socketIds = room.socketIds || [];

            room.participants.forEach((participant, index) => {
                if (index >= 4) return; // keep list compact

                const row = document.createElement('div');
                row.style.display = 'flex';
                row.style.alignItems = 'center';
                row.style.justifyContent = 'space-between';
                row.style.marginBottom = '4px';

                const nameSpan = document.createElement('span');
                const displayName = typeof participant === 'string' ? participant : (participant.userName || participant.name || 'Unknown');
                nameSpan.textContent = '✓ ' + displayName;
                nameSpan.style.color = '#4CAF50';
                nameSpan.style.fontSize = '11px';

                row.appendChild(nameSpan);

                // If we are host and have a socketId for this participant,
                // allow starting/stopping audio recording directly from the
                // breakout room card.
                const socketId = socketIds[index];
                if (isHost && socketId && socketId !== socket.id) {
                    const recBtn = document.createElement('button');
                    recBtn.style.padding = '2px 6px';
                    recBtn.style.fontSize = '10px';
                    recBtn.style.borderRadius = '4px';
                    recBtn.style.border = 'none';
                    recBtn.style.cursor = 'pointer';

                    const isRec = !!recordingParticipants[socketId];
                    recBtn.dataset.socketId = socketId;
                    recBtn.dataset.recording = isRec ? 'true' : 'false';
                    recBtn.textContent = isRec ? '⏹️' : '⏺️';
                    recBtn.title = isRec ? 'Stop recording' : 'Record audio';
                    if (isRec) recBtn.style.background = '#b91c1c';
                    else recBtn.style.background = '#1d4ed8';
                    recBtn.style.color = '#fff';

                    recBtn.onclick = () => {
                        const sid = recBtn.dataset.socketId;
                        const currentlyRecording = recBtn.dataset.recording === 'true';
                        if (!sid) return;

                        if (currentlyRecording) {
                            // Stop
                            delete recordingParticipants[sid];
                            recBtn.dataset.recording = 'false';
                            recBtn.textContent = '⏺️';
                            recBtn.title = 'Record audio';
                            recBtn.style.background = '#1d4ed8';
                            socket.emit('host-stop-record-user', { meetingId, targetSocketId: sid });
                            showNotification(`⏹️ Stopped recording ${displayName}`);
                        } else {
                            // Start
                            recordingParticipants[sid] = true;
                            recBtn.dataset.recording = 'true';
                            recBtn.textContent = '⏹️';
                            recBtn.title = 'Stop recording';
                            recBtn.style.background = '#b91c1c';
                            socket.emit('host-start-record-user', { meetingId, targetSocketId: sid });
                            showNotification(`🔴 Recording ${displayName}`);
                        }
                    };

                    row.appendChild(recBtn);
                }

                participantsList.appendChild(row);
            });

            if (room.participants.length > 4) {
                const more = document.createElement('div');
                more.textContent = `+${room.participants.length - 4} more`;
                more.style.color = '#999';
                more.style.fontSize = '10px';
                more.style.marginTop = '4px';
                participantsList.appendChild(more);
            }

            roomCard.appendChild(participantsList);
        }

        // Actions
        const actions = document.createElement('div');
        actions.style.display = 'flex';
        actions.style.gap = '6px';

        const assignBtn = document.createElement('button');
        assignBtn.textContent = '👥 Assign';
        assignBtn.style.flex = '1';
        assignBtn.style.padding = '6px';
        assignBtn.style.background = '#404040';
        assignBtn.style.color = '#fff';
        assignBtn.style.border = 'none';
        assignBtn.style.borderRadius = '4px';
        assignBtn.style.cursor = 'pointer';
        assignBtn.style.fontSize = '11px';
        assignBtn.onclick = () => showParticipantsForRoom(room.id);

        const joinBtn = document.createElement('button');
        joinBtn.textContent = '🚪 Join';
        joinBtn.style.flex = '1';
        joinBtn.style.padding = '6px';
        joinBtn.style.background = '#1d4ed8';
        joinBtn.style.color = '#fff';
        joinBtn.style.border = 'none';
        joinBtn.style.borderRadius = '4px';
        joinBtn.style.cursor = 'pointer';
        joinBtn.style.fontSize = '11px';
        joinBtn.onclick = () => {
            // Always build breakout URL from current origin + meetingId +
            // breakoutId so we are sure breakoutId is present.
            try {
                const base = window.location.origin;
                const url = new URL('/meeting', base);
                url.searchParams.set('roomId', meetingId);
                url.searchParams.set('breakoutId', room.id);
                if (isHost) url.searchParams.set('host', 'true');
                showNotification(`📍 Joining ${room.name}...`);
                window.location.href = url.toString();
            } catch (e) {
                // Fallback: if URL building fails, at least try original link
                const fallback = room.link || window.location.href;
                showNotification(`📍 Joining ${room.name}...`);
                window.location.href = fallback;
            }
        };

        const closeBtn = document.createElement('button');
        closeBtn.textContent = '❌ Close';
        closeBtn.style.flex = '1';
        closeBtn.style.padding = '6px';
        closeBtn.style.background = '#f44336';
        closeBtn.style.color = '#fff';
        closeBtn.style.border = 'none';
        closeBtn.style.borderRadius = '4px';
        closeBtn.style.cursor = 'pointer';
        closeBtn.style.fontSize = '11px';
        closeBtn.onclick = () => {
            socket.emit('close-breakout-room', { meetingId, roomId: room.id });
        };

        actions.appendChild(assignBtn);
        actions.appendChild(joinBtn);
        actions.appendChild(closeBtn);
        roomCard.appendChild(actions);

        roomsList.appendChild(roomCard);
    });
}

function maybeShowBreakoutInviteFromRooms(rooms) {
    try {
        if (!rooms || !userName || isInBreakoutRoom) return;

        for (const room of rooms) {
            if (!room || !room.participants) continue;
            const names = room.participants.map(p =>
                typeof p === 'string' ? p : (p.userName || p.name || '')
            );
            if (names.includes(userName)) {
                if (lastBreakoutInviteRoomId === room.id) return;
                lastBreakoutInviteRoomId = room.id;
                showBreakoutRoomInvitation(room.name, room.link, null, room.id, meetingId);
                break;
            }
        }
    } catch (e) {
        console.error('Error checking breakout invite from rooms:', e);
    }
}

function showParticipantsForRoom(roomId) {
    const room = breakoutRoomsData[roomId];
    if (!room) return;

    const modal = document.createElement('div');
    modal.style.position = 'fixed';
    modal.style.top = '0';
    modal.style.left = '0';
    modal.style.width = '100%';
    modal.style.height = '100%';
    modal.style.background = 'rgba(0,0,0,0.7)';
    modal.style.display = 'flex';
    modal.style.alignItems = 'center';
    modal.style.justifyContent = 'center';
    modal.style.zIndex = '200';

    const content = document.createElement('div');
    content.style.background = '#222';
    content.style.color = '#fff';
    content.style.padding = '20px';
    content.style.borderRadius = '8px';
    content.style.maxWidth = '400px';
    content.style.maxHeight = '80vh';
    content.style.overflowY = 'auto';

    const title = document.createElement('h3');
    title.textContent = `Assign to "${room.name}"`;
    title.style.marginTop = '0';
    title.style.marginBottom = '15px';
    title.style.color = '#4CAF50';
    content.appendChild(title);

    const participantItems = document.querySelectorAll('.participant-item');
    let assignedCount = 0;

    participantItems.forEach(item => {
        const nameEl = item.querySelector('strong');
        if (!nameEl) return;

        // Read from dataset set in updateParticipants so we have socketId
        const userName = item.dataset.userName || nameEl.textContent;
        const socketId = item.dataset.socketId;

        if (!socketId) return; // cannot assign without socket id
        if (room.participants.includes(userName)) return;

        const userDiv = document.createElement('div');
        userDiv.style.display = 'flex';
        userDiv.style.justifyContent = 'space-between';
        userDiv.style.alignItems = 'center';
        userDiv.style.padding = '10px';
        userDiv.style.background = '#333';
        userDiv.style.borderRadius = '4px';
        userDiv.style.marginBottom = '8px';

        const name = document.createElement('span');
        name.textContent = userName;

        const addBtn = document.createElement('button');
        addBtn.textContent = '➕ Add';
        addBtn.style.padding = '6px 12px';
        addBtn.style.background = '#4CAF50';
        addBtn.style.color = '#fff';
        addBtn.style.border = 'none';
        addBtn.style.borderRadius = '4px';
        addBtn.style.cursor = 'pointer';
        addBtn.style.fontSize = '11px';
        addBtn.onclick = () => {
            socket.emit('assign-to-breakout', {
                meetingId,
                roomId,
                userName,
                socketId
            });

            room.participants.push(userName);
            userDiv.style.opacity = '0.5';
            addBtn.disabled = true;
            addBtn.textContent = '✓ Added';
            showNotification(`✅ Invited ${userName} to ${room.name}`);
            assignedCount++;
        };

        userDiv.appendChild(name);
        userDiv.appendChild(addBtn);
        content.appendChild(userDiv);
    });

    const closeBtn = document.createElement('button');
    closeBtn.textContent = 'Done';
    closeBtn.style.width = '100%';
    closeBtn.style.marginTop = '15px';
    closeBtn.style.padding = '10px';
    closeBtn.style.background = '#4CAF50';
    closeBtn.style.color = '#fff';
    closeBtn.style.border = 'none';
    closeBtn.style.borderRadius = '4px';
    closeBtn.style.cursor = 'pointer';
    closeBtn.onclick = () => modal.remove();
    content.appendChild(closeBtn);

    modal.appendChild(content);
    document.body.appendChild(modal);
}

// (second legacy definition of showBreakoutRoomInvitation removed; unified above)

// Close all peer connections (used when switching rooms)
function closeAllPeerConnections() {
    Object.values(peers).forEach((peer) => {
        try {
            peer.connection.close();
        } catch (e) {
            console.error("Error closing peer:", e);
        }
    });
    peers = {};

    Object.values(participantRemovalTimers).forEach((timerId) => {
        clearTimeout(timerId);
    });
    participantRemovalTimers = {};
    participantSocketByKey = {};
}

function generateMeetingId() {
    return "room-" + Math.random().toString(36).substr(2, 9);
}

// Handle page unload
window.addEventListener("beforeunload", () => {
    if (localStream) {
        localStream.getTracks().forEach((track) => track.stop());
    }
    Object.values(peers).forEach((peer) => {
        try {
            if (peer && peer.connection) {
                peer.connection.close();
            }
        } catch (e) {
            console.error("Error closing peer on unload:", e);
        }
    });
    if (socket && typeof socket.disconnect === "function") {
        socket.disconnect();
    }
    participantSocketByKey = {};
});