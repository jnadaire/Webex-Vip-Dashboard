import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { Request, Response } from "express";
import { config } from "./config.js";
import { DeviceStore } from "./store.js";
import { InboundWebhookEvent } from "./types.js";
import { auditLog } from "./audit.js";
import { Observability } from "./observability.js";

function verifySignature(rawBody: string, signature: string | undefined) {
  if (!config.WEBEX_WEBHOOK_SECRET) {
    return true;
  }
  if (!signature) {
    return false;
  }
  const digest = createHmac("sha1", config.WEBEX_WEBHOOK_SECRET)
    .update(rawBody, "utf8")
    .digest("hex");

  const incoming = Buffer.from(signature, "hex");
  const expected = Buffer.from(digest, "hex");
  if (incoming.length !== expected.length) {
    return false;
  }

  return timingSafeEqual(incoming, expected);
}

function toNumeric(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }
  return undefined;
}

function normalizeRateKbps(value: number | undefined) {
  if (value === undefined) {
    return undefined;
  }
  if (value > 10000) {
    return Number((value / 1000).toFixed(1));
  }
  return Number(value.toFixed(1));
}

function walkEntries(
  value: unknown,
  prefix: string[] = [],
  out: Array<{ path: string; value: unknown }> = []
) {
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i += 1) {
      walkEntries(value[i], [...prefix, String(i)], out);
    }
    return out;
  }
  if (value && typeof value === "object") {
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      walkEntries(v, [...prefix, k], out);
    }
    return out;
  }
  out.push({ path: prefix.join(".").toLowerCase(), value });
  return out;
}

function extractQosFromWebhookData(data: Record<string, unknown>) {
  const flat = walkEntries(data);
  const pick = (predicates: Array<(path: string) => boolean>) => {
    for (const entry of flat) {
      if (!predicates.some((p) => p(entry.path))) {
        continue;
      }
      const n = toNumeric(entry.value);
      if (n !== undefined) {
        return n;
      }
    }
    return undefined;
  };

  const packetLossPct = pick([
    (p) => p.includes("packetloss"),
    (p) => p.includes("packet_loss"),
    (p) => p.includes("losspercent"),
    (p) => p.includes("percentloss")
  ]);

  const jitterMs = pick([
    (p) => p.includes("jitter"),
    (p) => p.includes("variation")
  ]);

  const latencyMs = pick([
    (p) => p.includes("latency"),
    (p) => p.includes("delay"),
    (p) => p.includes("rtt")
  ]);

  const mos = pick([(p) => p.includes("mos")]);

  const rxBandwidthRaw = pick([
    (p) => (p.includes("receive") || p.includes("rx") || p.includes("incoming")) && p.includes("rate"),
    (p) => (p.includes("receive") || p.includes("rx") || p.includes("incoming")) && p.includes("bandwidth"),
    (p) => (p.includes("receive") || p.includes("rx") || p.includes("incoming")) && p.includes("bitrate")
  ]);
  const txBandwidthRaw = pick([
    (p) => (p.includes("transmit") || p.includes("tx") || p.includes("outgoing")) && p.includes("rate"),
    (p) => (p.includes("transmit") || p.includes("tx") || p.includes("outgoing")) && p.includes("bandwidth"),
    (p) => (p.includes("transmit") || p.includes("tx") || p.includes("outgoing")) && p.includes("bitrate")
  ]);
  const totalBandwidthRaw = pick([
    (p) =>
      !p.includes("receive") &&
      !p.includes("transmit") &&
      !p.includes("rx") &&
      !p.includes("tx") &&
      (p.includes("bandwidth") || p.includes("bitrate") || p.includes("callrate"))
  ]);

  const rxBandwidthKbps = normalizeRateKbps(rxBandwidthRaw);
  const txBandwidthKbps = normalizeRateKbps(txBandwidthRaw);
  const bandwidthKbps = normalizeRateKbps(
    totalBandwidthRaw ?? (rxBandwidthRaw !== undefined || txBandwidthRaw !== undefined
      ? (rxBandwidthRaw || 0) + (txBandwidthRaw || 0)
      : undefined)
  );

  const hasAny = [
    packetLossPct,
    jitterMs,
    latencyMs,
    mos,
    bandwidthKbps,
    rxBandwidthKbps,
    txBandwidthKbps
  ].some((n) => n !== undefined);
  return hasAny
    ? {
        packetLossPct,
        jitterMs,
        latencyMs,
        mos,
        bandwidthKbps,
        rxBandwidthKbps,
        txBandwidthKbps,
        updatedAt: new Date().toISOString()
      }
    : undefined;
}

