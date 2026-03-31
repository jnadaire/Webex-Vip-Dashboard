import { AdapterCallMetrics, AdapterDevice, WebexAdapter } from "../types.js";

const SAMPLE_DEVICES: AdapterDevice[] = [
  {
    id: "dev-1",
    name: "Boardroom Paris",
    tags: ["vip", "boardroom", "paris"],
    workspace: "Paris HQ",
    product: "Webex Room Kit Pro",
    software: "RoomOS 11",
    connected: true,
    lastSeenAt: new Date().toISOString()
  },
  {
    id: "dev-2",
    name: "Executive Office NYC",
    tags: ["executive", "nyc"],
    workspace: "NYC",
    product: "Webex Desk Pro",
    software: "RoomOS 11",
    connected: false,
    lastSeenAt: new Date(Date.now() - 60_000).toISOString()
  }
];

export class MockWebexAdapter implements WebexAdapter {
  async getAccessContext(): Promise<{ personId: string; orgId?: string; displayName?: string }> {
    return {
      personId: "mock-person",
      orgId: "mock-org",
      displayName: "Mock User"
    };
  }

  async listDevices(): Promise<AdapterDevice[]> {
    return SAMPLE_DEVICES.map((d, i) => ({
      ...d,
      connected: i === 0 ? true : Math.random() > 0.4,
      lastSeenAt: new Date(Date.now() - Math.floor(Math.random() * 45_000)).toISOString()
    }));
  }

  async fetchCallMetrics(deviceIds: string[]): Promise<AdapterCallMetrics[]> {
    return deviceIds.map((deviceId) => {
      const inCall = Math.random() > 0.5;
      if (!inCall) {
        return {
          deviceId,
          inCall: false,
          booked: Math.random() > 0.45,
          bookingStatus: Math.random() > 0.5 ? "freeuntil" : "free",
          used: Math.random() > 0.5,
          nextMeeting:
            Math.random() > 0.35
              ? {
                  title: "Quarterly Business Review",
                  startAt: new Date(Date.now() + 45 * 60_000).toISOString(),
                  endAt: new Date(Date.now() + 90 * 60_000).toISOString()
                }
              : undefined
        };
      }
      return {
        deviceId,
        inCall,
        callProtocol: "WebRTC",
        meetingPlatform: ["GoogleMeet", "Zoom", "MicrosoftTeams", "Webex"].at(
          Math.floor(Math.random() * 4)
        ),
        callDisplayName: "meeting-room-demo",
        booked: true,
        bookingStatus: "booked",
        used: true,
        nextMeeting:
          Math.random() > 0.5
            ? {
                title: "Exec Sync",
                startAt: new Date(Date.now() + 2 * 60 * 60_000).toISOString(),
                endAt: new Date(Date.now() + 150 * 60_000).toISOString()
              }
            : undefined,
        packetLossPct: Number((Math.random() * 3).toFixed(2)),
        jitterMs: Number((Math.random() * 30).toFixed(1)),
        latencyMs: Number((50 + Math.random() * 150).toFixed(1)),
        mos: Number((3 + Math.random() * 1.5).toFixed(2)),
        rxBandwidthKbps: Number((500 + Math.random() * 3500).toFixed(0)),
        txBandwidthKbps: Number((500 + Math.random() * 3500).toFixed(0)),
        bandwidthKbps: Number((1000 + Math.random() * 7000).toFixed(0))
      };
    });
  }
}
