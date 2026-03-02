#Requires -Version 5.1
<#
.SYNOPSIS
    EndGame Agent Installer — Windows

.DESCRIPTION
    Install from local source (recommended):
      1. Download the zip from GitHub and extract it
      2. Right-click Install.bat -> "Run as administrator"

    Or install remotely:
      irm https://raw.githubusercontent.com/mindlash/endgame-agent/main/scripts/install.ps1 | iex

    What this does:
      1. Checks/installs Node.js 22 LTS (needs internet if Node.js missing)
      2. Builds the agent from local source OR downloads a pre-bundled release
      3. Deploys to ~/.endgame-agent/
      4. Runs interactive setup wizard
      5. Offers Credential Manager password storage
      6. Installs Task Scheduler service
      7. Starts the agent
      8. Creates CLI wrapper in PATH
#>

$ErrorActionPreference = "Stop"

$AgentHome = Join-Path $env:USERPROFILE ".endgame-agent"
$NodeVersion = "22.13.1"
$GitHubRepo = "mindlash/endgame-agent"

function Write-Info { param([string]$Message) Write-Host "[INFO] $Message" -ForegroundColor Green }
function Write-Warn { param([string]$Message) Write-Host "[WARN] $Message" -ForegroundColor Yellow }
function Write-Err { param([string]$Message) Write-Host "[ERROR] $Message" -ForegroundColor Red; exit 1 }

# ── Detect local source repo ─────────────────────────────────────

function Find-LocalRepo {
    # Check if we're running from inside the repo (zip extract or git clone)
    $scriptDir = if ($PSScriptRoot) { $PSScriptRoot } else { $PWD.Path }
    $repoRoot = Split-Path $scriptDir -Parent

    # Look for package.json with our package name
    $pkgJson = Join-Path $repoRoot "package.json"
    if (Test-Path $pkgJson) {
        $pkg = Get-Content $pkgJson -Raw | ConvertFrom-Json
        if ($pkg.name -eq "endgame-agent") {
            return $repoRoot
        }
    }
    return $null
}

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

    Write-Info "Installing Node.js $NodeVersion (requires internet)..."
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

# ── Local build ───────────────────────────────────────────────────

function Install-AgentFromSource {
    param([string]$RepoRoot)

    Write-Info "Building from local source: $RepoRoot"

    # npm install
    Write-Info "Installing dependencies (npm install)..."
    Push-Location $RepoRoot
    try {
        & npm install --ignore-scripts 2>&1 | Out-Null
        # argon2 needs a separate rebuild for its native addon
        & npm rebuild argon2 2>&1 | Out-Null
        Write-Info "Dependencies installed"

        # TypeScript build
        Write-Info "Compiling TypeScript..."
        & npx tsc 2>&1 | Out-Null
        Write-Info "Build complete"
    } finally {
        Pop-Location
    }

    # Copy dist/ to AGENT_HOME/app/
    $appDir = Join-Path $AgentHome "app"
    New-Item -ItemType Directory -Path $appDir -Force | Out-Null

    # Copy compiled output
    Copy-Item -Path (Join-Path $RepoRoot "dist\*") -Destination $appDir -Recurse -Force
    # Copy node_modules (needed at runtime for argon2, @solana/web3.js, etc.)
    Copy-Item -Path (Join-Path $RepoRoot "node_modules") -Destination $appDir -Recurse -Force
    # Copy package.json (needed for version detection)
    Copy-Item -Path (Join-Path $RepoRoot "package.json") -Destination $appDir -Force

    Write-Info "Agent installed to $appDir"
}

# ── Remote download (fallback) ────────────────────────────────────

function Install-AgentFromGitHub {
    $assetName = "endgame-agent-win32-x64.tar.gz"
    $checksumName = "$assetName.sha256"

    Write-Info "Fetching latest release from GitHub..."
    $release = Invoke-RestMethod -Uri "https://api.github.com/repos/${GitHubRepo}/releases/latest" -UseBasicParsing

    $asset = $release.assets | Where-Object { $_.name -eq $assetName }
    if (-not $asset) {
        Write-Err "Could not find release asset: $assetName. Available: $($release.assets.name -join ', ')"
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

    # Entry point: cli.js in the app dir
    $entryPoint = Join-Path $AgentHome "app\cli.js"

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

    # Create agent home directories
    @("app", "data", "config", "logs", "bin") | ForEach-Object {
        New-Item -ItemType Directory -Path (Join-Path $AgentHome $_) -Force | Out-Null
    }

    # 1. Node.js
    if (-not (Test-NodeInstalled)) {
        Install-NodeJS
    }

    # 2. Install agent — local source if available, GitHub release otherwise
    $localRepo = Find-LocalRepo
    if ($localRepo) {
        Write-Info "Local source detected at $localRepo"
        Install-AgentFromSource -RepoRoot $localRepo
    } else {
        Write-Info "No local source found, downloading from GitHub..."
        Install-AgentFromGitHub
    }

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
