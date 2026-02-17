import "dotenv/config";
import express from "express";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer } from "ws";
import { config } from "./config.js";
import { logger } from "./logger.js";
import { DeviceStore } from "./store.js";
import { MockWebexAdapter } from "./webex/mockAdapter.js";
import { WebexApiAdapter } from "./webex/webexAdapter.js";
import { startPolling } from "./poller.js";
import { buildWebhookHandler } from "./webhook.js";
import { issueToken, requireAuth, requireRole } from "./auth.js";
import { auditLog, listAudit } from "./audit.js";
import { Observability } from "./observability.js";

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: "/ws" });
const store = new DeviceStore();
const observability = new Observability();

app.use(
  express.json({
    verify: (req, _res, buf) => {
      (req as express.Request & { rawBody?: string }).rawBody = buf.toString("utf8");
    }
  })
);

app.use((req, res, next) => {
  const started = Date.now();
  res.on("finish", () => {
    logger.info(
      {
        method: req.method,
        url: req.originalUrl,
        statusCode: res.statusCode,
        latencyMs: Date.now() - started
      },
      "http-request"
    );
  });
  next();
});

app.post("/api/login", (req, res) => {
  const email = String(req.body?.email || "").trim().toLowerCase();
  if (!email) {
    res.status(400).json({ error: "email required" });
    return;
  }
  const token = issueToken(email);
  auditLog({ actor: email, action: "login" });
  res.status(200).json({ token });
});

app.get("/api/health", (_req, res) => {
  res.json({ ok: true, ts: new Date().toISOString() });
});

app.post("/api/webhooks/webex", buildWebhookHandler(store, observability));

app.use("/api", requireAuth);

app.get("/api/me", (req, res) => {
  res.json({ user: req.user });
});

app.get("/api/devices", (_req, res) => {
  res.json({ items: store.listDevices() });
});

app.get("/api/events", (req, res) => {
  const limit = Number(req.query.limit || 200);
  res.json({ items: store.listEvents(limit) });
});

app.get("/api/audit", requireRole("admin"), (req, res) => {
  const limit = Number(req.query.limit || 200);
  res.json({ items: listAudit(limit), requestedBy: req.user?.email });
});

app.get("/api/metrics", requireRole("admin"), (_req, res) => {
  res.json({
    ...observability.snapshot(),
    devicesTracked: store.listDevices().length,
    wsClients: wss.clients.size
  });
});

app.get("/api/webex/context", requireRole("admin"), async (_req, res) => {
  if (!adapter.getAccessContext) {
    res.status(501).json({ error: "Adapter does not expose context" });
    return;
  }
  try {
    const ctx = await adapter.getAccessContext();
    res.json({ mode: config.USE_MOCK_DATA ? "mock" : "webex", context: ctx });
  } catch (error) {
    logger.error({ error }, "webex-context-error");
    res.status(502).json({ error: "Cannot retrieve Webex context" });
  }
});

const __dirname = path.dirname(fileURLToPath(import.meta.url));
app.use(express.static(path.join(__dirname, "public")));

app.get("*", (_req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

if (!config.USE_MOCK_DATA && !config.WEBEX_BOT_TOKEN) {
  throw new Error("WEBEX_BOT_TOKEN is required when USE_MOCK_DATA=false");
}

const adapter = config.USE_MOCK_DATA
  ? new MockWebexAdapter()
  : new WebexApiAdapter(config.WEBEX_BOT_TOKEN);

const stopPolling = startPolling(store, adapter);

function broadcastDevices(reason: "store-update" | "heartbeat") {
  const payload = JSON.stringify({
    type: "delta",
    reason,
    payload: store.listDevices(),
    emittedAt: new Date().toISOString()
  });
  for (const client of wss.clients) {
    if (client.readyState === client.OPEN) {
      client.send(payload);
    }
  }
}

store.subscribe(() => {
  broadcastDevices("store-update");
});

wss.on("connection", (ws) => {
  ws.send(JSON.stringify({ type: "snapshot", payload: store.listDevices() }));
});

setInterval(() => {
  broadcastDevices("heartbeat");
}, 10_000);

server.listen(config.PORT, () => {
  logger.info({ port: config.PORT }, "server-started");
});

process.on("SIGINT", () => {
  stopPolling();
  server.close(() => process.exit(0));
});
