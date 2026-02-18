export type DeviceStatus = "online" | "offline" | "unknown";

export type DeviceFaultSeverity = "info" | "warning" | "critical";
export type DeviceFaultSource = "webhook" | "webex_status";

export interface DeviceFault {
  id: string;
  code: string;
  message: string;
  severity: DeviceFaultSeverity;
  source?: DeviceFaultSource;
  createdAt: string;
}

export interface QosMetrics {
  packetLossPct?: number;
  jitterMs?: number;
  latencyMs?: number;
  mos?: number;
  bandwidthKbps?: number;
  rxBandwidthKbps?: number;
  txBandwidthKbps?: number;
  updatedAt: string;
}

export interface DeviceState {
  id: string;
  name: string;
  tags: string[];
  workspace?: string;
  product?: string;
  software?: string;
  status: DeviceStatus;
  statusSince: string;
  lastSeenAt?: string;
  inCall: boolean;
  callStateUpdatedAt?: string;
  faults: DeviceFault[];
  qos?: QosMetrics;
  updatedAt: string;
}

export interface DeviceEvent {
  id: string;
  deviceId: string;
  type: "status" | "fault" | "call" | "qos";
  at: string;
  payload: Record<string, unknown>;
}

export interface InboundWebhookEvent {
  id: string;
  resource: string;
  event: string;
  created: string;
  data: Record<string, unknown>;
}

export interface AdapterDevice {
  id: string;
  name: string;
  tags?: string[];
  workspace?: string;
  product?: string;
  software?: string;
  connected?: boolean;
  lastSeenAt?: string;
  errorCodes?: string[];
}

export interface AdapterCallMetrics {
  deviceId: string;
  inCall: boolean;
  packetLossPct?: number;
  jitterMs?: number;
  latencyMs?: number;
  mos?: number;
  bandwidthKbps?: number;
  rxBandwidthKbps?: number;
  txBandwidthKbps?: number;
}

export interface WebexAdapter {
  listDevices(): Promise<AdapterDevice[]>;
  fetchCallMetrics(deviceIds: string[]): Promise<AdapterCallMetrics[]>;
  getAccessContext?(): Promise<{
    personId: string;
    orgId?: string;
    displayName?: string;
  }>;
}

export type UserRole = "admin" | "readonly";

export interface AuthUser {
  email: string;
  role: UserRole;
}
