import { AdapterCallMetrics, AdapterDevice, WebexAdapter } from "../types.js";
import { logger } from "../logger.js";

interface WebexDeviceApiResponse {
  items?: Array<{
    id: string;
    displayName?: string;
    tags?: string[];
    workspaceLocationId?: string;
    product?: string;
    software?: string;
    connectionStatus?: string;
    lastSeen?: string;
    errorCodes?: string[];
  }>;
}

export class WebexApiAdapter implements WebexAdapter {
  constructor(private readonly botToken: string) {}

  async getAccessContext(): Promise<{ personId: string; orgId?: string; displayName?: string }> {
    const res = await fetch("https://webexapis.com/v1/people/me", {
      headers: {
        Authorization: `Bearer ${this.botToken}`,
        "Content-Type": "application/json"
      }
    });

    if (!res.ok) {
      throw new Error(`Webex people/me failed: ${res.status}`);
    }

    const data = (await res.json()) as {
      id: string;
      orgId?: string;
      displayName?: string;
    };

    return {
      personId: data.id,
      orgId: data.orgId,
      displayName: data.displayName
    };
  }

  async listDevices(): Promise<AdapterDevice[]> {
    const res = await fetch("https://webexapis.com/v1/devices?max=1000", {
      headers: {
        Authorization: `Bearer ${this.botToken}`,
        "Content-Type": "application/json"
      }
    });

    if (!res.ok) {
      throw new Error(`Webex listDevices failed: ${res.status}`);
    }

    const data = (await res.json()) as WebexDeviceApiResponse;
    return (data.items || []).map((item) => ({
      id: item.id,
      name: item.displayName || item.id,
      tags: (item.tags || []).filter((t) => typeof t === "string"),
      workspace: item.workspaceLocationId,
      product: item.product,
      software: item.software,
      connected: mapConnectionStatus(item.connectionStatus),
      lastSeenAt: item.lastSeen,
      errorCodes: (item.errorCodes || []).filter((e) => typeof e === "string")
    }));
  }

  async fetchCallMetrics(deviceIds: string[]): Promise<AdapterCallMetrics[]> {
    const metrics: AdapterCallMetrics[] = [];

    await Promise.all(
      deviceIds.map(async (deviceId) => {
        try {
          const inCallFromActive = await this.fetchInCallFromActiveCalls(deviceId);
          const conference = await this.fetchConferenceSnapshot(deviceId);
          const inCall =
            inCallFromActive !== undefined ? inCallFromActive || conference.inCall : conference.inCall;

          if (inCall && !hasAnyQosValue(conference.qos)) {
            logger.info({ deviceId }, "in-call-without-qos");
          }

          metrics.push({
            deviceId,
            inCall,
            packetLossPct: conference.qos.packetLossPct,
            jitterMs: conference.qos.jitterMs,
            latencyMs: conference.qos.latencyMs,
            mos: conference.qos.mos,
            bandwidthKbps: conference.qos.bandwidthKbps,
            rxBandwidthKbps: conference.qos.rxBandwidthKbps,
            txBandwidthKbps: conference.qos.txBandwidthKbps
          });
        } catch {
          metrics.push({ deviceId, inCall: false });
        }
      })
    );

    return metrics;
  }

  private async fetchInCallFromActiveCalls(deviceId: string): Promise<boolean | undefined> {
    try {
      const res = await fetch(
        `https://webexapis.com/v1/xapi/status?deviceId=${encodeURIComponent(deviceId)}&name=SystemUnit.State.NumberOfActiveCalls`,
        {
          headers: {
            Authorization: `Bearer ${this.botToken}`,
            "Content-Type": "application/json"
          }
        }
      );

      if (!res.ok) {
        logger.warn({ deviceId, status: res.status }, "xapi-active-calls-request-failed");
        return undefined;
      }

      const data = (await res.json()) as Record<string, unknown>;
      return extractInCallFromActiveCallsResponse(data);
    } catch {
      logger.warn({ deviceId }, "xapi-active-calls-request-error");
      return undefined;
    }
  }

