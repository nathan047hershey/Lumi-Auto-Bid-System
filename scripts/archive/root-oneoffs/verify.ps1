$ErrorActionPreference = "Continue"
$content = Get-Content "d:\Projects\job-apply-master\job-apply-master\server\routes\admin.js" -Raw
Write-Host "File lines: $($content.Split("`n").Count)"
Write-Host "File size: $($content.Length) bytes"

try {
    $script = New-Object System.Management.Automation.Language.Parser
    $tokens = $null
    $parseErrors = $null
    $ast = [System.Management.Automation.Language.Parser]::ParseInput($content, [ref]$tokens, [ref]$parseErrors)
    
    if ($parseErrors.Count -eq 0) {
        Write-Host "PowerShell syntax: OK"
    } else {
        Write-Host "PowerShell errors: $($parseErrors.Count)"
        foreach ($e in $parseErrors) {
            Write-Host "  Line $($e.Extent.StartLineNumber): $($e.Message)"
        }
    }
} catch {
    Write-Host "PowerShell check error: $_"
}

# Try Node.js syntax check
Write-Host "Checking Node.js syntax..."
$nodeCheck = & node -e "try { require('vm').createScript(require('fs').readFileSync('d:/Projects/job-apply-master/job-apply-master/server/routes/admin.js','utf8')); console.log('Node.js syntax: OK'); } catch(e) { console.error('Node.js error:', e.message); process.exit(1); }" 2>&1
Write-Host $nodeCheck
