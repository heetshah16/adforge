# 0021 — Discord sign-in

**Date:** 2026-10-29
**Status:** accepted (user decision)

## Context

Sign-in was email magic links only (ADR 0015). Supabase's built-in mailer allows a handful of emails per hour per project. The first sign-ins from production (https://adforge-olive.vercel.app) hit `email rate limit exceeded` and the per-address 60 s cooldown, so nobody could sign in. Custom SMTP was a B6 item. The user chose Discord OAuth instead of setting up email delivery now.

## Decision

- **Discord is the primary sign-in.**
  - `/signin` shows "Continue with Discord". A server action calls `discordUrlWith` (`lib/server/signin.ts`), which runs `signInWithOAuth({ provider: 'discord', redirectTo: <ADFORGE_SITE_URL>/auth/confirm, skipBrowserRedirect: true })` and redirects to Discord.
  - `/auth/confirm` already exchanges `?code=`, so no new route is needed.
  - On an error, the action sends the user to `/signin?error=link`.
- **The email-link form stays** as a fallback. It becomes reliable once custom SMTP exists (B6).
- **The invite gate is unchanged:** admin list, invited or joined waitlist email, or an existing membership, all keyed on the account email. Supabase links a Discord sign-in to an existing user with the same email, so ids carry over.
- **Hardening in `session.ts`:** claims from a provider other than `email` are refused (sent to `/signin`) unless `user_metadata.email_verified === true`. This stops an unverified Discord email from claiming an admin or invited address if Supabase's own verification ever changes.
- **Credentials:** the Discord Client ID and Secret live only in the Supabase dashboard. Our env has nothing new.

## Consequences

- **The Discord account's email is what counts.** To get in, someone's Discord email must be verified and must match the admin list or an invite.
- **Invites no longer depend on the email arriving.** `POST /api/admin/invite` still calls `inviteUserByEmail`, but that email is now best-effort. Before, a mailer failure returned 502 and left the entry `new`. Now the entry is marked invited either way, and the response carries `emailSent`. Tell invitees to use "Continue with Discord" with that email.
- **Fewer emails:** sign-in no longer depends on email delivery. Custom SMTP (B6) is still needed for invite emails and the fallback form.
- **Supabase Site URL** should be the production URL, because the custom email templates build links from `{{ .SiteURL }}`.
