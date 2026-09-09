import { Pool } from "pg";

export async function checkDatabase(connectionString: string): Promise<void> {
  const pool = new Pool({ connectionString, connectionTimeoutMillis: 1_000, max: 1 });

  try {
    await pool.query("select 1");
  } finally {
    await pool.end();
  }
}
