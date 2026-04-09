/**
 * Запускает Drizzle миграции из директории /drizzle.
 * Используется как отдельный скрипт перед стартом сервера:
 *   node dist/lib/db/migrate.js
 *
 * В docker-compose запускается как init-container или CMD до старта backend.
 */
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import pg from "pg";
import * as dotenv from "dotenv";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const __filename = fileURLToPath(import.meta.url);
const __dirname  = dirname(__filename);

// Загружаем .env из корня проекта (3 уровня вверх от src/lib/db/)
dotenv.config({ path: join(__dirname, "../../../.env") });

const { Pool } = pg;

async function runMigrations() {
  const connectionString = process.env.DIRECT_DATABASE_URL ?? process.env.DATABASE_URL!;

  // Parse URL manually to avoid pg-connection-string issues with special chars
  // Node's URL class doesn't support postgresql:// scheme, normalize to postgres://
  const parsed = new URL(connectionString.replace(/^postgresql:\/\//, "postgres://"));
  const pool = new Pool({
    host: parsed.hostname,
    port: Number(parsed.port) || 5432,
    database: parsed.pathname.replace(/^\//, ""),
    user: decodeURIComponent(parsed.username),
    password: decodeURIComponent(parsed.password),
    ssl: parsed.hostname.includes("supabase.co") ? { rejectUnauthorized: false } : false,
    // @ts-ignore — force IPv4 to avoid IPv6 timeout issues
    family: 4,
  });

  const db = drizzle(pool);

  const migrationsFolder = join(__dirname, "../../../drizzle");

  console.log("[migrate] Запуск миграций из", migrationsFolder);

  await migrate(db, { migrationsFolder });

  console.log("[migrate] Миграции применены успешно");

  await pool.end();
}

runMigrations().catch((err) => {
  console.error("[migrate] Ошибка:", err);
  process.exit(1);
});
