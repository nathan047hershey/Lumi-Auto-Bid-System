<#
.SYNOPSIS
  Creates a Power Automate-ready clipboard payload and opens the flow designer.
  Run this on your PC (where you're signed into Microsoft).
#>
$ErrorActionPreference = 'Stop'
$resultPath = Join-Path $PSScriptRoot 'mail-forward-setup-result.json'
if (-not (Test-Path $resultPath)) {
    Write-Host 'Run: node server/scripts/completeMailForwardSetup.js first'
    exit 1
}
$data = Get-Content $resultPath -Raw | ConvertFrom-Json
$url = $data.webhook_url
$body = @{
    subject = '@{triggerOutputs()?[''body/subject'']}'
    text = '@{triggerOutputs()?[''body/bodyPreview'']}'
    from = '@{triggerOutputs()?[''body/from'']}'
} | ConvertTo-Json

$guide = @"
Lumi email forward — finish in Power Automate (2 minutes)

1. Open: https://make.powerautomate.com/ and sign in with the Outlook that receives Greenhouse codes
2. Create → Automated cloud flow
3. Trigger: When a new email arrives (V3) — Outlook.com / Office 365 Outlook
4. Add action: HTTP → Method POST
5. URI (copied to clipboard):
$url
6. Headers: Content-Type = application/json
7. Body:
{ "subject": "@{triggerOutputs()?['body/subject']}", "text": "@{triggerOutputs()?['body/bodyPreview']}", "from": "@{triggerOutputs()?['body/from']}" }
8. Save & turn on. Send yourself a test mail with subject 'security code' and body 'code is 123456'.

Tunnel must be running (cloudflared) and API on :9017 while bidding.
"@

Set-Clipboard -Value $url
Write-Host $guide
Start-Process 'https://make.powerautomate.com/'
Write-Host "`nWebhook URL copied to clipboard."
