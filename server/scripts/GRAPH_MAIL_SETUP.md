# Microsoft Graph (free) — Outlook mail push for Lumi

Personal Hotmail/Outlook.com works. No Power Automate. No 60s polling.

## 1. Create a free Azure app (once)

1. Open https://portal.azure.com/#view/Microsoft_AAD_RegisteredApps/CreateApplicationBlade/quickStartType~/null/isMSAApp~/true
   (or Azure Portal → **App registrations** → **New registration**)
2. Name: `Lumi Mail OTP`
3. Supported account types: **Personal Microsoft accounts only**
   (or “Accounts in any org directory and personal Microsoft accounts”)
4. Redirect URI: leave blank (device code) **or**
   `http://127.0.0.1:9017/api/user/outlook/callback` (Public client/native)
5. Register → copy **Application (client) ID**

Then:
- **Authentication** → **Advanced** → **Allow public client flows** = **Yes**
- **API permissions** → Add Microsoft Graph **delegated**:
  - `User.Read`
  - `Mail.Read`
  - `offline_access` (often included automatically)
- No client secret needed for device code

## 2. Put client ID in env

`server/.env`:
```
OUTLOOK_CLIENT_ID=xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx
MAIL_WEBHOOK_PUBLIC_BASE=https://YOUR-TUNNEL.trycloudflare.com
```

Keep cloudflared running:
```
npm run mail:tunnel
```
(Update `MAIL_WEBHOOK_PUBLIC_BASE` if the tunnel URL changes, then restart API.)

## 3. Connect one or many mailboxes

Auto Bidder → Options → **Add mailbox** → complete device login
for each Hotmail/Outlook inbox that may receive Greenhouse codes.

Lumi listens to **all** connected mailboxes at once (Graph push).
Use **Remove** on a single address, or **Remove all**.

Greenhouse security-code mail is stored locally; Auto Bidder fills the OTP AFK.
