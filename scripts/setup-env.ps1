# Azure DevOps MCP — First-time environment setup
# Run this once on any machine where you want to use the MCP server.
# All settings are saved permanently to your Windows user account.

Write-Host ""
Write-Host "Azure DevOps MCP — Environment Setup" -ForegroundColor Cyan
Write-Host "--------------------------------------"
Write-Host "Press Enter to accept the default value shown in [brackets]."
Write-Host ""

function Read-WithDefault {
    param([string]$Prompt, [string]$Default)
    $answer = Read-Host "$Prompt [$Default]"
    if ($answer -eq "") { return $Default }
    return $answer
}

# Prompt for each setting
$serverUrl  = Read-WithDefault "Azure DevOps Server URL" "https://azuredevops.yourcompany.local"
$collection = Read-WithDefault "Collection name"         "DefaultCollection"
$apiVersion = Read-WithDefault "API version"             "7.1"

Write-Host ""
Write-Host "Your PAT (Personal Access Token) — input is hidden." -ForegroundColor Yellow
Write-Host "Create one at: $serverUrl/$collection/_usersSettings/tokens"
Write-Host ""
$patSecure = Read-Host "PAT" -AsSecureString
$bstr      = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($patSecure)
$pat       = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr)
[Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr)

if ($pat.Trim().Length -eq 0) {
    Write-Host ""
    Write-Host "Error: PAT cannot be empty. Run the script again." -ForegroundColor Red
    exit 1
}

# Save permanently to the current user's Windows environment
[Environment]::SetEnvironmentVariable("ADO_SERVER_URL",               $serverUrl,  "User")
[Environment]::SetEnvironmentVariable("ADO_COLLECTION",               $collection, "User")
[Environment]::SetEnvironmentVariable("ADO_API_VERSION",              $apiVersion, "User")
[Environment]::SetEnvironmentVariable("ADO_PAT",                      $pat,        "User")
# Required because the corporate ADO server uses an internal CA not trusted by Node.js.
# Safe on a private internal network where you control both ends of the connection.
[Environment]::SetEnvironmentVariable("NODE_TLS_REJECT_UNAUTHORIZED", "0",         "User")

# Also apply to the current session so test-connection.ps1 works immediately
# without needing to open a new terminal.
$env:ADO_SERVER_URL               = $serverUrl
$env:ADO_COLLECTION               = $collection
$env:ADO_API_VERSION              = $apiVersion
$env:ADO_PAT                      = $pat
$env:NODE_TLS_REJECT_UNAUTHORIZED = "0"

Write-Host ""
Write-Host "All done! Settings saved permanently for your user account." -ForegroundColor Green
Write-Host ""
Write-Host "Next step — test the connection:"
Write-Host "  .\scripts\test-connection.ps1" -ForegroundColor White
Write-Host ""
