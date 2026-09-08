# Mail forward — what was set up automatically
#
# DONE on this machine:
# - Forward webhook enabled for admin (token in server/local.env)
# - Cloudflare quick tunnel running (MAIL_WEBHOOK_PUBLIC_BASE in server/.env)
# - Public POST ingest verified (OTP extracted)
# - No 60s Graph inbox polling
#
# YOU (once): wire Outlook → webhook in Power Automate
#   npm run mail:open-pa
#   or open https://make.powerautomate.com/ and create:
#     Trigger: When a new email arrives (V3) for the Outlook that gets Greenhouse codes
#     Action: HTTP POST to the webhook URL (see mail-forward-setup-result.json)
#     Body JSON: { "subject", "text", "from" }
#
# Keep running while bidding:
#   1) API on :9017
#   2) cloudflared tunnel (npm run mail:tunnel) — URL must match MAIL_WEBHOOK_PUBLIC_BASE
#   3) Power Automate flow ON
#
# Optional local IMAP bridge (if you create an Outlook app password):
#   OUTLOOK_IMAP_USER / OUTLOOK_IMAP_PASS in local.env
#   npm run mail:bridge
