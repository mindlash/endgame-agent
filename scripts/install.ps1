#Requires -Version 5.1
<#
.SYNOPSIS
    EndGame Agent Installer — Windows

.DESCRIPTION
    One-liner install:
      irm https://endgame.cash/install.ps1 | iex

    What this does:
      1. Checks/installs Node.js 22 LTS
      2. Downloads pre-bundled release (verifies SHA-256)
      3. Extracts to ~/.endgame-agent/app/
      4. Runs interactive setup wizard
      5. Offers Credential Manager password storage
      6. Installs Task Scheduler service
      7. Starts the agent
      8. Creates CLI wrapper in PATH
#>

$ErrorActionPreference = "Stop"

$AgentHome = Join-Path $env:USERPROFILE ".endgame-agent"
$NodeVersion = "22.13.1"
$GitHubRepo = "endgame-agent/endgame-agent"

function Write-Info { param([string]$Message) Write-Host "[INFO] $Message" -ForegroundColor Green }
function Write-Warn { param([string]$Message) Write-Host "[WARN] $Message" -ForegroundColor Yellow }
function Write-Err { param([string]$Message) Write-Host "[ERROR] $Message" -ForegroundColor Red; exit 1 }

# ── Node.js ───────────────────────────────────────────────────────

function Test-NodeInstalled {
    try {
        $version = & node --version 2>$null
        if ($version) {
            $major = [int]($version -replace '^v' -split '\.')[0]
            if ($major -ge 20) {
                Write-Info "Node.js $version found"
                return $true
            }
            Write-Warn "Node.js $version found but v20+ required"
        }
    } catch {}
    return $false
}

function Install-NodeJS {
    $arch = if ([Environment]::Is64BitOperatingSystem) { "x64" } else { Write-Err "32-bit Windows not supported" }
    $nodeDir = Join-Path $AgentHome "node"
    $url = "https://nodejs.org/dist/v${NodeVersion}/node-v${NodeVersion}-win-${arch}.zip"
    $checksumUrl = "https://nodejs.org/dist/v${NodeVersion}/SHASUMS256.txt"

    Write-Info "Installing Node.js $NodeVersion..."
    New-Item -ItemType Directory -Path $nodeDir -Force | Out-Null

    $tmpFile = Join-Path $env:TEMP "node-install.zip"
    Invoke-WebRequest -Uri $url -OutFile $tmpFile -UseBasicParsing

    # Verify SHA-256
    $checksums = (Invoke-WebRequest -Uri $checksumUrl -UseBasicParsing).Content
    $expectedHash = ($checksums -split "`n" | Where-Object { $_ -match "node-v${NodeVersion}-win-${arch}.zip" } | ForEach-Object { ($_ -split '\s+')[0] })
    $actualHash = (Get-FileHash -Path $tmpFile -Algorithm SHA256).Hash.ToLower()

    if ($expectedHash -ne $actualHash) {
        Remove-Item $tmpFile -Force
        Write-Err "SHA-256 verification failed for Node.js download"
    }
    Write-Info "SHA-256 verified"

    # Extract
    $tmpDir = Join-Path $env:TEMP "node-extract"
    Expand-Archive -Path $tmpFile -DestinationPath $tmpDir -Force
    $extracted = Get-ChildItem $tmpDir | Select-Object -First 1
    Copy-Item -Path "$($extracted.FullName)\*" -Destination $nodeDir -Recurse -Force
    Remove-Item $tmpFile, $tmpDir -Recurse -Force

    $env:PATH = "$nodeDir;$env:PATH"
    Write-Info "Node.js installed to $nodeDir"
}

# ── Agent download ────────────────────────────────────────────────

