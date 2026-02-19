import express from "express";
import { createServer } from "http";
import { Server as SocketIO } from "socket.io";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export interface OverlayState {
  health: number;
  food: number;
  position: { x: number; y: number; z: number };
  time: string;
  thought: string;
  action: string;
  actionResult: string;
  inventory: string[];
  chatMessages: { username: string; message: string; tier: string }[];
  skillProgress?: { skillName: string; phase: string; progress: number; message: string; active: boolean };
}

let io: SocketIO | null = null;
let currentState: OverlayState = {
  health: 20,
  food: 20,
  position: { x: 0, y: 0, z: 0 },
  time: "daytime",
  thought: "Waking up...",
  action: "idle",
  actionResult: "",
  inventory: [],
  chatMessages: [],
};

export function startOverlay(port = 3001) {
  const app = express();
  const http = createServer(app);
  io = new SocketIO(http);

  app.use(express.static(path.join(__dirname, "../../overlay")));

  io.on("connection", (socket) => {
    socket.emit("state", currentState);
  });

  http.on("error", (err: NodeJS.ErrnoException) => {
    if (err.code === "EADDRINUSE") {
      console.log(`[Overlay] Port ${port} in use, skipping overlay server`);
      io = null;
      return;
    }
    console.error("[Overlay] Server error:", err);
  });

  http.listen(port, () => {
    console.log(`[Overlay] Stream overlay running at http://localhost:${port}`);
  });
}

export function updateOverlay(partial: Partial<OverlayState>) {
  currentState = { ...currentState, ...partial };
  if (io) {
    io.emit("state", currentState);
  }
}

export function speakThought(audioUrl: string) {
  if (io) {
    io.emit("speak", { url: audioUrl });
  }
}

export function addChatMessage(username: string, message: string, tier: string) {
  currentState.chatMessages.push({ username, message, tier });
  // Keep last 8 messages
  if (currentState.chatMessages.length > 8) {
    currentState.chatMessages.shift();
  }
  if (io) {
    io.emit("state", currentState);
  }
}
