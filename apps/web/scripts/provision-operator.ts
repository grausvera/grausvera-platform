import { Pool } from "pg";
const { getAuth } = await import(new URL("../lib/auth.ts", import.meta.url).href);

const connectionString = process.env.DATABASE_URL;
const email = process.env.OPERATOR_EMAIL;
const password = process.env.OPERATOR_PASSWORD;
const name = process.env.OPERATOR_NAME ?? "grausvera operator";
const organizationSlug = process.env.OPERATOR_ORGANIZATION_SLUG ?? "grausvera";

if (!connectionString) throw new Error("DATABASE_URL is required");
if (!email) throw new Error("OPERATOR_EMAIL is required");
if (!password || password.length < 14)
  throw new Error("OPERATOR_PASSWORD must contain at least 14 characters");

const pool = new Pool({ connectionString, max: 1 });
try {
  const existing = await pool.query("SELECT 1 FROM operator_memberships WHERE active LIMIT 1");
  if ((existing.rowCount ?? 0) > 0) throw new Error("operator_already_provisioned");

  const organization = await pool.query<{ id: string }>(
    `INSERT INTO organizations (slug, display_name) VALUES ($1, 'grausvera')
     ON CONFLICT (slug) DO UPDATE SET display_name = excluded.display_name RETURNING id`,
    [organizationSlug],
  );
  const organizationId = organization.rows[0]?.id;
  if (!organizationId) throw new Error("operator_organization_not_found");

  const existingUser = await pool.query<{ id: string }>(`SELECT id FROM "user" WHERE email = $1`, [
    email,
  ]);
  const userId =
    existingUser.rows[0]?.id ??
    (
      await getAuth({ allowProvisioning: true }).api.signUpEmail({
        body: { name, email, password },
      })
    ).user.id;
  await pool.query(
    `INSERT INTO operator_memberships (organization_id, user_id)
     VALUES ($1, $2)
     RETURNING organization_id`,
    [organizationId, userId],
  );
  process.stdout.write(`${JSON.stringify({ event: "operator_provisioned", status: "created" })}\n`);
} finally {
  await pool.end();
}
