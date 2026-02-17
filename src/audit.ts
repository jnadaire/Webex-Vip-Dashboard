import { logger } from "./logger.js";

export interface AuditEntry {
  actor: string;
  action: string;
  target?: string;
  at: string;
  metadata?: Record<string, unknown>;
}

const entries: AuditEntry[] = [];

export function auditLog(entry: Omit<AuditEntry, "at">) {
  const full: AuditEntry = {
    ...entry,
    at: new Date().toISOString()
  };
  entries.push(full);
  if (entries.length > 5000) {
    entries.shift();
  }
  logger.info({ audit: full }, "audit-event");
}

export function listAudit(limit = 200) {
  return entries.slice(-limit).reverse();
}