function extractInCallState(data: Record<string, unknown>) {
  const flat = walkEntries(data);
  for (const entry of flat) {
    if (!entry.path.includes("call")) {
      continue;
    }
    if (typeof entry.value === "boolean") {
      return entry.value;
    }
    if (typeof entry.value === "number") {
      return entry.value > 0;
    }
    if (typeof entry.value === "string") {
      const value = entry.value.toLowerCase();
      if (["true", "active", "connected", "on"].includes(value)) {
        return true;
      }
      if (["false", "idle", "disconnected", "off"].includes(value)) {
        return false;
      }
    }
  }
  return undefined;
}

function extractDeviceId(data: Record<string, unknown>, fullPayload: Record<string, unknown>) {
  const looksLikeWebexResourceId = (value: string) =>
    value.startsWith("Y2lzY29zcGFyazovLw") || value.startsWith("ciscospark://");

  const fromData = walkEntries(data);
  for (const entry of fromData) {
    if (!entry.path.includes("deviceid")) {
      continue;
    }
    if (typeof entry.value === "string" && entry.value.length > 10) {
      return entry.value;
    }
  }

  for (const entry of fromData) {
    if (!entry.path.includes("device")) {
      continue;
    }
    if (typeof entry.value === "string" && looksLikeWebexResourceId(entry.value)) {
      return entry.value;
    }
  }

  const fromPayload = walkEntries(fullPayload);
  for (const entry of fromPayload) {
    if (!entry.path.includes("deviceid")) {
      continue;
    }
    if (typeof entry.value === "string" && entry.value.length > 10) {
      return entry.value;
    }
  }

  for (const entry of fromPayload) {
    if (!entry.path.includes("device")) {
      continue;
    }
    if (typeof entry.value === "string" && looksLikeWebexResourceId(entry.value)) {
      return entry.value;
    }
  }

  return undefined;
}

function extractDeviceNameHint(data: Record<string, unknown>, fullPayload: Record<string, unknown>) {
  const entries = [...walkEntries(data), ...walkEntries(fullPayload)];
  for (const entry of entries) {
    if (!entry.path.includes("device")) {
      continue;
    }
    if (!entry.path.includes("name") && !entry.path.includes("display")) {
      continue;
    }
    if (typeof entry.value === "string" && entry.value.trim().length >= 3) {
      return entry.value.trim();
    }
  }
  return undefined;
}

function normalizeName(value: string) {
  return value
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]/g, "");
}

function resolveDeviceId(
  store: DeviceStore,
  data: Record<string, unknown>,
  fullPayload: Record<string, unknown>
) {
  const direct = extractDeviceId(data, fullPayload);
  if (direct) {
    return direct;
  }
  const nameHint = extractDeviceNameHint(data, fullPayload)?.toLowerCase();
  if (!nameHint) {
    const allText = [...walkEntries(data), ...walkEntries(fullPayload)]
      .map((entry) => (typeof entry.value === "string" ? entry.value : ""))
      .filter(Boolean)
      .join(" ")
      .toLowerCase();
    const candidates = store
      .listDevices()
      .filter((d) => d.name && allText.includes(d.name.toLowerCase()));
    if (candidates.length === 1) {
      return candidates[0].id;
    }
    return undefined;
  }
  const normalizedHint = normalizeName(nameHint);
  const byName = store.listDevices().find((d) => {
    const exact = d.name.toLowerCase() === nameHint;
    if (exact) {
      return true;
    }
    const normalized = normalizeName(d.name);
    return normalizedHint === normalized || normalized.includes(normalizedHint) || normalizedHint.includes(normalized);
  });
  return byName?.id;
}

function inferFaultSeverity(
  value: unknown
): "info" | "warning" | "critical" {
  const text = String(value || "")
    .trim()
    .toLowerCase();
  if (!text) {
    return "warning";
  }
  if (text.includes("critical") || text.includes("severe") || text.includes("major")) {
    return "critical";
  }
  if (text.includes("info") || text.includes("minor")) {
    return "info";
  }
  return "warning";
}

