"use client";

import { useState, type FormEvent } from "react";

export function OperatorSecuritySettings() {
  const [backupCodes, setBackupCodes] = useState<string[]>([]);
  const [message, setMessage] = useState("");

  async function rotateRecoveryCodes(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setMessage("");
    const data = new FormData(event.currentTarget);
    try {
      const response = await fetch("/api/auth/two-factor/generate-backup-codes", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ password: data.get("password"), code: data.get("code") }),
      });
      if (!response.ok) throw new Error("rotation_failed");
      const result = (await response.json()) as { backupCodes: string[] };
      setBackupCodes(result.backupCodes);
      setMessage("Los códigos anteriores quedaron invalidados.");
    } catch {
      setMessage("No fue posible renovar los códigos con las credenciales indicadas.");
    }
  }

  async function resetTotp(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setMessage("");
    const data = new FormData(event.currentTarget);
    try {
      const response = await fetch("/api/auth/two-factor/disable", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ password: data.get("password"), code: data.get("code") }),
      });
      if (!response.ok) throw new Error("disable_failed");
      window.location.assign("/console/acceso");
    } catch {
      setMessage("No fue posible cambiar el método TOTP con las credenciales indicadas.");
    }
  }

  return (
    <>
      <section className="console-panel">
        <h2>Códigos de recuperación</h2>
        <p>Renovarlos invalida los anteriores y revoca las demás sesiones.</p>
        <form onSubmit={rotateRecoveryCodes} className="console-form">
          <label>
            Contraseña
            <input name="password" type="password" autoComplete="current-password" required />
          </label>
          <label>
            Código TOTP actual
            <input name="code" inputMode="numeric" pattern="[0-9]{6}" required />
          </label>
          <button type="submit">Renovar códigos</button>
        </form>
        {backupCodes.length > 0 && <p className="console-secret">{backupCodes.join(" · ")}</p>}
      </section>
      <section className="console-panel">
        <h2>Cambiar o desactivar TOTP</h2>
        <p>La consola cerrará todas las sesiones y exigirá enrolar un método nuevo.</p>
        <form onSubmit={resetTotp} className="console-form">
          <label>
            Contraseña
            <input name="password" type="password" autoComplete="current-password" required />
          </label>
          <label>
            Código TOTP actual
            <input name="code" inputMode="numeric" pattern="[0-9]{6}" required />
          </label>
          <button type="submit">Restablecer TOTP</button>
        </form>
      </section>
      {message && <p role="status">{message}</p>}
    </>
  );
}
