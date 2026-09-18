"use client";

import { usernameClient } from "better-auth/client/plugins";
import { createAuthClient } from "better-auth/react";

/**
 * Browser auth client. It talks to /api/auth on whatever origin Kru is open
 * on. The admin's OIDC provider is a social provider to Better Auth, so
 * `signIn.social({ provider: "oidc" })` starts that sign-in.
 */
export const authClient = createAuthClient({
  plugins: [usernameClient()],
});
