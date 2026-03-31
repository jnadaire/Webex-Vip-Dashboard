import { config } from "./config.js";
import { logger } from "./logger.js";
import { DeviceStore } from "./store.js";
import { WebexAdapter } from "./types.js";

export function startPolling(store: DeviceStore, adapter: WebexAdapter) {
  const WEBHOOK_QOS_GRACE_MS = 15_000;
  const CALL_STATE_GRACE_MS = 60_000;
  const RECENT_QOS_INFERS_CALL_MS = 5 * 60_000;

  const deviceInterval = setInterval(async () => {
    const started = Date.now();
    try {
      const devices = await adapter.listDevices();
      for (const device of devices) {
        store.upsertDevice({
          id: device.id,
          name: device.name,
          tags: device.tags || [],
          roomId: device.roomId,
          workspace: device.workspace,
          product: device.product,
          software: device.software,
          status:
            device.connected === true
              ? "online"
              : device.connected === false
                ? "offline"
                : "unknown",
          lastSeenAt: device.lastSeenAt
        });
        store.syncSystemFaultCodes(device.id, device.errorCodes || []);
      }
      logger.info(
        {
          devices: devices.length,
          latencyMs: Date.now() - started
        },
        "poll-devices-ok"
      );
    } catch (error) {
      logger.error({ error }, "poll-devices-error");
    }
  }, config.POLL_INTERVAL_MS);

  const metricsInterval = setInterval(async () => {
    const started = Date.now();
    try {
      const deviceIds = store.listDevices().map((d) => d.id);
      if (deviceIds.length === 0) {
        return;
      }
      const metrics = await adapter.fetchCallMetrics(deviceIds);
      for (const metric of metrics) {
        store.setUsageState(
          metric.deviceId,
          metric.booked,
          metric.used,
          metric.nextMeeting,
          metric.bookingStatus,
          metric.bookingStatusTimeStamp
        );
        const hasQos =
          metric.packetLossPct !== undefined ||
          metric.jitterMs !== undefined ||
          metric.latencyMs !== undefined ||
          metric.mos !== undefined ||
          metric.bandwidthKbps !== undefined ||
          metric.rxBandwidthKbps !== undefined ||
          metric.txBandwidthKbps !== undefined;
        const current = store.getDevice(metric.deviceId);

        if (metric.inCall) {
          store.setCallState(
            metric.deviceId,
            true,
            hasQos
              ? {
                  packetLossPct: metric.packetLossPct,
                  jitterMs: metric.jitterMs,
                  latencyMs: metric.latencyMs,
                  mos: metric.mos,
                  bandwidthKbps: metric.bandwidthKbps,
                  rxBandwidthKbps: metric.rxBandwidthKbps,
                  txBandwidthKbps: metric.txBandwidthKbps,
                  updatedAt: new Date().toISOString()
                }
              : undefined,
            {
              callProtocol: metric.callProtocol,
              meetingPlatform: metric.meetingPlatform,
              callDisplayName: metric.callDisplayName
            }
          );
          continue;
        }

        if (hasQos) {
          store.setCallState(metric.deviceId, false, {
            packetLossPct: metric.packetLossPct,
            jitterMs: metric.jitterMs,
            latencyMs: metric.latencyMs,
            mos: metric.mos,
            bandwidthKbps: metric.bandwidthKbps,
            rxBandwidthKbps: metric.rxBandwidthKbps,
            txBandwidthKbps: metric.txBandwidthKbps,
            updatedAt: new Date().toISOString()
          });
          continue;
        }

        const qosFreshMs = current?.qos?.updatedAt
          ? Date.now() - new Date(current.qos.updatedAt).getTime()
          : Number.POSITIVE_INFINITY;
        const callStateFreshMs = current?.callStateUpdatedAt
          ? Date.now() - new Date(current.callStateUpdatedAt).getTime()
          : Number.POSITIVE_INFINITY;
        if (current?.inCall && qosFreshMs < WEBHOOK_QOS_GRACE_MS) {
          continue;
        }
        if (qosFreshMs < RECENT_QOS_INFERS_CALL_MS) {
          store.setCallState(metric.deviceId, true, current?.qos);
          continue;
        }
        if (current?.inCall && callStateFreshMs < CALL_STATE_GRACE_MS) {
          continue;
        }
        store.setCallState(metric.deviceId, false);
      }
      logger.info(
        {
          metrics: metrics.length,
          latencyMs: Date.now() - started
        },
        "poll-call-metrics-ok"
      );
    } catch (error) {
      logger.error({ error }, "poll-call-metrics-error");
    }
  }, config.CALL_METRICS_POLL_MS);

  return () => {
    clearInterval(deviceInterval);
    clearInterval(metricsInterval);
  };
}
