// Socket.IO signaling server for Ari Meet, running on the same
// Node/Next.js server (port 3000). This is adapted from ari_meet/server.js
// but only contains the realtime logic – no Express routes.

import { Server } from "socket.io";
import fs from "fs";
import path from "path";
import { getPrisma } from "../../lib/prisma";

let io;

// In-memory state (per process)
const meetings = {}; // meetingId -> { id, participants, recordings }
const userSockets = {}; // socketId -> { meetingId, userName, email, isHost }
// Track the latest known host socket per meeting (used for host-targeted
// events like recordings-updated). Host authorization itself is based on
// userSockets[socket.id].isHost.
const hosts = {}; // meetingId -> host socket id
const breakoutRooms = {}; // meetingId -> { roomId -> {...} }
const userCurrentRoom = {}; // socketId -> { meetingId, breakoutId }
const lobbies = {}; // meetingId -> [ { socketId, userName, email, joinedAt } ]
const closedMeetings = {}; // meetingId -> { closedAt, closedBy }
// Track participants who have already been admitted at least once so that
// if they refresh and reconnect with the same email, they skip the lobby.
const admittedParticipants = {}; // meetingId -> Set(normalizedEmail)

// Call out to a local Python Whisper server running on localhost.
// This avoids OpenAI quotas but keeps heavy ML work outside of Node.
async function transcribeViaPython(filePath) {
    try {
        const pythonServiceUrl = process.env.PYTHON_SERVICE_URL || "http://127.0.0.1:5001";
        const res = await fetch(`${pythonServiceUrl}/transcribe`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ path: filePath }),
        });

        if (!res.ok) {
            console.error("Python transcription HTTP error:", res.status, await res.text());
            return "";
        }

        const data = await res.json();
        if (data && typeof data.text === "string" && data.text.trim()) {
            return data.text;
        }

        if (data && data.error) {
            console.error("Python transcription returned error:", data.error);
            return `[Transcription error: ${data.error}]`;
        }

        return "";
    } catch (e) {
        console.error("Python transcription request failed:", e);
        return "";
    }
}

// Call out to local Python scoring service to evaluate how well
// a transcript matches the meeting topic/description.
async function scoreViaPython(topic, transcript) {
    try {
        if (!topic || !transcript) return null;

        const pythonServiceUrl = process.env.PYTHON_SERVICE_URL || "http://127.0.0.1:5001";
        const res = await fetch(`${pythonServiceUrl}/score`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ topic, transcript }),
        });

        if (!res.ok) {
            console.error("Python scoring HTTP error:", res.status, await res.text());
            return null;
        }

        const data = await res.json();
        if (!data || typeof data.score !== "number") {
            return null;
        }

        return {
            topic: data.topic || topic,
            reference: data.reference || null,
            similarity: typeof data.similarity === "number" ? data.similarity : null,
            score: data.score,
        };
    } catch (e) {
        console.error("Python scoring request failed:", e);
        return null;
    }
}