  private async fetchConferenceSnapshot(deviceId: string): Promise<{
    inCall: boolean;
    qos: {
      packetLossPct?: number;
      jitterMs?: number;
      latencyMs?: number;
      mos?: number;
      bandwidthKbps?: number;
      rxBandwidthKbps?: number;
      txBandwidthKbps?: number;
    };
  }> {
    let inCall = false;
    let qos: {
      packetLossPct?: number;
      jitterMs?: number;
      latencyMs?: number;
      mos?: number;
      bandwidthKbps?: number;
      rxBandwidthKbps?: number;
      txBandwidthKbps?: number;
    } = {};

    const names = ["Conference.Call", "Conference"];
    for (const name of names) {
      try {
        const res = await fetch(
          `https://webexapis.com/v1/xapi/status?deviceId=${encodeURIComponent(deviceId)}&name=${encodeURIComponent(name)}`,
          {
            headers: {
              Authorization: `Bearer ${this.botToken}`,
              "Content-Type": "application/json"
            }
          }
        );
        if (!res.ok) {
          logger.warn({ deviceId, name, status: res.status }, "xapi-conference-request-failed");
          continue;
        }

        const data = (await res.json()) as Record<string, unknown>;
        const parsed = extractConferenceSnapshotFromResponse(data);
        inCall = inCall || parsed.inCall;
        if (hasAnyQosValue(parsed.qos)) {
          qos = parsed.qos;
          break;
        }
        logger.info({ deviceId, name }, "xapi-conference-qos-empty");
      } catch {
        logger.warn({ deviceId, name }, "xapi-conference-qos-error");
      }
    }

    return { inCall, qos };
  }
}

function mapConnectionStatus(connectionStatus?: string): boolean | undefined {
  const status = (connectionStatus || "").trim().toLowerCase();
  if (!status) {
    return undefined;
  }
  if (status.includes("connected") || status.includes("online")) {
    return true;
  }
  if (status.includes("disconnected") || status.includes("offline")) {
    return false;
  }
  return undefined;
}

function hasAnyQosValue(value: {
  packetLossPct?: number;
  jitterMs?: number;
  latencyMs?: number;
  mos?: number;
  bandwidthKbps?: number;
  rxBandwidthKbps?: number;
  txBandwidthKbps?: number;
}) {
  return (
    value.packetLossPct !== undefined ||
    value.jitterMs !== undefined ||
    value.latencyMs !== undefined ||
    value.mos !== undefined ||
    value.bandwidthKbps !== undefined ||
    value.rxBandwidthKbps !== undefined ||
    value.txBandwidthKbps !== undefined
  );
}

function extractInCallFromActiveCallsResponse(data: Record<string, unknown>) {
  const result = data.result;
  const direct = toNumeric(result);
  if (direct !== undefined) {
    return direct > 0;
  }

  const flat = walkEntries(data);
  for (const entry of flat) {
    if (!entry.path.includes("numberofactivecalls")) {
      continue;
    }
    const n = toNumeric(entry.value);
    if (n !== undefined) {
      return n > 0;
    }
  }
  return undefined;
}

function extractConferenceSnapshotFromResponse(data: Record<string, unknown>) {
  const result = data.result;
  const payload =
    result && typeof result === "object"
      ? ((result as Record<string, unknown>).Conference as Record<string, unknown> | undefined)?.Call ||
        (result as Record<string, unknown>).Call ||
        (result as Record<string, unknown>).Conference ||
        result
      : result;

  const flat = walkEntries(payload);
  let inCall = false;
  for (const entry of flat) {
    const p = entry.path;
    if (!(p.includes("status") || p.includes("incall") || p.includes("connected") || p.includes("active"))) {
      continue;
    }
    if (typeof entry.value === "boolean") {
      if (entry.value) {
        inCall = true;
      }
      continue;
    }
    if (typeof entry.value === "string") {
      const v = entry.value.toLowerCase();
      if (v.includes("connected") || v.includes("active") || v === "on" || v === "true") {
        inCall = true;
      }
    }
  }

  return {
    inCall,
    qos: extractQosFromCallPayload(payload)
  };
}

function toNumeric(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string") {
    const normalized = value.trim().replace(",", ".");
    const n = Number(normalized);
    if (Number.isFinite(n)) {
      return n;
    }
    const match = normalized.match(/-?\d+(\.\d+)?/);
    if (match) {
      const parsed = Number(match[0]);
      if (Number.isFinite(parsed)) {
        return parsed;
      }
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

function extractQosFromCallPayload(callPayload: unknown) {
  const flat = walkEntries(callPayload);
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
  const jitterMs = pick([(p) => p.includes("jitter"), (p) => p.includes("variation")]);
  const latencyMs = pick([
    (p) => p.includes("delay"),
    (p) => p.includes("latency"),
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
    totalBandwidthRaw ??
      (rxBandwidthRaw !== undefined || txBandwidthRaw !== undefined
        ? (rxBandwidthRaw || 0) + (txBandwidthRaw || 0)
        : undefined)
  );

  return {
    packetLossPct,
    jitterMs,
    latencyMs,
    mos,
    bandwidthKbps,
    rxBandwidthKbps,
    txBandwidthKbps
  };
}
