export class Observability {
  private webhookLatencies: number[] = [];
  private webhookBacklog = 0;

  recordWebhookLatency(ms: number) {
    if (Number.isFinite(ms) && ms >= 0) {
      this.webhookLatencies.push(ms);
      if (this.webhookLatencies.length > 1000) {
        this.webhookLatencies.shift();
      }
    }
  }

  setWebhookBacklog(size: number) {
    this.webhookBacklog = Math.max(0, size);
  }

  snapshot() {
    const count = this.webhookLatencies.length;
    const avg = count
      ? this.webhookLatencies.reduce((sum, n) => sum + n, 0) / count
      : 0;
    const p95 = count
      ? this.webhookLatencies.slice().sort((a, b) => a - b)[Math.floor(count * 0.95)] || 0
      : 0;

    return {
      webhookLatencyAvgMs: Number(avg.toFixed(2)),
      webhookLatencyP95Ms: Number(p95.toFixed(2)),
      webhookSamples: count,
      webhookBacklog: this.webhookBacklog
    };
  }
}
