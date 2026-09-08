# Fix admin.js - replace literal `n with actual newlines
$filePath = "d:\Projects\job-apply-master\job-apply-master\server\routes\admin.js"
$content = Get-Content -Raw $filePath -Encoding UTF8

# Replace literal backtick-n with actual newlines
$fixed = $content -replace '`n', "`n"

# Write back without adding extra BOM
[System.IO.File]::WriteAllText($filePath, $fixed, [System.Text.UTF8Encoding]::new($false))

Write-Host "Fixed admin.js - replaced literal newlines with actual newlines"
