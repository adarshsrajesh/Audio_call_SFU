const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const cors = require("cors");
const mediasoup = require("mediasoup");

const app = express();
const server = http.createServer(app);

// TODO: In production, replace "*" with your frontend domain
// Example: origin: "https://yourdomain.com"
const io = new Server(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"],
  },
});

app.use(cors());
app.use(express.json());

const PORT = 5000;

// Mediasoup configuration
const mediaCodecs = [
  {
    kind: 'audio',
    mimeType: 'audio/PCMA',
    clockRate: 8000,
    channels: 1
  }
];

// Store active rooms and their participants
const rooms = new Map();

// Mediasoup worker
let worker;
let router;

// Initialize mediasoup worker
async function initializeMediasoup() {
  worker = await mediasoup.createWorker({
    logLevel: 'warn',
    rtcMinPort: 10000,
    rtcMaxPort: 10100,
  });

  router = await worker.createRouter({ mediaCodecs });
  console.log('Mediasoup worker and router initialized');
}

// Track online users: { username: { socketId, roomId } }
const onlineUsers = {};

function broadcastOnlineUsers() {
  const users = Object.keys(onlineUsers).filter(username => onlineUsers[username].socketId);
  io.emit("online-users", users);
}

io.on("connection", async (socket) => {
  console.log("✅ New socket connected:", socket.id);

  // Add handler for getting router RTP capabilities
  socket.on('getRouterRtpCapabilities', (callback) => {
    try {
      if (!router) {
        throw new Error('Router not initialized');
      }
      const rtpCapabilities = router.rtpCapabilities;
      callback(rtpCapabilities);
    } catch (error) {
      console.error('Error getting router RTP capabilities:', error);
      callback(null);
    }
  });

  socket.on("login", (username) => {
    try {
      if (!username || typeof username !== "string") {
        socket.emit("error", "Invalid username");
        return;
      }

      // Check if username is already taken
      if (onlineUsers[username] && onlineUsers[username].socketId) {
        socket.emit("error", "Username already taken");
        return;
      }

      socket.username = username;
      onlineUsers[username] = {
        socketId: socket.id,
        roomId: null
      };
      
      console.log(`👤 ${username} logged in`);
      broadcastOnlineUsers();
    } catch (error) {
      console.error("Login error:", error);
      socket.emit("error", "Login failed");
    }
  });

  // Create or join a room
  socket.on("join-room", async ({ roomId }, callback) => {
    try {
      if (!roomId) {
        socket.emit("error", "Invalid room ID");
        return;
      }

      let room = rooms.get(roomId);
      
      if (!room) {
        // Create new room
        room = {
          id: roomId,
          participants: new Map(),
          router: router,
        };
        rooms.set(roomId, room);
      }

      // Create WebRTC transport for the new participant
      const transport = await room.router.createWebRtcTransport({
        listenIps: [{ ip: '0.0.0.0', announcedIp: 'audio-chat-sfu-client.vercel.app' }],
        enableUdp: true,
        enableTcp: true,
        preferUdp: true,
      });

      // Store participant info
      room.participants.set(socket.id, {
        username: socket.username,
        transport: transport,
        producer: null,
        consumers: new Set(),
      });

      // Join socket.io room
      socket.join(roomId);

      // Notify others in the room
      socket.to(roomId).emit("participant-joined", {
        username: socket.username,
      });

      // Send transport info to the client
      callback({
        id: transport.id,
        iceParameters: transport.iceParameters,
        iceCandidates: transport.iceCandidates,
        dtlsParameters: transport.dtlsParameters,
      });

    } catch (error) {
      console.error("Join room error:", error);
      socket.emit("error", "Failed to join room");
    }
  });

  // Handle producer transport connect
  socket.on("connect-transport", async ({ transportId, dtlsParameters }, callback) => {
    try {
      const room = Array.from(rooms.values()).find(r => r.participants.has(socket.id));
      if (!room) {
        throw new Error("Room not found");
      }

      const participant = room.participants.get(socket.id);
      await participant.transport.connect({ dtlsParameters });
      callback();
    } catch (error) {
      console.error("Connect transport error:", error);
      socket.emit("error", "Failed to connect transport");
    }
  });

  // Handle new producer
  socket.on("produce", async ({ transportId, kind, rtpParameters }, callback) => {
    try {
      const room = Array.from(rooms.values()).find(r => r.participants.has(socket.id));
      if (!room) {
        throw new Error("Room not found");
      }

      const participant = room.participants.get(socket.id);
      const producer = await participant.transport.produce({
        kind,
        rtpParameters,
      });

      participant.producer = producer;

      // Notify other participants
      socket.to(room.id).emit("new-producer", {
        producerId: producer.id,
        username: socket.username,
      });

      callback({ id: producer.id });
    } catch (error) {
      console.error("Produce error:", error);
      socket.emit("error", "Failed to produce");
    }
  });

  // Handle consumer creation
  socket.on("consume", async ({ producerId, rtpCapabilities }, callback) => {
    try {
      const room = Array.from(rooms.values()).find(r => r.participants.has(socket.id));
      if (!room) {
        throw new Error("Room not found");
      }

      const participant = room.participants.get(socket.id);
      
      if (!room.router.canConsume({ producerId, rtpCapabilities })) {
        throw new Error("Cannot consume");
      }

      const transport = participant.transport;
      const consumer = await transport.consume({
        producerId,
        rtpCapabilities,
        paused: true,
      });

      participant.consumers.add(consumer);

      callback({
        id: consumer.id,
        kind: consumer.kind,
        rtpParameters: consumer.rtpParameters,
        producerId: producerId,
      });

      // Resume the consumer
      await consumer.resume();
    } catch (error) {
      console.error("Consume error:", error);
      socket.emit("error", "Failed to consume");
    }
  });

  // Handle disconnection
  socket.on("disconnect", () => {
    try {
      if (socket.username) {
        // If user was in a room, notify others
        const userInfo = onlineUsers[socket.username];
        if (userInfo && userInfo.roomId) {
          socket.to(userInfo.roomId).emit("participant-left", {
            username: socket.username
          });
        }
        
        // Remove user from online users
        delete onlineUsers[socket.username];
        console.log(`❌ ${socket.username} disconnected`);
        broadcastOnlineUsers();
      }
    } catch (error) {
      console.error("Disconnect error:", error);
    }
  });

  // Handle call requests
  socket.on("call-user", ({ toUserId, offer }) => {
    try {
      if (!toUserId || !offer) {
        socket.emit("error", "Invalid call data");
        return;
      }

      const targetUser = onlineUsers[toUserId];
      if (!targetUser || !targetUser.socketId) {
        socket.emit("error", "User not found");
        return;
      }

      io.to(targetUser.socketId).emit("incoming-call", {
        fromUserId: socket.username,
        offer
      });
    } catch (error) {
      console.error("Call error:", error);
      socket.emit("error", "Call failed");
    }
  });

  // Handle call answers
  socket.on("answer-call", ({ toUserId, answer }) => {
    try {
      if (!toUserId || !answer) {
        socket.emit("error", "Invalid answer data");
        return;
      }

      const targetUser = onlineUsers[toUserId];
      if (!targetUser || !targetUser.socketId) {
        socket.emit("error", "User not found");
        return;
      }

      io.to(targetUser.socketId).emit("call-answered", {
        fromUserId: socket.username,
        answer
      });
    } catch (error) {
      console.error("Answer error:", error);
      socket.emit("error", "Answer failed");
    }
  });

  // Handle call rejections
  socket.on("reject-call", ({ toUserId }) => {
    try {
      if (!toUserId) {
        socket.emit("error", "Invalid user ID");
        return;
      }

      const targetUser = onlineUsers[toUserId];
      if (!targetUser || !targetUser.socketId) {
        socket.emit("error", "User not found");
        return;
      }

      io.to(targetUser.socketId).emit("call-rejected", {
        fromUserId: socket.username
      });
    } catch (error) {
      console.error("Reject error:", error);
      socket.emit("error", "Reject failed");
    }
  });

  // Handle ICE candidates
  socket.on("ice-candidate", ({ toUserId, candidate }) => {
    try {
      if (!toUserId || !candidate) {
        socket.emit("error", "Invalid ICE candidate data");
        return;
      }

      const targetUser = onlineUsers[toUserId];
      if (!targetUser || !targetUser.socketId) {
        socket.emit("error", "User not found");
        return;
      }

      io.to(targetUser.socketId).emit("ice-candidate", {
        fromUserId: socket.username,
        candidate
      });
    } catch (error) {
      console.error("ICE candidate error:", error);
      socket.emit("error", "ICE candidate failed");
    }
  });
});

// Initialize mediasoup and start server
initializeMediasoup().then(() => {
  server.listen(PORT, () => {
    console.log(`🚀 Signaling server running at http://localhost:${PORT}`);
  });
}).catch(error => {
  console.error("Failed to initialize mediasoup:", error);
  process.exit(1);
});
