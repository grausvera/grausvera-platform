import { betterAuth } from "better-auth";
import { twoFactor } from "better-auth/plugins";
import { Pool } from "pg";

function configureAuth(connectionString: string, secret: string, allowProvisioning: boolean) {
  return betterAuth({
    appName: "grausvera",
    baseURL: process.env.BETTER_AUTH_URL,
    secret,
    database: new Pool({ connectionString, max: 5 }),
    emailAndPassword: {
      enabled: true,
      disableSignUp: !allowProvisioning,
      minPasswordLength: 14,
      revokeSessionsOnPasswordReset: true,
    },
    session: {
      expiresIn: 60 * 60 * 8,
      updateAge: 60 * 60,
      freshAge: 60 * 5,
      cookieCache: { enabled: false },
    },
    advanced: {
      useSecureCookies: process.env.NODE_ENV === "production",
      cookiePrefix: "grausvera_console",
    },
    plugins: [
      twoFactor({
        issuer: "grausvera",
        skipVerificationOnEnable: false,
        totpOptions: { period: 30, digits: 6 },
      }),
    ],
  });
}

let instance: ReturnType<typeof configureAuth> | undefined;

export function getAuth(options?: { allowProvisioning?: boolean }) {
  if (instance && !options?.allowProvisioning) return instance;
  const connectionString = process.env.DATABASE_URL;
  const secret = process.env.BETTER_AUTH_SECRET;
  if (!connectionString) throw new Error("DATABASE_URL is required for console authentication");
  if (!secret || secret.length < 32)
    throw new Error("BETTER_AUTH_SECRET must contain at least 32 characters");

  const auth = configureAuth(connectionString, secret, Boolean(options?.allowProvisioning));
  if (!options?.allowProvisioning) instance = auth;
  return auth;
}
