$file = "d:\Projects\job-apply-master\job-apply-master\server\routes\admin.js"
$content = Get-Content $file -Raw

# Remove the extra comment lines and empty lines around the stats route
$pattern = '(?m)//   \?from=ISO&to=ISO.*?\n// Reuses the same period shape and the same workday hourly buckets as the\n// /api/user/stats endpoint, so the dashboard components can be shared.\n\nrouter\.get\(''\/stats'', requireAuth, requireAdmin, \(req, res\) => \{\n\n'

$replacement = '//   ?from=ISO&to=ISO       -> used when period=custom
// Reuses the same period shape and the same workday hourly buckets as the
// /api/user/stats endpoint, so the dashboard components can be shared.
router.get(''/stats'', requireAuth, requireAdmin, (req, res) => {

'

$content = $content -replace $pattern, $replacement

Set-Content -Path $file -Value $content -NoNewline
Write-Host "Fixed!"
