$file = "d:\Projects\job-apply-master\job-apply-master\server\routes\admin.js"
$lines = Get-Content $file
$newLines = @()
$foundIssue = $false
$issueLine = -1

for ($i = 0; $i -lt $lines.Count; $i++) {
    $line = $lines[$i]
    
    # Check if this is the first "Reuses" line
    if ($line -match '// /api/user/stats endpoint, so the dashboard components can be shared.' -and $foundIssue -eq $false) {
        $foundIssue = $true
        $issueLine = $i
    }
    
    # Skip duplicate lines after the first occurrence
    if ($foundIssue -and $issueLine -ne -1) {
        if ($i -eq $issueLine + 1 -and $lines[$i] -match '// /api/user/stats endpoint') {
            continue  # Skip this duplicate line
        }
    }
    
    $newLines += $line
}

$newLines | Set-Content $file -NoNewline
Write-Host "Fixed duplicate lines!"