function extractFaultPayload(
  resource: string,
  eventName: string,
  data: Record<string, unknown>,
  fullPayload: Record<string, unknown>
) {
  const flat = [...walkEntries(data), ...walkEntries(fullPayload)];
  const stringEntries = flat
    .map((entry) => (typeof entry.value === "string" ? entry.value : ""))
    .filter(Boolean);
  const texts = stringEntries.join(" ").toLowerCase();
  const resourceText = `${resource} ${eventName}`.toLowerCase();

  const issueSignal =
    resourceText.includes("alert") ||
    resourceText.includes("issue") ||
    resourceText.includes("health") ||
    texts.includes("ultrason") ||
    texts.includes("ultrasound") ||
    texts.includes("issue") ||
    texts.includes("fault") ||
    texts.includes("problem") ||
    texts.includes("degrad") ||
    texts.includes("error");

  if (!issueSignal) {
    return undefined;
  }

  const findByPath = (paths: string[]) => {
    for (const entry of flat) {
      if (!paths.some((p) => entry.path.includes(p))) {
        continue;
      }
      if (typeof entry.value === "string" && entry.value.trim()) {
        return entry.value.trim();
      }
    }
    return undefined;
  };

  const candidateMessage =
    findByPath(["message", "description", "summary", "title", "details", "reason"]) ||
    stringEntries.find((s) => /ultrasound|ultrason|pairing may fail|issue|fault|problem|error/i.test(s));
  const candidateCode =
    findByPath(["code", "alertcode", "alerttype", "type", "category", "name"]) || "DEVICE_ALERT";
  const candidateSeverity = findByPath(["severity", "level", "priority"]);

  const code = candidateCode || "DEVICE_ALERT";
  const message = candidateMessage || "Device reported an issue";
  const severity = inferFaultSeverity(candidateSeverity || data.severity || data.level || data.priority);

  return { code, message, severity };
}

export function buildWebhookHandler(store: DeviceStore, observability: Observability) {
  return (req: Request, res: Response) => {
    const raw = (req as Request & { rawBody?: string }).rawBody || "";
    const signature = req.header("x-spark-signature") || undefined;

    if (!verifySignature(raw, signature)) {
      res.status(401).json({ error: "Invalid webhook signature" });
      return;
    }

    const payload = (req.body || {}) as Record<string, unknown>;
    const event = payload as unknown as Partial<InboundWebhookEvent>;
    const normalized: InboundWebhookEvent = {
      id:
        typeof event.id === "string" && event.id
          ? event.id
          : createHash("sha1").update(raw || JSON.stringify(payload)).digest("hex"),
      resource: typeof event.resource === "string" ? event.resource : "alert-center",
      event: typeof event.event === "string" ? event.event : "created",
      created: typeof event.created === "string" ? event.created : new Date().toISOString(),
      data:
        event.data && typeof event.data === "object"
          ? event.data
          : payload
    };

    const fresh = store.processWebhook(normalized);
    observability.setWebhookBacklog(0);
    const createdTs = Number(new Date(normalized.created));
    if (!Number.isNaN(createdTs)) {
      observability.recordWebhookLatency(Date.now() - createdTs);
    }

    if (!fresh) {
      res.status(200).json({ ok: true, deduped: true });
      return;
    }

    const data = normalized.data || {};
    const deviceId = resolveDeviceId(store, data, payload);

    if (deviceId && normalized.resource === "devices") {
      if (normalized.event === "updated") {
        const connected = String(data.connectionStatus || "").toLowerCase() === "connected";
        store.upsertDevice({
          id: deviceId,
          name: String(data.displayName || deviceId),
          tags: Array.isArray(data.tags)
            ? data.tags.filter((tag): tag is string => typeof tag === "string")
            : [],
          workspace: typeof data.workspaceLocationId === "string" ? data.workspaceLocationId : undefined,
          product: typeof data.product === "string" ? data.product : undefined,
          software: typeof data.software === "string" ? data.software : undefined,
          status: connected ? "online" : "offline",
          lastSeenAt: new Date().toISOString()
        });
      }
    }

    if (deviceId) {
      const fault = extractFaultPayload(normalized.resource, normalized.event, data, payload);
      if (fault) {
        store.addFault(deviceId, fault);
      }
    }

    if (deviceId) {
      const qos = extractQosFromWebhookData(data);
      const inCallState = extractInCallState(data);
      if (qos || inCallState !== undefined) {
        const current = store.getDevice(deviceId);
        const inferredInCall = inCallState ?? (qos ? true : current?.inCall ?? false);
        store.setCallState(deviceId, inferredInCall, qos);
      }
    }

    auditLog({
      actor: "webhook",
      action: `${normalized.resource}.${normalized.event}`,
      target: deviceId,
      metadata: { eventId: normalized.id }
    });

    res.status(200).json({ ok: true });
  };
}