function Install-Agent {
    $assetName = "endgame-agent-win32-x64.tar.gz"
    $checksumName = "$assetName.sha256"

    Write-Info "Fetching latest release..."
    $release = Invoke-RestMethod -Uri "https://api.github.com/repos/${GitHubRepo}/releases/latest" -UseBasicParsing

    $asset = $release.assets | Where-Object { $_.name -eq $assetName }
    if (-not $asset) {
        Write-Err "Could not find release asset: $assetName"
    }

    $checksumAsset = $release.assets | Where-Object { $_.name -eq $checksumName }

    $tmpFile = Join-Path $env:TEMP "endgame-agent.tar.gz"
    Write-Info "Downloading $assetName..."
    Invoke-WebRequest -Uri $asset.browser_download_url -OutFile $tmpFile -UseBasicParsing

    # Verify SHA-256
    if ($checksumAsset) {
        $expectedHash = ((Invoke-WebRequest -Uri $checksumAsset.browser_download_url -UseBasicParsing).Content -split '\s+')[0]
        $actualHash = (Get-FileHash -Path $tmpFile -Algorithm SHA256).Hash.ToLower()
        if ($expectedHash -ne $actualHash) {
            Remove-Item $tmpFile -Force
            Write-Err "SHA-256 verification failed for agent download"
        }
        Write-Info "SHA-256 verified"
    } else {
        Write-Warn "No checksum file found - skipping verification"
    }

    # Extract (tar is available on Windows 10+)
    $appDir = Join-Path $AgentHome "app"
    New-Item -ItemType Directory -Path $appDir -Force | Out-Null
    & tar -xzf $tmpFile -C $appDir
    Remove-Item $tmpFile -Force
    Write-Info "Agent extracted to $appDir"
}

# ── CLI wrapper ───────────────────────────────────────────────────

function Install-CliWrapper {
    $binDir = Join-Path $AgentHome "bin"
    New-Item -ItemType Directory -Path $binDir -Force | Out-Null

    $nodeExe = if (Test-Path (Join-Path $AgentHome "node\node.exe")) {
        Join-Path $AgentHome "node\node.exe"
    } else { "node" }

    $entryPoint = Join-Path $AgentHome "app\endgame-agent.js"

    # Create .cmd wrapper
    $cmdContent = @"
@echo off
set AGENT_HOME=$AgentHome
set NODE_ENV=production
"$nodeExe" "$entryPoint" %*
"@
    Set-Content -Path (Join-Path $binDir "endgame-agent.cmd") -Value $cmdContent

    # Add to user PATH
    $userPath = [Environment]::GetEnvironmentVariable("PATH", "User")
    if ($userPath -notlike "*$binDir*") {
        [Environment]::SetEnvironmentVariable("PATH", "$binDir;$userPath", "User")
        $env:PATH = "$binDir;$env:PATH"
        Write-Info "Added $binDir to user PATH"
    }

    Write-Info "CLI wrapper installed: endgame-agent"
}

# ── Main ──────────────────────────────────────────────────────────

function Main {
    Write-Host ""
    Write-Host "=================================" -ForegroundColor Cyan
    Write-Host "  EndGame Agent Installer" -ForegroundColor Cyan
    Write-Host "=================================" -ForegroundColor Cyan
    Write-Host ""

    # Create agent home
    @("app", "data", "config", "logs", "bin") | ForEach-Object {
        New-Item -ItemType Directory -Path (Join-Path $AgentHome $_) -Force | Out-Null
    }

    # 1. Node.js
    if (-not (Test-NodeInstalled)) {
        Install-NodeJS
    }

    # 2. Download agent
    Install-Agent

    # 3. Install CLI wrapper
    Install-CliWrapper

    # 4. Run setup wizard
    Write-Info "Starting setup wizard..."
    $env:AGENT_HOME = $AgentHome
    & endgame-agent setup

    # 5. Start service
    Write-Info "Starting agent service..."
    & endgame-agent start

    Write-Host ""
    Write-Host "=================================" -ForegroundColor Cyan
    Write-Host "  Installation Complete!" -ForegroundColor Cyan
    Write-Host "=================================" -ForegroundColor Cyan
    Write-Host ""
    Write-Host "Available commands:"
    Write-Host "  endgame-agent status     - check agent health"
    Write-Host "  endgame-agent logs       - view agent logs"
    Write-Host "  endgame-agent stop       - stop the agent"
    Write-Host "  endgame-agent start      - start the agent"
    Write-Host "  endgame-agent update     - update to latest version"
    Write-Host "  endgame-agent uninstall  - remove everything"
    Write-Host ""
    Write-Host "Open a new terminal if 'endgame-agent' is not found."
    Write-Host ""
}

Main
