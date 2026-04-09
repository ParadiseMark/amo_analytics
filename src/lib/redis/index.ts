import Redis from "ioredis";
// @ts-ignore — ioredis ESM/CJS interop
import { env } from "../../config/env.js";

const redisOptions = {
  host: env.REDIS_HOST,
  port: env.REDIS_PORT,
  password: env.REDIS_PASSWORD,
  maxRetriesPerRequest: null,
  enableReadyCheck: false,
  lazyConnect: true,
};

// Main connection for BullMQ (requires maxRetriesPerRequest: null)
export const redis = new (Redis as any)(redisOptions);

// Separate connection for general use (cache, rate limiting)
export const redisCache = new (Redis as any)({
  ...redisOptions,
  maxRetriesPerRequest: 3,
});

redis.on("error", (err) => console.error("Redis error:", err));
redisCache.on("error", (err) => console.error("Redis cache error:", err));

export async function checkRedisConnection(): Promise<void> {
  await redisCache.connect();
  await redisCache.ping();
}
