$f = 'd:\Projects\job-apply-master\job-apply-master\server\routes\admin.js'
$b = [System.IO.File]::ReadAllBytes($f)

# Find position of first occurrence of "router" text
$text = [System.Text.Encoding]::UTF8.GetString($b)
$pos = $text.IndexOf("const router")
Write-Host "Found 'const router' at position: $pos"

# Check the 50 bytes before
Write-Host "`nBytes 380-430:"
for($i = 380; $i -lt 430; $i++) {
    $hex = '{0:X2}' -f $b[$i]
    $char = if ($b[$i] -ge 32 -and $b[$i] -lt 127) { [char]$b[$i] } else { '.' }
    Write-Host "$i`: $hex ($char)"
}
