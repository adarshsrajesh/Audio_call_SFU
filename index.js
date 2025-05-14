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

// Track online users: { username: socketId }
const onlineUsers = {};

function broadcastOnlineUsers() {
  io.emit("online-users", Object.keys(onlineUsers));
}

io.on("connection", async (socket) => {
  console.log("✅ New socket connected:", socket.id);

  socket.on("login", (username) => {
    try {
      if (!username || typeof username !== "string") {
        socket.emit("error", "Invalid username");
        return;
      }

      socket.username = username;
      onlineUsers[username] = socket.id;
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
      // Remove from online users
      if (socket.username) {
        delete onlineUsers[socket.username];
        broadcastOnlineUsers();
      }

      // Handle room cleanup
      for (const [roomId, room] of rooms.entries()) {
        if (room.participants.has(socket.id)) {
          const participant = room.participants.get(socket.id);
          
          // Close all consumers
          for (const consumer of participant.consumers) {
            consumer.close();
          }

          // Close producer if exists
          if (participant.producer) {
            participant.producer.close();
          }

          // Close transport
          participant.transport.close();

          // Remove participant
          room.participants.delete(socket.id);

          // Notify others
          socket.to(roomId).emit("participant-left", {
            username: participant.username,
          });

          // Remove room if empty
          if (room.participants.size === 0) {
            rooms.delete(roomId);
          }

          break;
        }
      }
    } catch (error) {
      console.error("Disconnect error:", error);
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
