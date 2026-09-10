# Microsoft Outlook Email Setup Guide

## Account Types Supported

| Account Type | OUTLOOK_AUTH_TENANT | Setup Required |
|--------------|---------------------|----------------|
| Personal (outlook.com, hotmail.com, live.com) | Not set or `consumers` | 1 Azure App |
| Work/School (Microsoft 365) | `common` or tenant ID | 1+ Azure Apps |

**One Azure App can support unlimited personal accounts.** No need for multiple apps or tenants!

For **work accounts from multiple organizations**, set `OUTLOOK_AUTH_TENANT=common` (multi-tenant) or register separate apps for each organization's Entra tenant.

---

This guide will help you set up Microsoft Graph to receive OTP emails from Greenhouse.

## Step 1: Register Azure App

1. Go to **https://entra.microsoft.com**
2. Sign in with your Microsoft account
3. In the left sidebar, click **Applications** → **App registrations**
4. Click **New registration**
5. Fill in:
   - **Name**: `Lumi Auto-Bid`
   - **Supported account types**: Select **"Personal Microsoft accounts only"**
6. Click **Register**
7. Copy the **Application (client) ID** - you'll need this later

## Step 2: Configure Authentication

1. In your new app, click **Authentication** in the left sidebar
2. Scroll down to **"Allow public client flows"**
3. Toggle it to **Enabled**
4. Click **Save**

## Step 3: Add API Permissions

1. Click **API permissions** in the left sidebar
2. Click **Add a permission**
3. Select **Microsoft Graph**
4. Select **Delegated permissions**
5. Search and add:
   - `Mail.Read` - Read email
   - `User.Read` - Read user profile
   - `offline_access` - Keep tokens refreshed
6. Click **Add permissions**
7. If you see "Grant admin consent" button, click it (may require admin approval)

## Step 4: Update Server Configuration

1. Open `server/.env` file
2. Add your Client ID:

```bash
OUTLOOK_CLIENT_ID=your-client-id-here
```

Example:
```bash
OUTLOOK_CLIENT_ID=12345678-1234-1234-1234-123456789012
```

3. **Restart your API server** to load the new config

## Step 5: Connect Mailbox

1. Open the Lumi app in your browser
2. Go to **Admin** → **Settings**
3. Find the **Mailboxes** section
4. Click **Add mailbox**
5. Sign in with your Microsoft account when prompted
6. Grant permissions to the app

## How It Works

```
┌─────────────────────────────────────────────────────────────┐
│                    Microsoft Graph API                       │
│                                                             │
│   ┌──────────────┐         ┌──────────────────────────┐    │
│   │ Azure App    │         │ Your Personal Account     │    │
│   │ (registered) │────────▶│ (outlook.com, hotmail.com)│    │
│   └──────────────┘         └──────────────────────────┘    │
│         │                                                     │
│         │              ┌──────────────────────────┐         │
│         └─────────────▶│   Lumi Auto-Bid System   │         │
│                        │   - Receives emails      │         │
│                        │   - Extracts OTP codes   │         │
│                        └──────────────────────────┘         │
└─────────────────────────────────────────────────────────────┘
```

## One App, Multiple Mailboxes

**You register ONE Azure App** and can connect **UNLIMITED mailboxes**:

| What | How Many | Example |
|------|----------|---------|
| Azure App Registration | 1 | Your `OUTLOOK_CLIENT_ID` |
| Connected Mailboxes | Unlimited | user1@outlook.com, user2@hotmail.com, etc. |

## Troubleshooting

### "Allow public client flows" not found
- Make sure you're in the **Authentication** section
- Look under **Advanced settings**

### Permissions not granted
- Some permissions require admin consent
- Contact your organization's Entra admin if needed

### Server not connecting
- Make sure you restarted the API server after adding `OUTLOOK_CLIENT_ID`
- Check for typos in the Client ID

## What the System Does

✅ **Receives** emails from connected accounts
✅ **Extracts** OTP codes from Greenhouse
✅ **Stores** messages in database
✅ **Syncs** emails automatically

❌ **Does NOT send emails** (coming later)

## Future: Email Sending

Email sending will be added in a future update. This will use:
- `Mail.Send` permission (needs to be added)
- Microsoft Graph's `sendMail` endpoint
