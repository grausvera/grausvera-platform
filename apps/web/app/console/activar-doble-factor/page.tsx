"use client";

import { useState, type FormEvent } from "react";
import { authClient } from "../../../lib/auth-client";

export default function EnrollTwoFactorPage() {
  const [totpUri, setTotpUri] = useState("");
  const [backupCodes, setBackupCodes] = useState<string[]>([]);
  const [error, setError] = useState("");

  async function enable(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const password = String(new FormData(event.currentTarget).get("password"));
    const result = await authClient.twoFactor.enable({ password, issuer: "grausvera" });
    if (result.error) setError("No fue posible activar el doble factor.");
    else if (result.data.method === "totp") {
      setTotpUri(result.data.totpURI);
      setBackupCodes(result.data.backupCodes);
    } else setError("El método TOTP no está disponible.");
  }

  async function verify(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const code = String(new FormData(event.currentTarget).get("code"));
    const result = await authClient.twoFactor.verifyTotp({ code, trustDevice: false });
    if (result.error) setError("El código no es válido o ha expirado.");
    else {
      await authClient.revokeOtherSessions();
      window.location.assign("/console");
    }
  }

  return (
    <main id="contenido" className="page-shell console-shell">
      <section className="console-panel">
        <p className="eyebrow">Seguridad obligatoria</p>
        <h1>Activar doble factor</h1>
        {!totpUri ? (
          <form onSubmit={enable} className="console-form">
            <p>Confirma tu contraseña para generar la clave TOTP.</p>
            <label>
              Contraseña
              <input name="password" type="password" autoComplete="current-password" required />
            </label>
            <button type="submit">Generar clave</button>
          </form>
        ) : (
          <>
            <p>Importa esta URI en tu aplicación autenticadora:</p>
            <code className="console-secret">{totpUri}</code>
            <p>Guarda estos códigos fuera de la plataforma. Solo se muestran ahora.</p>
            <code className="console-secret">{backupCodes.join(" · ")}</code>
            <form onSubmit={verify} className="console-form">
              <label>
                Código TOTP
                <input name="code" inputMode="numeric" pattern="[0-9]{6}" required />
              </label>
              <button type="submit">Confirmar activación</button>
            </form>
          </>
        )}
        {error && <p role="alert">{error}</p>}
      </section>
    </main>
  );
}