function initSocket(server) {
    io = new Server(server, {
        cors: {
            origin: "*",
            methods: ["GET", "POST"],
        },
    });

    io.on("connection", (socket) => {
        console.log("User connected:", socket.id);

        // Helper: check if this socket is a host for the given meeting
        function isSocketHost(meetingId, sock) {
            const info = userSockets[sock.id];
            return !!(info && info.meetingId === meetingId && info.isHost);
        }

        // === JOIN MEETING ===
        socket.on("join-meeting", (data) => {
            try {
                const { meetingId, userName, email, isHost, isBreakout } = data || {};

                if (!meetingId || !userName) {
                    socket.emit("error", { message: "Missing meetingId or userName" });
                    return;
                }

                const closedInfo = closedMeetings[meetingId];
                if (closedInfo) {
                    socket.emit("meeting-closed-by-host", {
                        meetingId,
                        closedBy: closedInfo.closedBy || "Host",
                        closedAt: closedInfo.closedAt,
                    });
                    return;
                }

                // === LIVE CAPTIONS (CC) PERSISTENCE ===
                socket.on("live-caption", async({ meetingId, userName, text, timestamp } = {}) => {
                    try {
                        if (!meetingId || !text) return;

                        const userInfo = userSockets[socket.id];
                        const safeName = (userName || (userInfo && userInfo.userName) || "Unknown").slice(0, 100);
                        const safeText = String(text).slice(0, 1000);

                        const prisma = getPrisma();
                        const meeting = await prisma.meeting.findUnique({
                            where: { roomId: meetingId },
                        });
                        if (!meeting) return;

                        await prisma.liveCaption.create({
                            data: {
                                meetingId: meeting.id,
                                userName: safeName,
                                userEmail: userInfo ? (userInfo.email || null) : null,
                                text: safeText,
                                createdAt: timestamp ? new Date(timestamp) : undefined,
                            },
                        });
                    } catch (err) {
                        console.error("Error in live-caption handler:", err);
                    }
                });

                if (!meetings[meetingId]) {
                    meetings[meetingId] = {
                        id: meetingId,
                        createdAt: new Date(),
                        participants: [],
                        recordings: [],
                    };
                }

                // Trust the isHost flag coming from the client link for this
                // particular socket (e.g. /meeting?roomId=...&host=true).
                // This avoids complex email-based host detection and keeps
                // behavior predictable across main meeting and breakout flows.
                const actualIsHost = !!isHost;

                socket.join(meetingId);
                if (actualIsHost) {
                    hosts[meetingId] = socket.id;
                    const hostToken = `host_${meetingId}_${socket.id}_${Date.now()}`;
                    socket.emit("host-token", { hostToken, meetingId });
                }

                userSockets[socket.id] = {
                    meetingId,
                    userName,
                    email,
                    socketId: socket.id,
                    isHost: actualIsHost,
                };

                // Hosts and breakout pages join the meeting immediately.
                // Regular participants normally go into a lobby (waiting room)
                // so the host can admit them, but if they've already been
                // admitted once with the same email, they should skip the
                // lobby when reconnecting (e.g. after a refresh).
                if (actualIsHost || isBreakout) {
                    if (!isBreakout) {
                        const existingIndex = meetings[meetingId].participants.findIndex((p) => p.id === socket.id);
                        if (existingIndex === -1) {
                            meetings[meetingId].participants.push({
                                id: socket.id,
                                userName,
                                email,
                                joinedAt: new Date(),
                                isHost: actualIsHost,
                            });
                        } else {
                            meetings[meetingId].participants[existingIndex] = {
                                ...meetings[meetingId].participants[existingIndex],
                                userName,
                                email,
                                isHost: actualIsHost,
                            };
                        }

                        io.to(meetingId).emit("user-joined", {
                            id: socket.id,
                            userName,
                            email,
                            isHost: actualIsHost,
                            participants: meetings[meetingId].participants,
                        });

                        console.log(`${userName} joined meeting ${meetingId}`);
                    } else {
                        console.log(`${userName} joined meeting ${meetingId} in breakout-only mode`);
                    }
                } else {
                    const normalizedEmail = (email || "").toLowerCase().trim();
                    const alreadyAdmitted =
                        normalizedEmail &&
                        admittedParticipants[meetingId] &&
                        admittedParticipants[meetingId].has(normalizedEmail);

                    if (alreadyAdmitted) {
                        // Auto-admit returning participant: add them directly
                        // to the participants list and broadcast user-joined.
                        const existingIndex = meetings[meetingId].participants.findIndex(
                            (p) => p.email && p.email.toLowerCase() === normalizedEmail
                        );

                        if (existingIndex === -1) {
                            meetings[meetingId].participants.push({
                                id: socket.id,
                                userName,
                                email,
                                joinedAt: new Date(),
                                isHost: false,
                            });
                        } else {
                            meetings[meetingId].participants[existingIndex] = {
                                ...meetings[meetingId].participants[existingIndex],
                                id: socket.id,
                                userName,
                                email,
                            };
                        }

                        // Notify this client that they're in the meeting
                        socket.emit("admitted-to-meeting", { meetingId });

                        // Broadcast normal user-joined so peers/WebRTC set up
                        io.to(meetingId).emit("user-joined", {
                            id: socket.id,
                            userName,
                            email,
                            isHost: false,
                            participants: meetings[meetingId].participants,
                        });

                        console.log(`${userName} rejoined meeting ${meetingId} (auto-admitted)`);
                        return;
                    }

                    // Regular participant: put into lobby
                    if (!lobbies[meetingId]) lobbies[meetingId] = [];

                    const existingWaiting = lobbies[meetingId].find((w) => w.socketId === socket.id);
                    if (!existingWaiting) {
                        lobbies[meetingId].push({
                            socketId: socket.id,
                            userName,
                            email,
                            joinedAt: new Date(),
                        });
                    }

                    // Notify host(s) of updated lobby
                    const hostSocketId = hosts[meetingId];
                    if (hostSocketId) {
                        io.to(hostSocketId).emit("lobby-updated", {
                            meetingId,
                            waiting: lobbies[meetingId],
                        });
                    }

                    // Let this participant know they are waiting for host
                    socket.emit("waiting-for-host", { meetingId });

                    console.log(`${userName} is waiting in lobby for meeting ${meetingId}`);
                }
            } catch (error) {
                console.error("Error in join-meeting:", error);
                socket.emit("error", { message: "Error joining meeting" });
            }
        });

        // === WebRTC signalling ===
        socket.on("offer", (data) => {
            try {
                const { to, offer, from, userName } = data || {};
                if (to && offer && from) {
                    io.to(to).emit("offer", { offer, from, userName });
                }
            } catch (error) {
                console.error("Error handling offer:", error);
            }
        });

        socket.on("answer", (data) => {
            try {
                const { to, answer, from } = data || {};
                if (to && answer && from) {
                    io.to(to).emit("answer", { answer, from });
                }
            } catch (error) {
                console.error("Error handling answer:", error);
            }
        });

        socket.on("ice-candidate", (data) => {
            try {
                const { to, candidate, from } = data || {};
                if (to && candidate && from) {
                    io.to(to).emit("ice-candidate", { candidate, from });
                }
            } catch (error) {
                console.error("Error handling ice-candidate:", error);
            }
        });

        // === Chat (text + optional images) ===
        socket.on("send-message", (data = {}) => {
            try {
                const userInfo = userSockets[socket.id];
                if (!userInfo) return;

                const rawMessage = typeof data.message === "string" ? data.message : "";
                const hasMessage = rawMessage.trim().length > 0;
                const sanitizedMessage = hasMessage ?
                    rawMessage.trim().substring(0, 500) :
                    "";

                let imageData = "";
                if (data.image && typeof data.image === "string") {
                    // Basic guard: only allow data URLs that look like images
                    if (data.image.startsWith("data:image/")) {
                        // Reject oversized payloads instead of truncating them.
                        // Truncation corrupts the base64 data and produces broken images.
                        if (data.image.length <= 300000) {
                            imageData = data.image;
                        } else {
                            console.warn("Dropping oversized image payload from", socket.id);
                        }
                    }
                }

                if (!sanitizedMessage && !imageData) {
                    return; // nothing valid to broadcast
                }

                io.to(userInfo.meetingId).emit("receive-message", {
                    message: sanitizedMessage,
                    image: imageData,
                    userName: userInfo.userName,
                    timestamp: new Date(),
                });
            } catch (error) {
                console.error("Error in send-message:", error);
            }
        });

        // === Emoji Reactions ===
        socket.on("send-reaction", (data = {}) => {
            try {
                const userInfo = userSockets[socket.id];
                if (!userInfo || !data.emoji) return;

                const emoji = String(data.emoji).slice(0, 4);
                io.to(userInfo.meetingId).emit("reaction", {
                    emoji,
                    from: userInfo.userName,
                    timestamp: new Date(),
                });
            } catch (error) {
                console.error("Error in send-reaction:", error);
            }
        });

        // === Camera on/off state ===
        socket.on("camera-state-changed", (data = {}) => {
            try {
                const userInfo = userSockets[socket.id];
                if (!userInfo) return;
                const cameraOn = !!data.cameraOn;
                io.to(userInfo.meetingId).emit("camera-state-changed", {
                    socketId: socket.id,
                    cameraOn,
                    userName: userInfo.userName,
                    timestamp: new Date(),
                });
            } catch (error) {
                console.error("Error in camera-state-changed:", error);
            }
        });

        // === Persistent Raise Hand ===
        socket.on("toggle-hand", (data = {}) => {
            try {
                const userInfo = userSockets[socket.id];
                if (!userInfo) return;

                const raised = !!data.raised;
                io.to(userInfo.meetingId).emit("hand-toggled", {
                    socketId: socket.id,
                    userName: userInfo.userName,
                    raised,
                    timestamp: new Date(),
                });
            } catch (error) {
                console.error("Error in toggle-hand:", error);
            }
        });

        // === Lobby (Waiting Room) Controls ===
        socket.on("admit-participant", ({ meetingId, targetSocketId } = {}) => {
            try {
                if (!isSocketHost(meetingId, socket)) return;
                if (!meetingId || !targetSocketId || !lobbies[meetingId]) return;

                const idx = lobbies[meetingId].findIndex((w) => w.socketId === targetSocketId);
                if (idx === -1) return;

                const waitingUser = lobbies[meetingId][idx];
                lobbies[meetingId].splice(idx, 1);

                const info = userSockets[targetSocketId];
                if (!info) return;

                // Move from lobby to full participant list
                const existingIndex = meetings[meetingId].participants.findIndex((p) => p.id === targetSocketId);
                if (existingIndex === -1) {
                    meetings[meetingId].participants.push({
                        id: targetSocketId,
                        userName: waitingUser.userName,
                        email: waitingUser.email,
                        joinedAt: new Date(),
                        isHost: false,
                    });
                }

                // Remember that this email has been admitted so future
                // reconnects with the same email skip the lobby.
                const normalizedEmail = (waitingUser.email || "").toLowerCase().trim();
                if (normalizedEmail) {
                    if (!admittedParticipants[meetingId]) {
                        admittedParticipants[meetingId] = new Set();
                    }
                    admittedParticipants[meetingId].add(normalizedEmail);
                }

                // Notify the admitted user
                io.to(targetSocketId).emit("admitted-to-meeting", { meetingId });

                // Broadcast normal user-joined to the meeting
                io.to(meetingId).emit("user-joined", {
                    id: targetSocketId,
                    userName: waitingUser.userName,
                    email: waitingUser.email,
                    isHost: false,
                    participants: meetings[meetingId].participants,
                });

                // Update lobby list for host
                const hostSocketId = hosts[meetingId];
                if (hostSocketId) {
                    io.to(hostSocketId).emit("lobby-updated", {
                        meetingId,
                        waiting: lobbies[meetingId] || [],
                    });
                }
            } catch (error) {
                console.error("Error in admit-participant:", error);
            }
        });

        socket.on("admit-all-participants", ({ meetingId } = {}) => {
            try {
                if (!isSocketHost(meetingId, socket)) return;
                if (!meetingId || !lobbies[meetingId] || lobbies[meetingId].length === 0) return;

                const waitingList = [...lobbies[meetingId]];
                lobbies[meetingId] = [];

                waitingList.forEach((waitingUser) => {
                    const targetSocketId = waitingUser.socketId;
                    const info = userSockets[targetSocketId];
                    if (!info) return;

                    const existingIndex = meetings[meetingId].participants.findIndex((p) => p.id === targetSocketId);
                    if (existingIndex === -1) {
                        meetings[meetingId].participants.push({
                            id: targetSocketId,
                            userName: waitingUser.userName,
                            email: waitingUser.email,
                            joinedAt: new Date(),
                            isHost: false,
                        });
                    }

                    // Mark this email as admitted.
                    const normalizedEmail = (waitingUser.email || "").toLowerCase().trim();
                    if (normalizedEmail) {
                        if (!admittedParticipants[meetingId]) {
                            admittedParticipants[meetingId] = new Set();
                        }
                        admittedParticipants[meetingId].add(normalizedEmail);
                    }

                    // Notify each admitted user
                    io.to(targetSocketId).emit("admitted-to-meeting", { meetingId });

                    // Broadcast a normal user-joined event per participant so
                    // the existing client logic sets up WebRTC peers
                    io.to(meetingId).emit("user-joined", {
                        id: targetSocketId,
                        userName: waitingUser.userName,
                        email: waitingUser.email,
                        isHost: false,
                        participants: meetings[meetingId].participants,
                    });
                });

                const hostSocketId = hosts[meetingId];
                if (hostSocketId) {
                    io.to(hostSocketId).emit("lobby-updated", {
                        meetingId,
                        waiting: [],
                    });
                }
            } catch (error) {
                console.error("Error in admit-all-participants:", error);
            }
        });

        // === Screen share ===
        socket.on("screen-share-start", () => {
            try {
                const userInfo = userSockets[socket.id];
                if (userInfo) {
                    io.to(userInfo.meetingId).emit("screen-share-started", {
                        userId: socket.id,
                        userName: userInfo.userName,
                    });
                }
            } catch (error) {
                console.error("Error in screen-share-start:", error);
            }
        });

        socket.on("screen-share-stop", () => {
            try {
                const userInfo = userSockets[socket.id];
                if (userInfo) {
                    io.to(userInfo.meetingId).emit("screen-share-stopped", {
                        userId: socket.id,
                    });
                }
            } catch (error) {
                console.error("Error in screen-share-stop:", error);
            }
        });

        // === Host mic / recording controls ===
        socket.on("mic-control", ({ meetingId, targetUserId, allowed } = {}) => {
            try {
                if (isSocketHost(meetingId, socket) && targetUserId) {
                    io.to(targetUserId).emit("mic-control", { allowed });
                }
            } catch (error) {
                console.error("Error in mic-control:", error);
            }
        });

        socket.on("host-mute-user", ({ meetingId, targetSocketId } = {}) => {
            try {
                if (!isSocketHost(meetingId, socket)) return;
                if (targetSocketId) {
                    io.to(targetSocketId).emit("force-mute");
                }
            } catch (error) {
                console.error("Error in host-mute-user:", error);
            }
        });

        socket.on("host-mute-all", ({ meetingId } = {}) => {
            try {
                if (!isSocketHost(meetingId, socket)) return;
                io.to(meetingId).emit("force-mute");
            } catch (error) {
                console.error("Error in host-mute-all:", error);
            }
        });

        // === Explicitly update a participant's host role (promote/demote) ===
        socket.on("update-host-role", ({ meetingId, targetSocketId, makeHost } = {}) => {
            try {
                if (!isSocketHost(meetingId, socket)) return;
                if (!meetingId || !targetSocketId || typeof makeHost !== "boolean") return;

                const targetInfo = userSockets[targetSocketId];
                if (!targetInfo || targetInfo.meetingId !== meetingId) return;

                const meeting = meetings[meetingId];
                if (!meeting) return;

                // Update in socket-level map
                targetInfo.isHost = !!makeHost;

                // Update in meeting participants list
                const pIndex = meeting.participants.findIndex((p) => p.id === targetSocketId);
                if (pIndex !== -1) {
                    meeting.participants[pIndex].isHost = !!makeHost;
                }

                // Maintain a primary host mapping for lobby/recording signals
                if (makeHost) {
                    if (!hosts[meetingId]) {
                        hosts[meetingId] = targetSocketId;
                    }
                } else if (hosts[meetingId] === targetSocketId) {
                    // If we demoted the primary host, pick another host if available
                    const anotherHostEntry = Object.entries(userSockets).find(([sid, info]) =>
                        info.meetingId === meetingId && info.isHost && sid !== targetSocketId
                    );
                    if (anotherHostEntry) {
                        hosts[meetingId] = anotherHostEntry[0];
                    } else {
                        delete hosts[meetingId];
                    }
                }

                // When promoting, also send a host-token to the new host so their UI updates
                if (makeHost) {
                    const hostToken = `host_${meetingId}_${targetSocketId}_${Date.now()}`;
                    io.to(targetSocketId).emit("host-token", { hostToken, meetingId });
                }

                // Broadcast role change + refreshed participant list
                io.to(meetingId).emit("host-role-updated", {
                    meetingId,
                    targetId: targetSocketId,
                    isHost: !!makeHost,
                    targetName: targetInfo.userName,
                });

                io.to(meetingId).emit("participants-updated", {
                    meetingId,
                    participants: meeting.participants,
                });
            } catch (error) {
                console.error("Error in update-host-role:", error);
            }
        });

        // === Transfer host role to another participant ===
        socket.on("transfer-host", ({ meetingId, targetSocketId } = {}) => {
            try {
                if (!isSocketHost(meetingId, socket)) return;
                if (!meetingId || !targetSocketId) return;

                const currentInfo = userSockets[socket.id];
                const targetInfo = userSockets[targetSocketId];
                if (!currentInfo || !targetInfo) return;
                if (currentInfo.meetingId !== meetingId || targetInfo.meetingId !== meetingId) return;

                // Promote target to host but keep existing host(s) as hosts as well
                targetInfo.isHost = true;

                // Update primary host mapping so future host-targeted events
                // (lobby updates, recordings-updated, etc.) go to the new host.
                hosts[meetingId] = targetSocketId;

                // Issue a fresh host-token to the new host so their UI updates
                const hostToken = `host_${meetingId}_${targetSocketId}_${Date.now()}`;
                io.to(targetSocketId).emit("host-token", { hostToken, meetingId });

                // Notify everyone in the meeting about the host transfer
                io.to(meetingId).emit("host-transferred", {
                    meetingId,
                    newHostId: targetSocketId,
                    newHostName: targetInfo.userName,
                    previousHostId: socket.id,
                    previousHostName: currentInfo.userName,
                });
            } catch (error) {
                console.error("Error in transfer-host:", error);
            }
        });

        // === Close meeting (host ends for everyone) ===
        socket.on("close-meeting", ({ meetingId } = {}) => {
            try {
                if (!isSocketHost(meetingId, socket)) return;
                if (!meetingId || !meetings[meetingId]) return;

                // Notify all participants that the meeting has been closed
                const closerInfo = userSockets[socket.id];
                const closedBy = closerInfo && closerInfo.userName ? closerInfo.userName : "Host";
                io.to(meetingId).emit("meeting-closed", {
                    meetingId,
                    closedBy,
                });

                closedMeetings[meetingId] = {
                    closedAt: new Date(),
                    closedBy,
                };

                // Clean up server-side state for this meeting
                delete meetings[meetingId];
                delete breakoutRooms[meetingId];
                delete lobbies[meetingId];
                delete hosts[meetingId];
                delete admittedParticipants[meetingId];

                // Optionally, current host socket leaves the room
                socket.leave(meetingId);
            } catch (error) {
                console.error("Error in close-meeting:", error);
            }
        });

        socket.on("recording-start", async() => {
            try {
                const userInfo = userSockets[socket.id];
                if (!userInfo) return;

                const meetingId = userInfo.meetingId;

                // Broadcast to all participants that a full meeting recording started
                io.to(meetingId).emit("recording-started", {
                    recordedBy: userInfo.userName,
                });

                // Persist a Recording row of type MEETING so we know when the
                // host started a screen/tab recording. The actual video file
                // is downloaded locally on the host's device; we store
                // analytics (who, when, how long) in the database.
                try {
                    const prisma = getPrisma();

                    const meeting = await prisma.meeting.findUnique({
                        where: { roomId: meetingId },
                    });

                    if (meeting) {
                        const startedAt = new Date();
                        const rec = await prisma.recording.create({
                            data: {
                                meetingId: meeting.id,
                                type: "MEETING",
                                userName: userInfo.userName,
                                filePath: "local-download",
                                fileName: "",
                                savedAt: startedAt,
                                startedAt,
                            },
                        });

                        // Track active meeting recording in memory so we can
                        // compute duration when it stops.
                        if (!meetings[meetingId]) {
                            meetings[meetingId] = { participants: [], recordings: [] };
                        }
                        meetings[meetingId].activeMeetingRecording = {
                            id: rec.id,
                            startedAt,
                        };
                    }
                } catch (dbErr) {
                    console.error("Error saving meeting recording start to DB:", dbErr);
                }
            } catch (error) {
                console.error("Error in recording-start:", error);
            }
        });

        socket.on("recording-stop", async() => {
            try {
                const userInfo = userSockets[socket.id];
                if (!userInfo) return;

                const meetingId = userInfo.meetingId;

                io.to(meetingId).emit("recording-stopped", {
                    recordedBy: userInfo.userName,
                });

                // If we previously created a MEETING recording row, update it
                // with end time and duration.
                try {
                    const prisma = getPrisma();
                    const meetingState = meetings[meetingId];

                    if (meetingState && meetingState.activeMeetingRecording) {
                        const { id, startedAt } = meetingState.activeMeetingRecording;
                        const endedAt = new Date();
                        const durationMs = startedAt ? endedAt.getTime() - new Date(startedAt).getTime() : null;

                                await prisma.recording.update({
                            where: { id },
                            data: {
                                endedAt,
                                // If durationMs is null, omit it; otherwise store the value
                                durationMs: durationMs === null ? undefined : durationMs,
                            },
                        });

                        meetingState.activeMeetingRecording = {
                            ...meetingState.activeMeetingRecording,
                            endedAt,
                            durationMs,
                        };
                    }
                } catch (dbErr) {
                    console.error("Error saving meeting recording stop to DB:", dbErr);
                }
            } catch (error) {
                console.error("Error in recording-stop:", error);
            }
        });

        socket.on("host-start-record-user", ({ meetingId, targetSocketId, targetUserName } = {}) => {
            try {
                if (!isSocketHost(meetingId, socket)) return;
                let targetInfo = targetSocketId ? userSockets[targetSocketId] : null;

                if (!targetInfo && targetUserName && meetingId) {
                    const match = Object.values(userSockets).find((info) =>
                        info.meetingId === meetingId && info.userName === targetUserName
                    );
                    if (match) {
                        targetInfo = match;
                        targetSocketId = match.socketId;
                    }
                }

                if (!targetInfo || !targetSocketId) return;

                const safeUserName = targetInfo.userName || "participant";
                const fileName = `${safeUserName.replace(/[^a-z0-9-_]/gi, "_")}_${Date.now()}.webm`;
                io.to(targetSocketId).emit("start-audio-record", { meetingId, fileName });
                io.to(meetingId).emit("recording-started", { recordedBy: safeUserName });
            } catch (error) {
                console.error("Error in host-start-record-user:", error);
            }
        });

        socket.on("host-stop-record-user", ({ meetingId, targetSocketId, targetUserName } = {}) => {
            try {
                if (!isSocketHost(meetingId, socket)) return;
                let targetInfo = targetSocketId ? userSockets[targetSocketId] : null;

                if (!targetInfo && targetUserName && meetingId) {
                    const match = Object.values(userSockets).find((info) =>
                        info.meetingId === meetingId && info.userName === targetUserName
                    );
                    if (match) {
                        targetInfo = match;
                        targetSocketId = match.socketId;
                    }
                }

                if (!targetInfo || !targetSocketId) return;

                const safeUserName = targetInfo.userName || "participant";
                io.to(targetSocketId).emit("stop-audio-record", { meetingId });
                io.to(meetingId).emit("recording-stopped", { recordedBy: safeUserName });
            } catch (error) {
                console.error("Error in host-stop-record-user:", error);
            }
        });

        socket.on("upload-audio-recording", (data = {}) => {
            try {
                const { meetingId, userName, fileName, blob } = data;
                if (!blob || !meetingId || !userName) {
                    console.error("Invalid upload data");
                    return;
                }

                // Save recordings into the public folder so they can be served
                // directly by Next.js at /recordings/<file>. This ensures the
                // <audio> elements can load the file and correctly detect
                // duration instead of showing 0:00 for unreachable URLs.
                const recordingsDir = path.join(process.cwd(), "public", "recordings");
                if (!fs.existsSync(recordingsDir)) {
                    fs.mkdirSync(recordingsDir, { recursive: true });
                }

                const safeName = fileName || `${userName.replace(/[^a-z0-9-_]/gi, "_")}_${Date.now()}.webm`;
                const filePath = path.join(recordingsDir, safeName);

                let buffer = blob;
                if (blob && blob.data && Array.isArray(blob.data)) {
                    buffer = Buffer.from(blob.data);
                } else if (blob instanceof ArrayBuffer) {
                    buffer = Buffer.from(blob);
                }

                fs.writeFile(filePath, buffer, async(err) => {
                    if (err) {
                        console.error("Error saving recording:", err);
                        socket.emit("recording-save-error", { message: "Failed to save recording" });
                        return;
                    }

                    if (meetings[meetingId]) {
                        meetings[meetingId].recordings = meetings[meetingId].recordings || [];
                        meetings[meetingId].recordings.push({
                            userName,
                            file: `/recordings/${safeName}`,
                            fileName: safeName,
                            path: filePath,
                            savedAt: new Date(),
                            transcript: null,
                        });
                    }

                    // Persist participant audio recording metadata to the database
                    try {
                        const prisma = getPrisma();

                        // Find Meeting by roomId (meetingId corresponds to roomId)
                        const meeting = await prisma.meeting.findUnique({
                            where: { roomId: meetingId },
                        });

                        if (meeting) {
                            await prisma.recording.create({
                                data: {
                                    meetingId: meeting.id,
                                    type: "AUDIO",
                                    userName,
                                    filePath: `/recordings/${safeName}`,
                                    fileName: safeName,
                                    savedAt: new Date(),
                                },
                            });
                        }
                    } catch (dbErr) {
                        console.error("Error saving recording metadata to DB:", dbErr);
                    }

                    const hostSocketId = hosts[meetingId];
                    if (hostSocketId) {
                        io.to(hostSocketId).emit("recordings-updated", {
                            meetingId,
                            recordings: meetings[meetingId] ? meetings[meetingId].recordings || [] : [],
                        });
                    }

                    // Trigger background transcription via local Python Whisper server
                    (async() => {
                        try {
                            const text = await transcribeViaPython(filePath);

                            if (meetings[meetingId] && meetings[meetingId].recordings) {
                                const recs = meetings[meetingId].recordings;
                                const rec = recs.find((r) => r.fileName === safeName);
                                if (rec) {
                                    rec.transcript = text;
                                }

                                const hostId = hosts[meetingId];
                                if (hostId) {
                                    io.to(hostId).emit("recordings-updated", {
                                        meetingId,
                                        recordings: recs,
                                    });
                                }
                            }

                            // Also persist transcript text to the database
                            try {
                                const prisma = getPrisma();

                                const meeting = await prisma.meeting.findUnique({
                                    where: { roomId: meetingId },
                                });

                                if (meeting) {
                                    const recordingRow = await prisma.recording.findFirst({
                                        where: {
                                            meetingId: meeting.id,
                                            fileName: safeName,
                                        },
                                    });

                                    if (recordingRow) {
                                        await prisma.recordingTranscript.upsert({
                                            where: { recordingId: recordingRow.id },
                                            update: { text },
                                            create: {
                                                recordingId: recordingRow.id,
                                                text,
                                            },
                                        });
                                    }

                                    // After transcript is saved, compute a score using
                                    // the Python /score endpoint. Use the host-entered
                                    // topic when available, falling back to description.
                                    const topicForScoring =
                                        (meeting.topic && meeting.topic.trim()) ||
                                        (meeting.description && meeting.description.trim()) ||
                                        "";

                                    if (topicForScoring && text && text.trim()) {
                                        try {
                                            const scoring = await scoreViaPython(topicForScoring, text);
                                            if (scoring && meetings[meetingId] && meetings[meetingId].recordings) {
                                                const recs = meetings[meetingId].recordings;
                                                const rec = recs.find((r) => r.fileName === safeName);
                                                if (rec) {
                                                    // Show exactly what the host entered
                                                    // as the Topic in the recordings panel.
                                                    rec.topic = meeting.topic || topicForScoring;
                                                    rec.reference = scoring.reference;
                                                    rec.similarity = scoring.similarity;
                                                    rec.score = scoring.score;
                                                }

                                                const hostId = hosts[meetingId];
                                                if (hostId) {
                                                    io.to(hostId).emit("recordings-updated", {
                                                        meetingId,
                                                        recordings: recs,
                                                    });
                                                }
                                            }
                                        } catch (scoreErr) {
                                            console.error("Error scoring transcript via Python:", scoreErr);
                                        }
                                    }
                                }
                            } catch (txErr) {
                                console.error("Error saving transcript to DB:", txErr);
                            }
                        } catch (e) {
                            console.error("Local Whisper transcription error:", e);
                        }
                    })();
                });
            } catch (error) {
                console.error("Error in upload-audio-recording:", error);
            }
        });

        socket.on("upload-meeting-recording", (data = {}) => {
            try {
                const { meetingId, userName, fileName, blob } = data;
                if (!blob || !meetingId || !userName || !fileName) {
                    console.error("Invalid upload data for meeting recording");
                    return;
                }

                const recordingsDir = path.join(process.cwd(), "public", "recordings");
                if (!fs.existsSync(recordingsDir)) {
                    fs.mkdirSync(recordingsDir, { recursive: true });
                }

                const safeName = fileName.replace(/[^a-z0-9-_.]/gi, "_");
                const filePath = path.join(recordingsDir, safeName);

                let buffer = blob;
                if (blob && blob.data && Array.isArray(blob.data)) {
                    buffer = Buffer.from(blob.data);
                } else if (blob instanceof ArrayBuffer) {
                    buffer = Buffer.from(blob);
                }

                fs.writeFile(filePath, buffer, async(err) => {
                    if (err) {
                        console.error("Error saving meeting recording:", err);
                        socket.emit("recording-save-error", { message: "Failed to save meeting recording" });
                        return;
                    }

                    if (meetings[meetingId]) {
                        meetings[meetingId].recordings = meetings[meetingId].recordings || [];
                        meetings[meetingId].recordings.push({
                            userName,
                            file: `/recordings/${safeName}`,
                            fileName: safeName,
                            path: filePath,
                            savedAt: new Date(),
                            transcript: null,
                        });
                    }

                    try {
                        const prisma = getPrisma();
                        const meeting = await prisma.meeting.findUnique({
                            where: { roomId: meetingId },
                        });
                        if (meeting) {
                            let recordingId;
                            const meetingState = meetings[meetingId];
                            if (meetingState && meetingState.activeMeetingRecording) {
                                recordingId = meetingState.activeMeetingRecording.id;
                            }

                            if (!recordingId) {
                                const pendingRecording = await prisma.recording.findFirst({
                                    where: {
                                        meetingId: meeting.id,
                                        type: "MEETING",
                                        filePath: "local-download",
                                    },
                                    orderBy: {
                                        startedAt: "desc",
                                    },
                                });
                                recordingId = pendingRecording?.id;
                            }

                            if (recordingId) {
                                await prisma.recording.update({
                                    where: { id: recordingId },
                                    data: {
                                        filePath: `/recordings/${safeName}`,
                                        fileName: safeName,
                                        savedAt: new Date(),
                                    },
                                });
                            } else {
                                await prisma.recording.create({
                                    data: {
                                        meetingId: meeting.id,
                                        type: "MEETING",
                                        userName,
                                        filePath: `/recordings/${safeName}`,
                                        fileName: safeName,
                                        savedAt: new Date(),
                                    },
                                });
                            }
                        }
                    } catch (dbErr) {
                        console.error("Error saving meeting recording metadata to DB:", dbErr);
                    }

                    const hostSocketId = hosts[meetingId];
                    if (hostSocketId) {
                        io.to(hostSocketId).emit("recordings-updated", {
                            meetingId,
                            recordings: meetings[meetingId] ? meetings[meetingId].recordings || [] : [],
                        });
                    }

                    const meetingState = meetings[meetingId];
                    if (meetingState && meetingState.activeMeetingRecording) {
                        delete meetingState.activeMeetingRecording;
                    }
                });
            } catch (error) {
                console.error("Error in upload-meeting-recording:", error);
            }
        });

        socket.on("host-delete-recording", ({ meetingId, fileName } = {}) => {
            try {
                if (hosts[meetingId] !== socket.id) return;
                if (!meetings[meetingId] || !meetings[meetingId].recordings) return;

                const recIndex = meetings[meetingId].recordings.findIndex((r) => r.fileName === fileName);
                if (recIndex === -1) return;

                const rec = meetings[meetingId].recordings[recIndex];
                fs.unlink(rec.path, (err) => {
                    if (err) {
                        console.error("Error deleting recording file:", err);
                        return;
                    }
                    meetings[meetingId].recordings.splice(recIndex, 1);
                    const hostSocketId = hosts[meetingId];
                    if (hostSocketId) {
                        io.to(hostSocketId).emit("recordings-updated", {
                            meetingId,
                            recordings: meetings[meetingId].recordings,
                        });
                    }
                });
            } catch (error) {
                console.error("Error in host-delete-recording:", error);
            }
        });

        // Host can request the current list of recordings for a meeting.
        // This is used by the host recordings panel so that recordings
        // remain visible across refreshes or when the host rejoins while
        // the meeting is still alive on the server.
        socket.on("get-recordings", ({ meetingId } = {}, callback) => {
            try {
                if (!meetingId || !meetings[meetingId]) {
                    if (callback) {
                        callback({
                            success: false,
                            recordings: [],
                            message: "Meeting not found",
                        });
                    }
                    return;
                }

                // Only allow the host of this meeting to see the full
                // recordings list.
                if (!isSocketHost(meetingId, socket)) {
                    if (callback) {
                        callback({
                            success: false,
                            recordings: [],
                            message: "Only host can view recordings",
                        });
                    }
                    return;
                }

                const recs = meetings[meetingId].recordings || [];
                if (callback) {
                    callback({ success: true, recordings: recs });
                } else {
                    socket.emit("recordings-updated", { meetingId, recordings: recs });
                }
            } catch (error) {
                console.error("Error in get-recordings:", error);
                if (callback) {
                    callback({
                        success: false,
                        recordings: [],
                        message: "Failed to fetch recordings",
                    });
                }
            }
        });

        // === BREAKOUT ROOMS FEATURES (adapted from ari_meet/server.js) ===

        // Create breakout rooms
        socket.on("create-breakout-rooms", ({ meetingId, count, assignmentMethod } = {}) => {
            try {
                if (!meetings[meetingId]) {
                    socket.emit("error", { message: "Meeting not found" });
                    return;
                }

                if (!isSocketHost(meetingId, socket)) {
                    socket.emit("error", { message: "Only host can create breakout rooms" });
                    return;
                }

                if (!breakoutRooms[meetingId]) {
                    breakoutRooms[meetingId] = {};
                }

                const createdRooms = [];
                const baseUrl = process.env.APP_URL || process.env.NEXT_PUBLIC_BASE_URL || "http://localhost:3000";

                for (let i = 1; i <= count; i++) {
                    const roomId = `${meetingId}-breakout-${Date.now()}-${i}`;
                    const roomLink = `${baseUrl}/meeting?roomId=${meetingId}&breakoutId=${roomId}`;

                    breakoutRooms[meetingId][roomId] = {
                        id: roomId,
                        name: `Room ${i}`,
                        link: roomLink,
                        participants: [],
                        createdAt: new Date(),
                        assignmentMethod: assignmentMethod || "manual",
                        socketIds: [],
                    };

                    createdRooms.push({
                        id: roomId,
                        name: `Room ${i}`,
                        link: roomLink,
                        participants: [],
                        socketIds: [],
                        assignmentMethod: assignmentMethod || "manual",
                    });
                }

                io.to(meetingId).emit("breakout-rooms-created", {
                    rooms: createdRooms,
                    createdBy: userSockets[socket.id] ? userSockets[socket.id].userName : "Host",
                });
            } catch (error) {
                console.error("Error creating breakout rooms:", error);
                socket.emit("error", { message: "Failed to create breakout rooms" });
            }
        });

        // Auto-assign participants
        socket.on("auto-assign-participants", ({ meetingId } = {}) => {
            try {
                if (!meetings[meetingId] || !breakoutRooms[meetingId]) {
                    socket.emit("error", { message: "Meeting or rooms not found" });
                    return;
                }

                if (!isSocketHost(meetingId, socket)) {
                    socket.emit("error", { message: "Only host can assign participants" });
                    return;
                }

                const participantUsers = meetings[meetingId].participants.filter((p) => p.id !== hosts[meetingId]);
                const rooms = Object.values(breakoutRooms[meetingId]);

                if (rooms.length === 0) {
                    socket.emit("error", { message: "No breakout rooms exist" });
                    return;
                }

                rooms.forEach((room) => {
                    room.participants = [];
                    room.socketIds = [];
                });

                participantUsers.forEach((user, index) => {
                    const room = rooms[index % rooms.length];
                    room.participants.push(user.userName);
                    room.socketIds.push(user.id);
                });

                const updatedRooms = Object.values(breakoutRooms[meetingId]).map((r) => ({
                    id: r.id,
                    name: r.name,
                    link: r.link,
                    participants: r.participants,
                    socketIds: r.socketIds || [],
                }));

                io.to(meetingId).emit("participants-auto-assigned", { rooms: updatedRooms });
            } catch (error) {
                console.error("Error in auto-assign:", error);
            }
        });

        // Assign specific participant to room
        socket.on("assign-to-breakout", ({ meetingId, roomId, userName, socketId } = {}) => {
            try {
                if (!meetings[meetingId] || !breakoutRooms[meetingId] || !breakoutRooms[meetingId][roomId]) {
                    socket.emit("error", { message: "Meeting or room not found" });
                    return;
                }

                if (!isSocketHost(meetingId, socket)) {
                    socket.emit("error", { message: "Only host can assign participants" });
                    return;
                }

                const room = breakoutRooms[meetingId][roomId];

                if (!room.participants.includes(userName)) {
                    room.participants.push(userName);
                }
                if (socketId && (!room.socketIds || !room.socketIds.includes(socketId))) {
                    room.socketIds = room.socketIds || [];
                    room.socketIds.push(socketId);
                }

                if (socketId) {
                    io.to(socketId).emit("breakout-room-invite", {
                        roomId,
                        roomName: room.name,
                        link: room.link,
                        invitedBy: userSockets[socket.id] ? userSockets[socket.id].userName : "Host",
                        meetingId,
                    });
                }

                const updatedRooms = Object.values(breakoutRooms[meetingId]).map((r) => ({
                    id: r.id,
                    name: r.name,
                    link: r.link,
                    participants: r.participants,
                    socketIds: r.socketIds || [],
                }));

                io.to(meetingId).emit("room-assignment-updated", {
                    roomId,
                    participants: room.participants,
                    allRooms: updatedRooms,
                });
            } catch (error) {
                console.error("Error assigning to breakout:", error);
                socket.emit("error", { message: "Failed to assign participant" });
            }
        });

        // Participant joins breakout room
        socket.on("join-breakout-room", ({ meetingId, breakoutId, userName } = {}) => {
            try {
                if (!meetingId || !breakoutId) {
                    socket.emit("error", { message: "Invalid meeting or breakout ID" });
                    return;
                }

                const userInfo = userSockets[socket.id];
                const effectiveName = userName || (userInfo ? userInfo.userName : "Guest");

                // Treat joining a breakout as leaving the main meeting room's
                // participant list so the host no longer sees this user in the
                // main participant panel. Also aggressively remove ANY other
                // sockets for this same logical user (same email/userName)
                // that might still be connected to the main meeting (e.g.
                // another tab or stale mobile view).
                if (meetings[meetingId]) {
                    const meeting = meetings[meetingId];
                    const removedParticipants = [];

                    meeting.participants = meeting.participants.filter((p) => {
                        const sameSocket = p.id === socket.id;
                        const sameUserName = p.userName === effectiveName;
                        const sameEmail = userInfo && p.email && userInfo.email && p.email === userInfo.email;

                        if (sameSocket || sameUserName || sameEmail) {
                            removedParticipants.push(p);
                            return false;
                        }
                        return true;
                    });

                    if (removedParticipants.length > 0) {
                        removedParticipants.forEach((removed) => {
                            io.to(meetingId).emit("user-left", {
                                id: removed.id,
                                userName: removed.userName,
                                participants: meeting.participants,
                            });
                        });
                    }
                }

                userCurrentRoom[socket.id] = { meetingId, breakoutId };
                socket.leave(meetingId);
                socket.join(breakoutId);

                // Ensure breakout room model tracks this live socket id so
                // host controls (mute/record) work correctly even after
                // page refreshes or mobile joins.
                if (breakoutRooms[meetingId] && breakoutRooms[meetingId][breakoutId]) {
                    const room = breakoutRooms[meetingId][breakoutId];
                    room.participants = room.participants || [];
                    room.socketIds = room.socketIds || [];

                    const idx = room.participants.findIndex((p) =>
                        (typeof p === "string" ? p : p.userName) === effectiveName
                    );

                    if (idx === -1) {
                        room.participants.push(effectiveName);
                        room.socketIds.push(socket.id);
                    } else {
                        room.socketIds[idx] = socket.id;
                    }

                    const updatedRooms = Object.values(breakoutRooms[meetingId]).map((r) => ({
                        id: r.id,
                        name: r.name,
                        link: r.link,
                        participants: r.participants,
                        socketIds: r.socketIds || [],
                    }));
                    io.to(meetingId).emit("breakout-rooms-updated", { rooms: updatedRooms });
                }

                io.to(breakoutId).emit("user-joined-breakout", {
                    userName: effectiveName,
                    socketId: socket.id,
                    timestamp: new Date(),
                });

                const roomName =
                    breakoutRooms[meetingId] && breakoutRooms[meetingId][breakoutId] ?
                    breakoutRooms[meetingId][breakoutId].name :
                    "Breakout Room";

                socket.emit("joined-breakout-room", {
                    breakoutId,
                    meetingId,
                    roomName,
                });
            } catch (error) {
                console.error("Error joining breakout room:", error);
                socket.emit("error", { message: "Failed to join breakout room" });
            }
        });

        // Host joins any breakout room
        socket.on("host-join-breakout", ({ meetingId, breakoutId, userName } = {}) => {
            try {
                if (!meetings[meetingId]) {
                    socket.emit("error", { message: "Meeting not found" });
                    return;
                }

                if (!isSocketHost(meetingId, socket)) {
                    socket.emit("error", { message: "Only host can join rooms" });
                    return;
                }

                const userInfo = userSockets[socket.id];
                const effectiveName = userName || (userInfo ? userInfo.userName : "Host");

                // When host "joins" a breakout, also remove them from the
                // main meeting participant list so they don't appear twice in
                // the host UI. This mirrors the behaviour for regular
                // participants.
                if (meetings[meetingId]) {
                    meetings[meetingId].participants = meetings[meetingId].participants.filter(
                        (p) => p.id !== socket.id
                    );

                    io.to(meetingId).emit("user-left", {
                        id: socket.id,
                        userName: effectiveName,
                        participants: meetings[meetingId].participants,
                    });
                }

                userCurrentRoom[socket.id] = { meetingId, breakoutId };
                socket.leave(meetingId);
                socket.join(breakoutId);

                io.to(breakoutId).emit("host-joined-breakout", {
                    userName: effectiveName,
                    socketId: socket.id,
                    isHost: true,
                });

                const roomName =
                    breakoutRooms[meetingId] && breakoutRooms[meetingId][breakoutId] ?
                    breakoutRooms[meetingId][breakoutId].name :
                    "Breakout Room";

                socket.emit("joined-breakout-room", {
                    breakoutId,
                    meetingId,
                    roomName,
                    isHost: true,
                });
            } catch (error) {
                console.error("Error host joining breakout:", error);
            }
        });

        // Close individual breakout room
        socket.on("close-breakout-room", ({ meetingId, roomId } = {}) => {
            try {
                if (!meetings[meetingId]) {
                    socket.emit("error", { message: "Meeting not found" });
                    return;
                }

                if (!isSocketHost(meetingId, socket)) {
                    socket.emit("error", { message: "Only host can close rooms" });
                    return;
                }

                const room = breakoutRooms[meetingId] ? breakoutRooms[meetingId][roomId] : undefined;
                if (!room) {
                    socket.emit("error", { message: "Room not found" });
                    return;
                }

                const roomName = room.name;

                io.to(roomId).emit("breakout-room-closing", {
                    roomName,
                    returnTo: meetingId,
                    message: `${roomName} has been closed by the host`,
                });

                setTimeout(() => {
                    io.of("/").in(roomId).socketsLeave(roomId);
                }, 3000);

                delete breakoutRooms[meetingId][roomId];

                const updatedRooms = Object.values(breakoutRooms[meetingId]).map((r) => ({
                    id: r.id,
                    name: r.name,
                    link: r.link,
                    participants: r.participants,
                    socketIds: r.socketIds || [],
                }));

                io.to(meetingId).emit("breakout-room-closed", {
                    roomId,
                    roomName,
                    closedBy: userSockets[socket.id] ? userSockets[socket.id].userName : "Host",
                    remainingRooms: updatedRooms,
                });
            } catch (error) {
                console.error("Error closing breakout room:", error);
                socket.emit("error", { message: "Failed to close room" });
            }
        });

        // Close all breakout rooms
        socket.on("close-all-breakout-rooms", ({ meetingId } = {}) => {
            try {
                if (!meetings[meetingId] || !breakoutRooms[meetingId]) {
                    socket.emit("error", { message: "Meeting not found" });
                    return;
                }

                if (!isSocketHost(meetingId, socket)) {
                    socket.emit("error", { message: "Only host can close rooms" });
                    return;
                }

                const roomIds = Object.keys(breakoutRooms[meetingId]);

                roomIds.forEach((roomId) => {
                    io.to(roomId).emit("all-breakout-rooms-closing", {
                        returnTo: meetingId,
                        message: "All breakout rooms are being closed by the host",
                    });
                    delete breakoutRooms[meetingId][roomId];
                });

                setTimeout(() => {
                    roomIds.forEach((roomId) => {
                        io.of("/").in(roomId).socketsLeave(roomId);
                    });
                }, 3000);

                io.to(meetingId).emit("all-breakout-rooms-closed", {
                    count: roomIds.length,
                    closedBy: userSockets[socket.id] ? userSockets[socket.id].userName : "Host",
                });
            } catch (error) {
                console.error("Error closing all rooms:", error);
            }
        });

        // Get breakout rooms list
        socket.on("get-breakout-rooms", ({ meetingId } = {}, callback) => {
            try {
                const rooms = breakoutRooms[meetingId] || {};
                const roomsList = Object.values(rooms).map((room) => ({
                    id: room.id,
                    name: room.name,
                    link: room.link,
                    participants: room.participants,
                    socketIds: room.socketIds || [],
                    participantCount: room.participants.length,
                    createdAt: room.createdAt,
                }));

                if (callback) callback({ success: true, rooms: roomsList });
                else socket.emit("breakout-rooms-list", roomsList);
            } catch (error) {
                console.error("Error getting breakout rooms:", error);
                if (callback) callback({ success: false, error: error.message });
            }
        });

        // Return to main room
        socket.on("return-to-main-room", (data = {}) => {
            try {
                const { meetingId: providedMeetingId, userName, breakoutId: providedBreakoutId } = data;
                const userRoom =
                    userCurrentRoom[socket.id] || { meetingId: providedMeetingId, breakoutId: providedBreakoutId };
                const meetingId = userRoom.meetingId || providedMeetingId;

                if (userRoom && userRoom.breakoutId) {
                    const roomId = userRoom.breakoutId;
                    const roomMeetingId = userRoom.meetingId || providedMeetingId;

                    socket.leave(roomId);

                    if (breakoutRooms[roomMeetingId] && breakoutRooms[roomMeetingId][roomId]) {
                        const room = breakoutRooms[roomMeetingId][roomId];
                        const participantsArr = room.participants || [];
                        const userInfo = userSockets[socket.id];
                        const effectiveName = userName || (userInfo ? userInfo.userName : undefined);

                        // Remove this user from the room participants by
                        // matching either on socket id (for object entries)
                        // or on user name (for string entries).
                        room.participants = participantsArr.filter((p) => {
                            if (typeof p === "string") {
                                return p !== effectiveName;
                            }
                            if (p && typeof p === "object") {
                                return p.id !== socket.id &&
                                    p.userName !== effectiveName &&
                                    p.name !== effectiveName;
                            }
                            return true;
                        });

                        io.to(roomId).emit("room-participant-left", {
                            userName,
                            participants: room.participants,
                        });

                        const updatedRooms = Object.values(breakoutRooms[roomMeetingId] || {}).map((r) => ({
                            id: r.id,
                            name: r.name,
                            link: r.link,
                            participants: r.participants,
                            socketIds: r.socketIds || [],
                            participantCount: r.participants.length,
                        }));
                        io.to(roomMeetingId).emit("breakout-rooms-updated", { rooms: updatedRooms });
                    }
                }

                socket.join(meetingId);
                userCurrentRoom[socket.id] = { meetingId, breakoutId: null };

                // Re-add this user to the main meeting participants list and
                // broadcast a normal user-joined event so the host sees the
                // updated participant list.
                const userInfo = userSockets[socket.id];
                const effectiveName = userName || (userInfo ? userInfo.userName : "Guest");
                const effectiveEmail = userInfo ? userInfo.email : undefined;
                const isHostFlag = userInfo ? !!userInfo.isHost : false;

                if (meetings[meetingId]) {
                    const existingIndex = meetings[meetingId].participants.findIndex((p) => p.id === socket.id);
                    if (existingIndex === -1) {
                        meetings[meetingId].participants.push({
                            id: socket.id,
                            userName: effectiveName,
                            email: effectiveEmail,
                            joinedAt: new Date(),
                            isHost: isHostFlag,
                        });
                    } else {
                        meetings[meetingId].participants[existingIndex] = {
                            ...meetings[meetingId].participants[existingIndex],
                            userName: effectiveName,
                            email: effectiveEmail,
                            isHost: isHostFlag,
                        };
                    }

                    io.to(meetingId).emit("user-joined", {
                        id: socket.id,
                        userName: effectiveName,
                        email: effectiveEmail,
                        isHost: isHostFlag,
                        participants: meetings[meetingId].participants,
                    });
                }

                io.to(meetingId).emit("user-returned-to-main", {
                    userName,
                    socketId: socket.id,
                });

                socket.emit("returned-to-main-room", { meetingId });
            } catch (error) {
                console.error("Error returning to main room:", error);
            }
        });

        // Room chat inside breakout
        socket.on("room-chat-message", (data = {}) => {
            try {
                const { roomId, userName, message } = data;
                const userRoom = userCurrentRoom[socket.id];

                if (userRoom && userRoom.breakoutId === roomId) {
                    io.to(roomId).emit("room-chat-message", {
                        userName,
                        message,
                        timestamp: new Date(),
                    });
                }
            } catch (error) {
                console.error("Error sending chat message:", error);
            }
        });

        // User media toggle inside breakout
        socket.on("user-media-toggle", (data = {}) => {
            try {
                const { roomId, userName, type, enabled } = data;
                const userRoom = userCurrentRoom[socket.id];

                if (userRoom && userRoom.breakoutId === roomId) {
                    io.to(roomId).emit("user-media-changed", {
                        socketId: socket.id,
                        userName,
                        type,
                        enabled,
                    });
                }
            } catch (error) {
                console.error("Error toggling media:", error);
            }
        });

        socket.on("disconnect", () => {
            try {
                const userInfo = userSockets[socket.id];
                const userRoom = userCurrentRoom[socket.id];

                if (userRoom && userRoom.breakoutId) {
                    const roomMeetingId = userRoom.meetingId;
                    const breakoutId = userRoom.breakoutId;

                    if (breakoutRooms[roomMeetingId] && breakoutRooms[roomMeetingId][breakoutId]) {
                        const room = breakoutRooms[roomMeetingId][breakoutId];
                        const participantsArr = room.participants || [];
                        const effectiveName = userInfo ? userInfo.userName : undefined;

                        room.participants = participantsArr.filter((p) => {
                            if (typeof p === "string") {
                                return p !== effectiveName;
                            }
                            if (p && typeof p === "object") {
                                return p.id !== socket.id &&
                                    p.userName !== effectiveName &&
                                    p.name !== effectiveName;
                            }
                            return true;
                        });
                    }

                    io.to(breakoutId).emit("room-participant-left", {
                        userName: userInfo ? userInfo.userName : undefined,
                        participants: breakoutRooms[roomMeetingId] && breakoutRooms[roomMeetingId][breakoutId] ?
                            breakoutRooms[roomMeetingId][breakoutId].participants || [] : [],
                    });
                }

                if (userInfo && meetings[userInfo.meetingId]) {
                    meetings[userInfo.meetingId].participants = meetings[userInfo.meetingId].participants.filter(
                        (p) => p.id !== socket.id
                    );

                    io.to(userInfo.meetingId).emit("user-left", {
                        id: socket.id,
                        userName: userInfo.userName,
                        participants: meetings[userInfo.meetingId].participants,
                    });

                    // NOTE: we intentionally do NOT delete meetings or
                    // breakoutRooms here even if participant list becomes
                    // empty. This keeps breakout rooms and metadata alive
                    // across host refreshes while users are still in rooms.

                    if (hosts[userInfo.meetingId] === socket.id) {
                        delete hosts[userInfo.meetingId];
                    }
                }

                delete userSockets[socket.id];
                delete userCurrentRoom[socket.id];
                console.log("User disconnected:", socket.id);
            } catch (error) {
                console.error("Error in disconnect handler:", error);
            }
        });
    });
}

export default function socketHandler(req, res) {
    // Lightweight JSON summary of current meetings for the dashboard
    if (req.method === "GET" && req.query && req.query.summary === "true") {
        const list = Object.values(meetings).map((m) => ({
            id: m.id,
            createdAt: m.createdAt,
            participantCount: m.participants.length,
            host: m.participants.find((p) => p.isHost)?.userName || null,
            participants: m.participants,
        }));

        res.status(200).json({ meetings: list });
        return;
    }

    const server = res.socket?.server;

    if (!server) {
        console.error("Socket server not available on res.socket.server");
        res.status(500).end("Socket server not available");
        return;
    }

    if (!server.io) {
        initSocket(server);
        server.io = io;
    }

    res.status(200).end("Socket.io server ready");
}