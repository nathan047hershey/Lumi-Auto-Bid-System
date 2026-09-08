$f = 'd:\Projects\job-apply-master\job-apply-master\server\routes\admin.js'
$b = [System.IO.File]::ReadAllBytes($f)

# Find position of "const router"
$text = [System.Text.Encoding]::UTF8.GetString($b)
$pos = $text.IndexOf("const router")
Write-Host "Found 'const router' at position: $pos"

# Check 100 bytes before
$start = [Math]::Max(0, $pos - 100)
Write-Host "`nBytes $start to $($pos + 20):"
for($i = $start; $i -lt ($pos + 20); $i++) {
    $hex = '{0:X2}' -f $b[$i]
    $char = if ($b[$i] -ge 32 -and $b[$i] -lt 127) { [char]$b[$i] } else { '.' }
    Write-Host "$i`: $hex ($char)"
}
