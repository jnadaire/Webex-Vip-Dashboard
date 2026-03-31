import { AdapterCallMetrics, AdapterDevice, WebexAdapter } from "../types.js";
import { logger } from "../logger.js";

interface WebexDeviceApiResponse {
  items?: Array<{
    id: string;
    displayName?: string;
    placeId?: string;
    workspaceId?: string;
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
      roomId: item.workspaceId || item.placeId,
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
          const callContext = await this.fetchCallContext(deviceId);
          const inCall =
            inCallFromActive !== undefined ? inCallFromActive || conference.inCall : conference.inCall;
          const signals = await this.fetchRoomSignals(deviceId);

          if (inCall && !hasAnyQosValue(conference.qos)) {
            logger.info({ deviceId }, "in-call-without-qos");
          }

          metrics.push({
            deviceId,
            inCall,
            callProtocol: callContext.callProtocol,
            meetingPlatform: callContext.meetingPlatform,
            callDisplayName: callContext.callDisplayName,
            booked: signals.booked,
            bookingStatus: signals.bookingStatus,
            used: signals.used ?? (inCall ? true : undefined),
            nextMeeting: signals.nextMeeting,
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

  private async fetchCallContext(deviceId: string): Promise<{
    callProtocol?: string;
    meetingPlatform?: string;
    callDisplayName?: string;
  }> {
    try {
      const res = await fetch(
        `https://webexapis.com/v1/xapi/status?deviceId=${encodeURIComponent(deviceId)}&name=Call.*&name=Conference.*`,
        {
          headers: {
            Authorization: `Bearer ${this.botToken}`,
            "Content-Type": "application/json"
          }
        }
      );
      if (!res.ok) {
        return {};
      }
      const data = (await res.json()) as Record<string, unknown>;
      return extractCallContextFromResponse(data);
    } catch {
      return {};
    }
  }

  private async fetchRoomSignals(deviceId: string): Promise<{
    booked?: boolean;
    bookingStatus?: string;
    used?: boolean;
    nextMeeting?: AdapterCallMetrics["nextMeeting"];
  }> {
    const names = [
      "RoomAnalytics",
      "RoomAnalytics.PeoplePresence",
      "RoomAnalytics.InUse",
      "RoomAnalytics.PeopleCount",
      "Bookings",
      "Bookings.Availability",
      "Bookings.Current",
      "Bookings.Next"
    ];

    let booked: boolean | undefined;
    let bookingStatus: string | undefined;
    let used: boolean | undefined;
    let nextMeeting: AdapterCallMetrics["nextMeeting"];

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
          continue;
        }
        const data = (await res.json()) as Record<string, unknown>;
        const parsed = extractRoomSignalsFromResponse(data);
        if (parsed.booked !== undefined) {
          booked = parsed.booked;
        }
        if (parsed.bookingStatus) {
          bookingStatus = parsed.bookingStatus;
        }
        if (parsed.used !== undefined) {
          used = parsed.used;
        }
        if (!nextMeeting && parsed.nextMeeting) {
          nextMeeting = parsed.nextMeeting;
        }
      } catch {
        continue;
      }
    }

    return { booked, bookingStatus, used, nextMeeting };
  }
}

