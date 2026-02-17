import { z } from "zod";

const configSchema = z.object({
  PORT: z.coerce.number().default(8080),
  JWT_SECRET: z.string().min(8).default("change-me"),
  WEBEX_BOT_TOKEN: z.string().optional().default(""),
  WEBEX_WEBHOOK_SECRET: z.string().optional().default(""),
  WEBEX_ORG_ID: z.string().optional().default(""),
  POLL_INTERVAL_MS: z.coerce.number().default(10_000),
  CALL_METRICS_POLL_MS: z.coerce.number().default(10_000),
  USE_MOCK_DATA: z
    .string()
    .optional()
    .default("true")
    .transform((v) => v === "true"),
  ADMIN_USERS: z.string().optional().default("admin@example.com"),
  READONLY_USERS: z.string().optional().default("viewer@example.com")
});

export const config = configSchema.parse(process.env);

export const adminUsers = new Set(
  config.ADMIN_USERS.split(",")
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean)
);

export const readonlyUsers = new Set(
  config.READONLY_USERS.split(",")
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean)
);
