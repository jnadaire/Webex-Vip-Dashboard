import { randomUUID } from "node:crypto";
import {
  DeviceFaultSource,
  DeviceEvent,
  DeviceFault,
  DeviceState,
  InboundWebhookEvent,
  QosMetrics
} from "./types.js";
import { isCrashSignal } from "./crash.js";

const WEBHOOK_EVENT_TTL_MS = 60 * 60 * 1000;

export class DeviceStore {
  private readonly devices = new Map<string, DeviceState>();
  private readonly events: DeviceEvent[] = [];
  private readonly seenWebhookEvents = new Map<string, number>();
  private readonly listeners = new Set<() => void>();

  upsertDevice(partial: Omit<DeviceState, "faults" | "inCall" | "updatedAt" | "statusSince"> & {
    statusSince?: string;
  }) {
    const now = new Date().toISOString();
    const prev = this.devices.get(partial.id);

    const next: DeviceState = {
      id: partial.id,
      name: partial.name,
      tags: [...new Set((partial.tags || prev?.tags || []).filter(Boolean))],
      workspace: partial.workspace,
      product: partial.product,
      software: partial.software,
      status: partial.status,
      statusSince:
        prev?.status === partial.status
          ? prev.statusSince
          : partial.statusSince || now,
      lastSeenAt: partial.lastSeenAt,
      inCall: prev?.inCall ?? false,
      booked: prev?.booked,
      used: prev?.used,
      possibleCrash:
        partial.status === "offline"
          ? (prev?.possibleCrash ?? false)
          : false,
      callStateUpdatedAt: prev?.callStateUpdatedAt,
      faults: prev?.faults ?? [],
      qos: prev?.qos,
      updatedAt: now
    };

    const possibleCrashTransition =
      !!prev && prev.inCall && prev.status !== "offline" && next.status === "offline";
    if (possibleCrashTransition) {
      next.possibleCrash = true;
      const already = next.faults.some((f) => String(f.code).toLowerCase() === "possible_crash");
      if (!already) {
        const crashFault: DeviceFault = {
          id: randomUUID(),
          code: "POSSIBLE_CRASH",
          message: "possible crash",
          severity: "critical",
          createdAt: now
        };
        next.faults.unshift(crashFault);
        this.pushEvent({
          id: randomUUID(),
          deviceId: next.id,
          type: "fault",
          at: now,
          payload: crashFault as unknown as Record<string, unknown>
        });
      }
    } else if (next.status !== "offline") {
      next.possibleCrash = false;
      next.faults = next.faults.filter((f) => String(f.code).toLowerCase() !== "possible_crash");
      next.faults = next.faults.filter((f) => !isOfflineStatusFault(f));
    }

    this.devices.set(next.id, next);
    const statusChanged = !!prev && prev.status !== next.status;
    if (statusChanged) {
      this.pushEvent({
        id: randomUUID(),
        deviceId: next.id,
        type: "status",
        at: now,
        payload: { status: next.status, statusSince: next.statusSince }
      });
    }
    this.notifyListeners();
    return next;
  }

  setCallState(deviceId: string, inCall: boolean, qos?: QosMetrics) {
    const current = this.devices.get(deviceId);
    if (!current) {
      return;
    }
    const now = new Date().toISOString();
    const callChanged = current.inCall !== inCall;
    const qosChanged = qos ? !sameQos(current.qos, qos) : false;

    current.inCall = inCall;
    if (callChanged) {
      current.callStateUpdatedAt = now;
    }
    if (qos) {
      current.qos = qos;
      if (qosChanged) {
        this.pushEvent({
          id: randomUUID(),
          deviceId,
          type: "qos",
          at: now,
          payload: qos as unknown as Record<string, unknown>
        });
      }
    }
    current.updatedAt = now;
    if (callChanged) {
      this.pushEvent({
        id: randomUUID(),
        deviceId,
        type: "call",
        at: now,
        payload: { inCall }
      });
    }
    if (callChanged || qosChanged) {
      this.notifyListeners();
    }
  }

  setUsageState(deviceId: string, booked?: boolean, used?: boolean) {
    const current = this.devices.get(deviceId);
    if (!current) {
      return;
    }
    let changed = false;
    if (typeof booked === "boolean" && current.booked !== booked) {
      current.booked = booked;
      changed = true;
    }
    if (typeof used === "boolean" && current.used !== used) {
      current.used = used;
      changed = true;
    }
    if (!changed) {
      return;
    }
    current.updatedAt = new Date().toISOString();
    this.notifyListeners();
  }

  addFault(deviceId: string, fault: Omit<DeviceFault, "id" | "createdAt"> & { source?: DeviceFaultSource }) {
    const current = this.devices.get(deviceId);
    if (!current) {
      return;
    }
    const createdAt = new Date().toISOString();
    const full: DeviceFault = {
      id: randomUUID(),
      createdAt,
      ...fault
    };
    current.faults.unshift(full);
    current.faults = current.faults.slice(0, 20);
    current.updatedAt = createdAt;
    this.pushEvent({
      id: randomUUID(),
      deviceId,
      type: "fault",
      at: createdAt,
      payload: full as unknown as Record<string, unknown>
    });
    this.notifyListeners();
  }

