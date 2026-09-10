"use client";

import { useState, type FormEvent } from "react";
import { authClient } from "../../../lib/auth-client";

export default function VerifyTwoFactorPage() {
  const [error, setError] = useState("");

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const code = String(new FormData(event.currentTarget).get("code"));
    const result = await authClient.twoFactor.verifyTotp({ code, trustDevice: false });
    if (result.error) setError("El código no es válido o ha expirado.");
    else window.location.assign("/console");
  }

  return (
    <main id="contenido" className="page-shell console-shell">
      <section className="console-panel">
        <p className="eyebrow">Consola interna</p>
        <h1>Doble factor</h1>
        <form onSubmit={submit} className="console-form">
          <label>
            Código TOTP
            <input
              name="code"
              inputMode="numeric"
              autoComplete="one-time-code"
              pattern="[0-9]{6}"
              required
            />
          </label>
          <button type="submit">Verificar</button>
          {error && <p role="alert">{error}</p>}
        </form>
      </section>
    </main>
  );
}
