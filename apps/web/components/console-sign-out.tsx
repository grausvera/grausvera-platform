"use client";

import { authClient } from "../lib/auth-client";

export function ConsoleSignOut() {
  return (
    <button
      type="button"
      className="console-link-button"
      onClick={async () => {
        await authClient.signOut();
        window.location.assign("/console/acceso");
      }}
    >
      Cerrar sesión
    </button>
  );
}
