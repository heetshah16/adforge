# Supabase Auth: Discord sign-in

Fetched 2026-10-28 from https://supabase.com/docs/guides/auth/social-login/auth-discord and https://supabase.com/docs/guides/auth/auth-identity-linking. Re-fetch before changing anything here.

## Setup (done by the user, 2026-10-29)

**Discord Developer Portal:**
1. Create an application.
2. Under OAuth2, add the redirect `https://<project-ref>.supabase.co/auth/v1/callback`.
3. Copy the Client ID and Client Secret.

**Supabase:**
1. Go to Authentication, then Sign In / Providers, then Discord.
2. Enable it and paste the ID and secret. These can also be set through the Management API (`external_discord_enabled`, `external_discord_client_id`, `external_discord_secret`).

The secret never passes through the repo or the agents.

**Supabase redirect allow list:** it must contain `<ADFORGE_SITE_URL>/auth/confirm`, because the provider callback redirects there with `?code=`.

## Flow (SSR, PKCE)

- `signInWithOAuth({ provider: 'discord', options: { redirectTo } })` on the `@supabase/ssr` server client.
- That call stores the PKCE code verifier in a cookie. It must reach the browser, so start the flow in a server action, where Next's `cookies()` is writable.
- Then redirect to `data.url`. We pass `skipBrowserRedirect: true` and redirect ourselves.
- The callback route reads `code` and calls `exchangeCodeForSession(code)`. `/auth/confirm` already does this for PKCE magic links.

## Email and linking

- **Automatic linking:** an OAuth sign-in with the same email as an existing user is linked to that user, so an invited or admin account keeps its id.
- **Unverified emails:** the docs call linking an identity to an unverified email insecure (pre-account takeover). Whether a session is issued for an unverified provider email is not documented on these pages.
- **Our handling:** we rely on Supabase. With "Confirm email" on, no session is issued for an unverified provider email. Do not gate on `user_metadata.email_verified`: users can write `user_metadata` through `updateUser`. Supabase's refusal arrives at the redirect URL as `?error=…&error_description=Unverified email with discord…`.
- **Scopes:** the Discord page documents no `scopes` option. We pass none.