  syncSystemFaultCodes(deviceId: string, codes: string[]) {
    const current = this.devices.get(deviceId);
    if (!current) {
      return;
    }

    const desired = [...new Set((codes || []).map((c) => String(c || "").trim()).filter(Boolean))];
    const desiredKeys = new Set(desired.map((c) => toSystemFaultKey(c)));
    const managedCurrent = current.faults.filter((f) => isSystemManagedFault(f));
    const managedCurrentKeys = new Set(managedCurrent.map((f) => toSystemFaultKey(f.code || f.message || "")));

    const sameSet =
      managedCurrentKeys.size === desiredKeys.size &&
      [...managedCurrentKeys].every((k) => desiredKeys.has(k));
    if (sameSet) {
      return;
    }

    const now = new Date().toISOString();
    const nextSystem = desired.map((code) => {
      const key = toSystemFaultKey(code);
      const existing = managedCurrent.find((f) => toSystemFaultKey(f.code || f.message || "") === key);
      if (existing) {
        return { ...existing, source: "webex_status" as const };
      }
      const created: DeviceFault = {
        id: randomUUID(),
        code,
        message: mapSystemFaultMessage(code),
        severity: isCrashSignal(code) ? "critical" : "warning",
        source: "webex_status",
        createdAt: now
      };
      this.pushEvent({
        id: randomUUID(),
        deviceId,
        type: "fault",
        at: now,
        payload: created as unknown as Record<string, unknown>
      });
      return created;
    });

    const nonSystem = current.faults.filter((f) => !isSystemManagedFault(f));
    current.faults = [...nextSystem, ...nonSystem].slice(0, 20);
    current.updatedAt = now;
    this.notifyListeners();
  }

  clearFaults(deviceId: string) {
    const current = this.devices.get(deviceId);
    if (!current) {
      return;
    }
    current.faults = [];
    current.updatedAt = new Date().toISOString();
    this.notifyListeners();
  }

  listDevices() {
    return [...this.devices.values()].sort((a, b) => a.name.localeCompare(b.name));
  }

  getDevice(deviceId: string) {
    return this.devices.get(deviceId);
  }

  listEvents(limit = 200) {
    return this.events.slice(-limit).reverse();
  }

  subscribe(listener: () => void) {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  processWebhook(event: InboundWebhookEvent) {
    const now = Date.now();
    this.cleanupSeenEvents(now);
    const dedupeKey = `${event.id}|${event.event}|${event.created}`;
    if (this.seenWebhookEvents.has(dedupeKey)) {
      return false;
    }

    this.seenWebhookEvents.set(dedupeKey, now);
    return true;
  }

  private pushEvent(event: DeviceEvent) {
    this.events.push(event);
    if (this.events.length > 5000) {
      this.events.shift();
    }
  }

  private cleanupSeenEvents(nowMs: number) {
    for (const [id, ts] of this.seenWebhookEvents) {
      if (nowMs - ts > WEBHOOK_EVENT_TTL_MS) {
        this.seenWebhookEvents.delete(id);
      }
    }
  }

  private notifyListeners() {
    for (const listener of this.listeners) {
      listener();
    }
  }
}

function mapSystemFaultMessage(code: string) {
  const key = code.toLowerCase();
  if (isCrashSignal(code)) {
    return "Device crash detected";
  }
  if (key === "ultrasoundconfigsettings") {
    return "Ultrasound pairing may fail";
  }
  return code;
}

function toSystemFaultKey(value: string) {
  const v = String(value || "").toLowerCase();
  if (v.includes("ultrasound") || v.includes("ultrason")) {
    return "ultrasound";
  }
  return v.trim();
}

function isSystemManagedFault(fault: DeviceFault) {
  if (fault.source === "webex_status") {
    return true;
  }
  const key = toSystemFaultKey(`${fault.code} ${fault.message}`);
  return key === "ultrasound";
}

function isOfflineStatusFault(fault: DeviceFault) {
  const text = `${fault.code || ""} ${fault.message || ""}`.toLowerCase();
  return (
    text.includes("online/offline") ||
    text.includes("device is now offline") ||
    text.includes("device went offline")
  );
}

function sameQos(a: QosMetrics | undefined, b: QosMetrics | undefined) {
  if (!a && !b) {
    return true;
  }
  if (!a || !b) {
    return false;
  }
  return (
    a.packetLossPct === b.packetLossPct &&
    a.jitterMs === b.jitterMs &&
    a.latencyMs === b.latencyMs &&
    a.mos === b.mos &&
    a.bandwidthKbps === b.bandwidthKbps &&
    a.rxBandwidthKbps === b.rxBandwidthKbps &&
    a.txBandwidthKbps === b.txBandwidthKbps
  );
}
