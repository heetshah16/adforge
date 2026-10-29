# 0021 — Discord sign-in

**Date:** 2026-10-29
**Status:** accepted (user decision)

## Context

Sign-in was email magic links only (ADR 0015). Supabase's built-in mailer allows a handful of emails per hour per project. The first sign-ins from production (https://adforge-olive.vercel.app) hit `email rate limit exceeded` and the per-address 60 s cooldown, so nobody could sign in. Custom SMTP was a B6 item. The user chose Discord OAuth instead of setting up email delivery now.

## Decision

- **Discord is the primary sign-in.**
  - `/signin` shows "Continue with Discord". A server action calls `discordUrlWith` (`lib/server/signin.ts`), which runs `signInWithOAuth({ provider: 'discord', redirectTo: <ADFORGE_SITE_URL>/auth/confirm, skipBrowserRedirect: true })` and redirects to Discord.
  - `/auth/confirm` already exchanges `?code=`, so no new route is needed.
  - `signInWithOAuth` builds the authorize URL locally, so a provider misconfiguration surfaces at Supabase's `/authorize`, not here. The `/signin?error=link` fallback is only a guard.
  - If Supabase refuses a Discord login because the email is unverified, `/auth/confirm` maps its `error_description` to `/signin?error=unverified`, which tells the user to verify the email in Discord.
- **The email-link form stays** as a fallback. It becomes reliable once custom SMTP exists (B6).
- **The invite gate is unchanged:** admin list, invited or joined waitlist email, or an existing membership, all keyed on the account email. Supabase links a Discord sign-in to an existing user with the same email, so ids carry over.
- **The gate's email trust rests on Supabase, not on our code.** The invite gate trusts `claims.email` for magic links and Discord alike. That holds because, while "Confirm email" is on (`mailer_autoconfirm=false`, asserted by `scripts/supabase-auth-config.mjs`), Supabase issues no session for an unverified provider email and links identities only on verified emails. An earlier draft also checked `user_metadata.email_verified`. The security review (2026-10-29) showed users can write `user_metadata`, so that check proved nothing and was removed rather than kept as false comfort. A real check would read `email_confirmed_at` through `getUser()`.
- **Credentials:** the Discord Client ID and Secret live only in the Supabase dashboard. Our env has nothing new.

## Consequences

- **The Discord account's email is what counts.** To get in, someone's Discord email must be verified and must match the admin list or an invite.
- **Invites no longer depend on the email arriving.** `POST /api/admin/invite` still calls `inviteUserByEmail`, but that email is now best-effort. Before, a mailer failure returned 502 and left the entry `new`. Now the entry is marked invited either way, and the response carries `emailSent`. When it is false, the admin page says the email was not sent. There is no resend yet: an invited row returns early. Add a resend at B6 with SMTP. Tell invitees to use "Continue with Discord" with that email.
- **Fewer emails:** sign-in no longer depends on email delivery. Custom SMTP (B6) is still needed for invite emails and the fallback form.
- **Supabase Site URL** should be the production URL, because the custom email templates build links from `{{ .SiteURL }}`.
