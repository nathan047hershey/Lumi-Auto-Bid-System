$file = "d:\Projects\job-apply-master\job-apply-master\server\routes\admin.js"
$content = Get-Content $file -Raw

# Replace the literal "10" newlines with actual newlines
$content = $content -replace "`n", "`n"  # First ensure backtick-n is recognized
$content = $content -replace "10const", "`nconst"
$content = $content -replace "10let", "`nlet"
$content = $content -replace "10var", "`nvar"
$content = $content -replace "10function", "`nfunction"
$content = $content -replace "10router", "`nrouter"
$content = $content -replace "10module", "`nmodule"
$content = $content -replace "10if", "`nif"
$content = $content -replace "10try", "`ntry"
$content = $content -replace "10catch", "`ncatch"
$content = $content -replace "10  ", "`n  "
$content = $content -replace "10//", "`n//"

Set-Content -Path $file -Value $content -NoNewline
Write-Host "Fixed line breaks!"
