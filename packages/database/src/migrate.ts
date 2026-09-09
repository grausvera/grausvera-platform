import { fileURLToPath } from "node:url";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Pool } from "pg";

const connectionString =
  process.env.DATABASE_URL ?? "postgresql://grausvera:local-password@127.0.0.1:5432/grausvera";
const migrationsFolder = fileURLToPath(new URL("../drizzle", import.meta.url));
const pool = new Pool({ connectionString });

try {
  await migrate(drizzle(pool), { migrationsFolder });
} finally {
  await pool.end();
}
