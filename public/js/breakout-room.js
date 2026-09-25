const socket = io();
let localStream = null;
let peerConnections = {};
let roomId = null;
let meetingId = null;
let userName = null;
let isMicOn = true;
let isCameraOn = true;
const participants = new Map();
let chatMessages = [];
let isRecording = false;
let mediaRecorder = null;
let recordedChunks = [];

// Initialize breakout room
window.addEventListener('DOMContentLoaded', async() => {
    const storedName = localStorage.getItem('userName') || '';
    const storedEmail = localStorage.getItem('userEmail') || '';
    userName = storedName || (storedEmail ? storedEmail.split('@')[0] : 'Anonymous');
    const params = new URLSearchParams(window.location.search);
    roomId = params.get('roomId');
    // meetingId comes from query string (set by meeting.js) or localStorage fallback
    meetingId = params.get('meetingId') || localStorage.getItem('currentMeetingId');

    if (!roomId || !meetingId) {
        showNotification('❌ No room ID provided', true);
        window.location.href = '/';
        return;
    }

    // Update header with room name if we have it
    const storedRoomName = localStorage.getItem('currentBreakoutRoomName');
    if (storedRoomName) {
        const roomNameSpan = document.getElementById('roomName');
        if (roomNameSpan) {
            roomNameSpan.textContent = storedRoomName;
        }
    }

    try {
        // Get local media
        localStream = await navigator.mediaDevices.getUserMedia({
            audio: true,
            video: { width: 640, height: 480 },
        });

        // Add local video
        addVideoElement(userName, true);

        // Join breakout room on server with proper meeting + breakout ids
        socket.emit('join-breakout-room', {
            meetingId,
            breakoutId: roomId,
            userName
        });

        setupSocketListeners();
        setupControlsListeners();

        // Ensure we notify server when page unloads
        window.addEventListener('beforeunload', () => {
            socket.emit('return-to-main-room', { meetingId, userName, breakoutId: roomId });
        });
    } catch (error) {
        console.error('Error accessing media:', error);
        showNotification('❌ Cannot access camera/microphone', true);
    }
});

// Expose initializer for SPA navigations
window.initializeAriBreakout = async function() {
    // Reuse the same logic as DOMContentLoaded handler
    const event = new Event('DOMContentLoaded');
    window.dispatchEvent(event);
};

function addVideoElement(name, isLocal = false) {
    // Avoid duplicate tiles and invalid entries
    if (!name) return;
    if (participants.has(name) || document.getElementById(`video-${name}`)) {
        return;
    }

    const grid = document.getElementById('videoGrid');
    const videoContainer = document.createElement('div');
    videoContainer.className = 'video-container';
    videoContainer.id = `video-${name}`;

    const video = document.createElement('video');
    video.autoplay = true;
    video.playsinline = true;
    video.muted = isLocal;

    if (isLocal) {
        video.srcObject = localStream;
    }

    const label = document.createElement('div');
    label.className = 'video-label';
    label.textContent = isLocal ? `${name} (You)` : name;

    videoContainer.appendChild(video);
    videoContainer.appendChild(label);
    grid.appendChild(videoContainer);

    participants.set(name, { videoElement: video, container: videoContainer });
    updateParticipantCount();
}

function removeVideoElement(name) {
    const videoContainer = document.getElementById(`video-${name}`);
    if (videoContainer) {
        videoContainer.remove();
    }
    participants.delete(name);
    updateParticipantCount();
}

function updateParticipantCount() {
    const count = document.getElementById('participantCount');
    if (count) {
        count.textContent = participants.size;
    }
}

function toggleMic() {
    if (localStream) {
        localStream.getAudioTracks().forEach(track => {
            track.enabled = !track.enabled;
        });
        isMicOn = !isMicOn;
        const btn = document.getElementById('toggleMicBtn');
        if (btn) {
            btn.classList.toggle('off', !isMicOn);
        }
        socket.emit('user-media-toggle', { roomId, userName, type: 'audio', enabled: isMicOn });
    }
}

function toggleCamera() {
    if (localStream) {
        localStream.getVideoTracks().forEach(track => {
            track.enabled = !track.enabled;
        });
        isCameraOn = !isCameraOn;
        const btn = document.getElementById('toggleCameraBtn');
        if (btn) {
            btn.classList.toggle('off', !isCameraOn);
        }
        socket.emit('user-media-toggle', { roomId, userName, type: 'video', enabled: isCameraOn });
    }
}

function setupControlsListeners() {
    const leaveBtn = document.getElementById('leaveBtn');
    const confirmLeaveBtn = document.getElementById('confirmLeaveBtn');
    const cancelLeaveBtn = document.getElementById('cancelLeaveBtn');
    const toggleChatBtn = document.getElementById('toggleChatBtn');
    const closeChatBtn = document.getElementById('closeChatBtn');
    const sendChatBtn = document.getElementById('sendChatBtn');
    const chatInput = document.getElementById('chatInput');
    const toggleMicBtn = document.getElementById('toggleMicBtn');
    const toggleCameraBtn = document.getElementById('toggleCameraBtn');

    leaveBtn.addEventListener('click', () => {
        document.getElementById('leaveModal').classList.add('show');
    });

    confirmLeaveBtn.addEventListener('click', leaveRoom);
    cancelLeaveBtn.addEventListener('click', () => {
        document.getElementById('leaveModal').classList.remove('show');
    });

    toggleChatBtn.addEventListener('click', () => {
        document.getElementById('chatPanel').classList.toggle('show');
    });

    closeChatBtn.addEventListener('click', () => {
        document.getElementById('chatPanel').classList.remove('show');
    });

    sendChatBtn.addEventListener('click', sendMessage);
    chatInput.addEventListener('keypress', (e) => {
        if (e.key === 'Enter') {
            sendMessage();
        }
    });

    if (toggleMicBtn) {
        toggleMicBtn.addEventListener('click', toggleMic);
    }

    if (toggleCameraBtn) {
        toggleCameraBtn.addEventListener('click', toggleCamera);
    }
}

