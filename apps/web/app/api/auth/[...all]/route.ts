import { getAuth } from "../../../../lib/auth";
import { Pool } from "pg";

export const dynamic = "force-dynamic";

export function GET(request: Request): Promise<Response> {
  return getAuth().handler(request);
}

export async function hardenOperatorSecurityChange(
  userId: string,
  keepSessionId: string | null,
  action: string,
): Promise<void> {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) throw new Error("DATABASE_URL is required for console authentication");
  const pool = new Pool({ connectionString, max: 1 });
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    if (keepSessionId)
      await client.query(`DELETE FROM "session" WHERE "userId"=$1 AND id<>$2`, [
        userId,
        keepSessionId,
      ]);
    else await client.query(`DELETE FROM "session" WHERE "userId"=$1`, [userId]);
    const membership = await client
      .query<{ id: string; organization_id: string }>(
        `SELECT id,organization_id FROM operator_memberships
         WHERE user_id=$1 AND role='ENGINEER' AND active LIMIT 1`,
        [userId],
      )
      .then((result) => result.rows[0]);
    if (!membership) throw new Error("operator_forbidden");
    await client.query(
      `INSERT INTO audit_events
        (organization_id,actor,action,resource_type,resource_id,result,correlation_id,origin)
       VALUES ($1,$2,$3,'operator_membership',$4,'SUCCEEDED',gen_random_uuid(),'operator-authentication')`,
      [membership.organization_id, `operator:${userId}`, action, membership.id],
    );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
    await pool.end();
  }
}

export async function POST(request: Request): Promise<Response> {
  const auth = getAuth();
  const path = new URL(request.url).pathname;
  const protectedChange = [
    "/api/auth/two-factor/generate-backup-codes",
    "/api/auth/two-factor/disable",
  ].includes(path);
  let session: Awaited<ReturnType<typeof auth.api.getSession>> | null = null;
  if (protectedChange) {
    const body = (await request.clone().json()) as { code?: unknown };
    if (typeof body.code !== "string") return new Response(null, { status: 400 });
    session = await auth.api.getSession({ headers: request.headers });
    if (!session) return new Response(null, { status: 401 });
    try {
      await auth.api.verifyTOTP({
        headers: request.headers,
        body: { code: body.code, trustDevice: false },
      });
    } catch {
      return new Response(null, { status: 401 });
    }
  }
  const response = await auth.handler(request);
  if (!response.ok) return response;
  if (path === "/api/auth/two-factor/generate-backup-codes" && session)
    await hardenOperatorSecurityChange(
      session.user.id,
      session.session.id,
      "authentication.recovery_codes_rotated",
    );
  if (path === "/api/auth/two-factor/disable" && session)
    await hardenOperatorSecurityChange(session.user.id, null, "authentication.totp_reset");
  if (path === "/api/auth/two-factor/verify-backup-code") {
    const body = (await response.clone().json()) as { user?: { id?: string } };
    if (body.user?.id) {
      const connectionString = process.env.DATABASE_URL;
      if (!connectionString) throw new Error("DATABASE_URL is required for console authentication");
      const pool = new Pool({ connectionString, max: 1 });
      const current = await pool
        .query<{ id: string }>(
          `SELECT id FROM "session" WHERE "userId"=$1 ORDER BY "createdAt" DESC LIMIT 1`,
          [body.user.id],
        )
        .then((result) => result.rows[0]?.id ?? null)
        .finally(() => pool.end());
      await hardenOperatorSecurityChange(body.user.id, current, "authentication.recovered");
    }
  }
  return response;
}
