import { randomUUID } from "node:crypto";
import {
  DeviceEvent,
  DeviceFault,
  DeviceState,
  InboundWebhookEvent,
  QosMetrics
} from "./types.js";

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
      callStateUpdatedAt: prev?.callStateUpdatedAt,
      faults: prev?.faults ?? [],
      qos: prev?.qos,
      updatedAt: now
    };

    this.devices.set(next.id, next);
    this.pushEvent({
      id: randomUUID(),
      deviceId: next.id,
      type: "status",
      at: now,
      payload: { status: next.status, statusSince: next.statusSince }
    });
    this.notifyListeners();
    return next;
  }

  setCallState(deviceId: string, inCall: boolean, qos?: QosMetrics) {
    const current = this.devices.get(deviceId);
    if (!current) {
      return;
    }
    const now = new Date().toISOString();
    current.inCall = inCall;
    current.callStateUpdatedAt = now;
    if (qos) {
      current.qos = qos;
      this.pushEvent({
        id: randomUUID(),
        deviceId,
        type: "qos",
        at: now,
        payload: qos as unknown as Record<string, unknown>
      });
    }
    current.updatedAt = now;
    this.pushEvent({
      id: randomUUID(),
      deviceId,
      type: "call",
      at: now,
      payload: { inCall }
    });
    this.notifyListeners();
  }

  addFault(deviceId: string, fault: Omit<DeviceFault, "id" | "createdAt">) {
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