function sendMessage() {
    const chatInput = document.getElementById('chatInput');
    const message = chatInput.value.trim();
    if (message) {
        socket.emit('room-chat-message', {
            roomId,
            userName,
            message,
            timestamp: new Date()
        });
        chatInput.value = '';
    }
}

function addChatMessage(senderName, message) {
    const chatMessages = document.getElementById('chatMessages');
    const msgElement = document.createElement('div');
    msgElement.className = 'chat-message';
    msgElement.innerHTML = `<div class="sender">${senderName}</div><div class="text">${escapeHtml(message)}</div>`;
    chatMessages.appendChild(msgElement);
    chatMessages.scrollTop = chatMessages.scrollHeight;
}

function leaveRoom() {
    try {
        if (localStream) {
            localStream.getTracks().forEach(track => track.stop());
        }

        // Close all peer connections
        Object.values(peerConnections).forEach(pc => {
            if (pc) pc.close();
        });

        // Tell server we are returning to the main meeting for this breakout's meetingId
        socket.emit('return-to-main-room', { meetingId, userName, breakoutId: roomId });
    } catch (error) {
        console.error('Error during cleanup:', error);
    }

    // Wait a bit for server to process the leave event before redirecting
    const redirectUrl = `/meeting?roomId=${encodeURIComponent(meetingId || '')}`;
    console.log('Redirecting to:', redirectUrl);
    setTimeout(() => {
        window.location.href = redirectUrl;
    }, 500);
}

function setupSocketListeners() {
    // Participant joined room
    socket.on('room-participant-joined', (data) => {
        const { participants: participantsList } = data;
        participantsList.forEach(participant => {
            if (participant.userName !== userName) {
                addVideoElement(participant.userName);
            }
        });
    });

    // Participant left room
    socket.on('room-participant-left', (data) => {
        const { userName: leftUser } = data;
        removeVideoElement(leftUser);
        if (peerConnections[leftUser]) {
            peerConnections[leftUser].close();
            delete peerConnections[leftUser];
        }
    });

    // Receive chat message
    socket.on('room-chat-message', (data) => {
        const { userName: senderName, message } = data;
        addChatMessage(senderName, message);
    });

    // Room closed by host
    socket.on('room-closed-notification', (data) => {
        showNotification(' Room closed by host. Returning to main meeting...', false);
        setTimeout(() => {
            window.location.href = `/meeting?roomId=${encodeURIComponent(meetingId)}`;
        }, 1500);
    });

    // Also handle generic breakout closing events from server
    socket.on('breakout-room-closing', (data = {}) => {
        showNotification(data.message || ' Room closed by host. Returning to main meeting...', false);
        setTimeout(() => {
            window.location.href = `/meeting?roomId=${encodeURIComponent(meetingId)}`;
        }, 1500);
    });

    socket.on('all-breakout-rooms-closing', (data = {}) => {
        showNotification(data.message || ' All breakout rooms are closing. Returning to main meeting...', false);
        setTimeout(() => {
            window.location.href = `/meeting?roomId=${encodeURIComponent(meetingId)}`;
        }, 1500);
    });

    // Server-controlled recording (from host controls in main room)
    socket.on('start-audio-record', (data = {}) => {
        const { fileName } = data;
        startAudioRecording(fileName);
    });

    socket.on('stop-audio-record', () => {
        if (mediaRecorder && mediaRecorder.state !== 'inactive') {
            mediaRecorder.stop();
        }
    });
}

function startAudioRecording(fileName) {
    if (!localStream) {
        showNotification('❌ Local stream not ready', true);
        return;
    }

    const audioTrack = localStream.getAudioTracks()[0];
    if (!audioTrack) {
        showNotification('❌ Microphone not available', true);
        return;
    }

    try {
        const audioStream = new MediaStream([audioTrack]);
        recordedChunks = [];

        mediaRecorder = new MediaRecorder(audioStream, {
            mimeType: 'audio/webm'
        });

        mediaRecorder.ondataavailable = (e) => {
            if (e.data.size > 0) recordedChunks.push(e.data);
        };

        mediaRecorder.onstop = () => {
            const blob = new Blob(recordedChunks, { type: 'audio/webm' });

            if (fileName) {
                socket.emit('upload-audio-recording', {
                    meetingId,
                    userName,
                    fileName: fileName || `audio_${meetingId}_${userName}.webm`,
                    blob
                });
                showNotification('✅ Uploaded recording to server');
            } else {
                const a = document.createElement('a');
                a.href = URL.createObjectURL(blob);
                a.download = `audio_${meetingId}_${userName}.webm`;
                a.click();
                showNotification('✅ Recording saved locally');
            }
        };

        mediaRecorder.start();
        isRecording = true;
        showNotification('🔴 Recording started');
    } catch (err) {
        console.error('Recording error:', err);
        showNotification('❌ Recording error: ' + err.message, true);
    }
}

function showNotification(message, isError = false) {
    const notification = document.createElement('div');
    notification.className = `notification ${isError ? 'error' : ''}`;
    notification.textContent = message;
    document.body.appendChild(notification);

    setTimeout(() => {
        notification.remove();
    }, 3000);
}

function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}