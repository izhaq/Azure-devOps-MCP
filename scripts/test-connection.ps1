# Azure DevOps MCP — Connection smoke test
# Run this after setup-env.ps1 to confirm the MCP server can reach Azure DevOps.

Write-Host ""
Write-Host "Azure DevOps MCP — Connection Test" -ForegroundColor Cyan
Write-Host "------------------------------------"

# Find dist/index.js relative to this script (works from any working directory)
$serverPath = Join-Path $PSScriptRoot "..\dist\index.js"

# Pre-flight checks
$ok = $true

if (-not (Test-Path $serverPath)) {
    Write-Host "FAIL  dist/index.js not found at: $serverPath" -ForegroundColor Red
    Write-Host "      Make sure you cloned the full repository (including the dist folder)."
    $ok = $false
}

if (-not $env:ADO_SERVER_URL) {
    Write-Host "FAIL  ADO_SERVER_URL is not set." -ForegroundColor Red
    Write-Host "      Run .\scripts\setup-env.ps1 first."
    $ok = $false
}

if (-not $env:ADO_PAT) {
    Write-Host "FAIL  ADO_PAT is not set." -ForegroundColor Red
    Write-Host "      Run .\scripts\setup-env.ps1 first (or open a new terminal if you just ran it)."
    $ok = $false
}

if (-not $ok) { Write-Host ""; exit 1 }

Write-Host "  Server URL : $env:ADO_SERVER_URL"
Write-Host "  Collection : $env:ADO_COLLECTION"
Write-Host "  API version: $env:ADO_API_VERSION"
Write-Host "  PAT        : $("*" * 8) (hidden)"
Write-Host ""
Write-Host "Sending test request..." -ForegroundColor Yellow

$payload = @(
    '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"smoke","version":"1.0"}}}'
    '{"jsonrpc":"2.0","method":"notifications/initialized"}'
    '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"core_list_projects","arguments":{}}}'
) -join "`n"

$raw = $payload | node $serverPath --stdio 2>$null | Where-Object { $_ -match '"id":2' }

if (-not $raw) {
    Write-Host ""
    Write-Host "FAIL  No response received." -ForegroundColor Red
    Write-Host "      Check that this machine can reach $env:ADO_SERVER_URL"
    Write-Host "      (try opening that URL in a browser)"
    Write-Host ""
    exit 1
}

if ($raw -match '"error"') {
    Write-Host ""
    Write-Host "FAIL  The server responded with an error:" -ForegroundColor Red
    try {
        $err = ($raw | ConvertFrom-Json).error
        Write-Host "      Code   : $($err.code)"
        Write-Host "      Message: $($err.message)"
    } catch {
        Write-Host "      $raw"
    }
    Write-Host ""
    Write-Host "If the message says 'Unauthorized' — your PAT has expired or has"
    Write-Host "insufficient permissions. Create a new one and re-run setup-env.ps1."
    Write-Host ""
    exit 1
}

# Success — print the project list
Write-Host ""
Write-Host "SUCCESS  Connected to Azure DevOps!" -ForegroundColor Green
Write-Host ""
Write-Host "Projects in '$env:ADO_COLLECTION':"
try {
    $text     = ($raw | ConvertFrom-Json).result.content[0].text
    $projects = $text | ConvertFrom-Json
    foreach ($p in $projects) {
        Write-Host "  - $($p.name)"
    }
} catch {
    # Fallback: print raw JSON if parsing fails
    Write-Host $raw
}

Write-Host ""
Write-Host "Next step — configure your AI tool to use this MCP server."
Write-Host "See: docs\setup-airgapped-tabnine.md (Step 7)"
Write-Host ""
