import {
  BriefSynthesisStore,
  KnowledgeStore,
  OperatorConsoleStore,
  type OperatorPrincipal,
} from "@grausvera/database";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { Pool } from "pg";
import { getAuth } from "./auth";

export async function requireOperator(): Promise<OperatorPrincipal> {
  const session = await getAuth().api.getSession({ headers: await headers() });
  if (!session) redirect("/console/acceso");

  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) throw new Error("DATABASE_URL is required for the operator console");
  const pool = new Pool({ connectionString, max: 1 });
  try {
    const result = await pool.query<{ organization_id: string }>(
      `SELECT organization_id FROM operator_memberships
       WHERE user_id = $1 AND role = 'ENGINEER' AND active LIMIT 1`,
      [session.user.id],
    );
    const membership = result.rows[0];
    if (!membership) redirect("/console/acceso?error=forbidden");
    if (session.user.twoFactorEnabled !== true) redirect("/console/activar-doble-factor");
    return {
      userId: session.user.id,
      organizationId: membership.organization_id,
      twoFactorVerified: true,
    };
  } finally {
    await pool.end();
  }
}

export function getOperatorStore(): OperatorConsoleStore {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) throw new Error("DATABASE_URL is required for the operator console");
  return new OperatorConsoleStore(connectionString);
}

export function getKnowledgeStore(): KnowledgeStore {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) throw new Error("DATABASE_URL is required for the operator console");
  return new KnowledgeStore(connectionString);
}

export function getBriefSynthesisStore(): BriefSynthesisStore {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) throw new Error("DATABASE_URL is required for the operator console");
  return new BriefSynthesisStore(connectionString);
}
