// src/stream/dashboard.ts
// Mission Control — aggregates all bot overlays into one dashboard page.

import express from "express";
import { createServer } from "http";
import path from "path";
import { fileURLToPath } from "url";
import type { BotRoleConfig } from "../bot/role.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const DASHBOARD_PORT = 3010;

export function startDashboard(roster: BotRoleConfig[]) {
  const app = express();
  const http = createServer(app);

  // Serve dashboard static files
  app.use(express.static(path.join(__dirname, "../../dashboard")));

  // API endpoint: bot roster info (ports, names, roles)
  app.get("/api/roster", (_req, res) => {
    res.json(
      roster.map((r) => ({
        name: r.name,
        role: r.role,
        viewerPort: r.viewerPort,
        overlayPort: r.overlayPort,
      }))
    );
  });

  http.on("error", (err: NodeJS.ErrnoException) => {
    if (err.code === "EADDRINUSE") {
      console.log(`[Dashboard] Port ${DASHBOARD_PORT} in use — dashboard disabled.`);
      return;
    }
    console.error("[Dashboard] Server error:", err);
  });

  http.listen(DASHBOARD_PORT, () => {
    console.log(`[Dashboard] Mission Control at http://localhost:${DASHBOARD_PORT}`);
  });
}
