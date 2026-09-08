$f = 'd:\Projects\job-apply-master\job-apply-master\server\routes\admin.js'
$b = [System.IO.File]::ReadAllBytes($f)
Write-Host "Checking bytes 440-500:"
for($i = 440; $i -lt 500; $i++) {
    $hex = '{0:X2}' -f $b[$i]
    $char = if ($b[$i] -ge 32 -and $b[$i] -lt 127) { [char]$b[$i] } else { '.' }
    Write-Host "$i`: $hex ($char)"
}
