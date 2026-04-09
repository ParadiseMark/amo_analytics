import { z } from "zod";
import dotenv from "dotenv";

dotenv.config();

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
  PORT: z.coerce.number().default(3000),
  HOST: z.string().default("0.0.0.0"),

  JWT_SECRET: z.string().min(32),
  JWT_EXPIRES_IN: z.string().default("7d"),

  TOKEN_ENCRYPTION_KEY: z.string().length(64),

  DATABASE_URL: z.string().min(1),

  REDIS_HOST: z.string().default("localhost"),
  REDIS_PORT: z.coerce.number().default(6379),
  REDIS_PASSWORD: z.string().optional(),

  CLICKHOUSE_HOST: z.string().default("http://localhost:8123"),
  CLICKHOUSE_USER: z.string().default("amo"),
  CLICKHOUSE_PASSWORD: z.string().default("ch_secret"),
  CLICKHOUSE_DB: z.string().default("amo_analytics"),

  AMOCRM_CLIENT_ID: z.string().min(1),
  AMOCRM_CLIENT_SECRET: z.string().min(1),
  AMOCRM_REDIRECT_URI: z.string().min(1),

  OPENAI_API_KEY: z.string().optional(),
  TELEGRAM_BOT_TOKEN: z.string().optional(),

  POSTMARK_API_KEY: z.string().optional(),
  POSTMARK_FROM_EMAIL: z.string().email().optional(),
});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  console.error("❌ Invalid environment variables:");
  console.error(parsed.error.flatten().fieldErrors);
  process.exit(1);
}

export const env = parsed.data;