function mapConnectionStatus(connectionStatus?: string): boolean | undefined {
  const status = (connectionStatus || "").trim().toLowerCase();
  if (!status) {
    return undefined;
  }
  if (status.includes("disconnected") || status.includes("offline")) {
    return false;
  }
  if (status.includes("connected") || status.includes("online")) {
    return true;
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

function extractRoomSignalsFromResponse(data: Record<string, unknown>) {
  const result = data.result;
  const flat = walkEntries(result);
  let booked: boolean | undefined;
  let bookingStatus: string | undefined;
  let used: boolean | undefined;

  for (const entry of flat) {
    const path = entry.path;

    if (
      path.includes("peoplepresence") ||
      path.includes("inuse") ||
      path.includes("peoplecount.current") ||
      path.includes("peoplecount") ||
      path.includes("facecount")
    ) {
      const presence = toBooleanSignal(entry.value);
      if (presence !== undefined) {
        used = presence;
      } else {
        const n = toNumeric(entry.value);
        if (n !== undefined) {
          used = n > 0;
        }
      }
    }

    if (path.includes("booking") || path.includes("meeting")) {
      if (path.endsWith("status") && typeof entry.value === "string") {
        bookingStatus = String(entry.value).trim().toLowerCase();
      }
      const b = toBookingSignal(entry.value);
      if (b !== undefined) {
        booked = b;
      }
    }
  }

  return {
    booked,
    bookingStatus,
    used,
    nextMeeting: extractNextMeeting(result)
  };
}

function extractCallContextFromResponse(data: Record<string, unknown>) {
  const result = (data.result || {}) as Record<string, unknown>;
  const call = Array.isArray(result.Call) ? (result.Call[0] as Record<string, unknown> | undefined) : undefined;
  const conference = result.Conference as Record<string, unknown> | undefined;
  const conferenceCall = Array.isArray(conference?.Call)
    ? ((conference?.Call as unknown[])[0] as Record<string, unknown> | undefined)
    : undefined;

  return {
    callProtocol: typeof call?.Protocol === "string" ? call.Protocol : undefined,
    callDisplayName: typeof call?.DisplayName === "string" ? call.DisplayName : undefined,
    meetingPlatform: typeof conferenceCall?.MeetingPlatform === "string" ? conferenceCall.MeetingPlatform : undefined
  };
}

function extractNextMeeting(value: unknown) {
  const candidates = collectMeetingCandidates(value)
    .map((candidate) => {
      const startAt = getDateLikeField(candidate, ["starttime", "startdatetime", "startdate", "start"]);
      if (!startAt) {
        return undefined;
      }

      const endAt = getDateLikeField(candidate, ["endtime", "enddatetime", "enddate", "end"]);
      const title = getStringLikeField(candidate, ["title", "subject", "meetingtitle", "name"]);
      return { title, startAt, endAt };
    })
    .filter((candidate): candidate is NonNullable<typeof candidate> => !!candidate)
    .filter((candidate) => new Date(candidate.startAt).getTime() > Date.now())
    .sort((a, b) => new Date(a.startAt).getTime() - new Date(b.startAt).getTime());

  return candidates[0];
}

function collectMeetingCandidates(value: unknown, path = ""): Record<string, unknown>[] {
  if (!value || typeof value !== "object") {
    return [];
  }

  const node = value as Record<string, unknown>;
  const results: Record<string, unknown>[] = [];
  const normalizedPath = path.toLowerCase();
  if (normalizedPath.includes("booking") || normalizedPath.includes("meeting")) {
    results.push(node);
  }

  for (const [key, child] of Object.entries(node)) {
    results.push(...collectMeetingCandidates(child, `${path}.${key}`));
  }

  return results;
}

function getDateLikeField(node: Record<string, unknown>, names: string[]) {
  for (const [key, value] of Object.entries(node)) {
    if (!names.includes(key.toLowerCase()) || typeof value !== "string") {
      continue;
    }
    const time = new Date(value).getTime();
    if (!Number.isNaN(time)) {
      return new Date(time).toISOString();
    }
  }
  return undefined;
}

function getStringLikeField(node: Record<string, unknown>, names: string[]) {
  for (const [key, value] of Object.entries(node)) {
    if (!names.includes(key.toLowerCase()) || typeof value !== "string") {
      continue;
    }
    const trimmed = value.trim();
    if (trimmed) {
      return trimmed;
    }
  }
  return undefined;
}

function toBooleanSignal(value: unknown): boolean | undefined {
  if (typeof value === "boolean") {
    return value;
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return value > 0;
  }
  if (typeof value === "string") {
    const v = value.trim().toLowerCase();
    if (["true", "yes", "on", "active", "detected", "present", "used"].includes(v)) {
      return true;
    }
    if (["false", "no", "off", "idle", "none", "notdetected", "absent", "unused"].includes(v)) {
      return false;
    }
  }
  return undefined;
}

function toBookingSignal(value: unknown): boolean | undefined {
  if (typeof value === "boolean") {
    return value;
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return value > 0;
  }
  if (typeof value === "string") {
    const v = value.trim().toLowerCase();
    if (["booked", "busy", "ongoing", "active", "inmeeting", "meeting", "reserved", "true"].includes(v)) {
      return true;
    }
    if (["free", "freeuntil", "available", "idle", "none", "notbooked", "false"].includes(v)) {
      return false;
    }
  }
  return undefined;
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
