"use client";

import { useState, type FormEvent } from "react";
import { authClient } from "../../../lib/auth-client";

export default function OperatorLoginPage() {
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPending(true);
    setError("");
    const data = new FormData(event.currentTarget);
    const result = await authClient.signIn.email({
      email: String(data.get("email")),
      password: String(data.get("password")),
    });
    setPending(false);
    if (result.error) setError("No fue posible validar las credenciales.");
    else {
      const data = result.data as typeof result.data & { twoFactorRedirect?: boolean };
      if (!data.twoFactorRedirect) window.location.assign("/console");
    }
  }

  return (
    <main id="contenido" className="page-shell console-shell">
      <section className="console-panel">
        <p className="eyebrow">Consola interna</p>
        <h1>Acceso</h1>
        <form onSubmit={submit} className="console-form">
          <label>
            Correo
            <input name="email" type="email" autoComplete="username" required />
          </label>
          <label>
            Contraseña
            <input
              name="password"
              type="password"
              autoComplete="current-password"
              minLength={14}
              required
            />
          </label>
          <button type="submit" disabled={pending}>
            {pending ? "Validando…" : "Continuar"}
          </button>
          {error && <p role="alert">{error}</p>}
        </form>
      </section>
    </main>
  );
}
