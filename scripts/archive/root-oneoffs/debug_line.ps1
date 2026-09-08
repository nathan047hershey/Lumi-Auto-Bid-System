$f = 'd:\Projects\job-apply-master\job-apply-master\server\routes\admin.js'
$b = [System.IO.File]::ReadAllBytes($f)

# Read lines manually
$text = [System.Text.Encoding]::UTF8.GetString($b)
$lines = $text -split "`n"

Write-Host "Total lines: $($lines.Count)"

# Show lines 8-15 with their content
for($i = 8; $i -lt 15; $i++) {
    $line = $lines[$i]
    Write-Host "Line $($i+1): '$line'"
    Write-Host "  Length: $($line.Length)"
    Write-Host "  First 30 chars bytes:"
    for($j = 0; $j -lt [Math]::Min(30, $line.Length); $j++) {
        Write-Host "    $j`: $(('{0:X2}' -f [int]$line[$j])) ($($line[$j]))"
    }
    Write-Host ""
}
