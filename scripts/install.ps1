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
      2. Copies source to an isolated build directory (~/.endgame-agent/build-tmp/)
      3. Builds with the local Node.js — never touches your system npm
      4. Deploys to ~/.endgame-agent/app/
      5. Cleans up the build directory
      6. Runs interactive setup wizard
      7. Offers Credential Manager password storage
      8. Installs Task Scheduler service
      9. Starts the agent
     10. Creates CLI wrapper in PATH

    Everything installs into ~/.endgame-agent/ — no system-wide changes
    except adding the CLI to your user PATH.
#>

$AgentHome = Join-Path $env:USERPROFILE ".endgame-agent"
$NodeVersion = "22.13.1"
$GitHubRepo = "mindlash/endgame-agent"

function Write-Info { param([string]$Message) Write-Host "[INFO] $Message" -ForegroundColor Green }
function Write-Warn { param([string]$Message) Write-Host "[WARN] $Message" -ForegroundColor Yellow }
function Write-Err  { param([string]$Message) Write-Host "[ERROR] $Message" -ForegroundColor Red; exit 1 }

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

# ── Resolve node/npm paths ────────────────────────────────────────

function Get-NodeExe {
    $local = Join-Path $AgentHome "node\node.exe"
    if (Test-Path $local) { return $local }
    $system = Get-Command node -ErrorAction SilentlyContinue
    if ($system) { return $system.Source }
    return $null
}

function Get-NpmCliJs {
    # The npm CLI entry point shipped with the Node.js zip
    $local = Join-Path $AgentHome "node\node_modules\npm\bin\npm-cli.js"
    if (Test-Path $local) { return $local }
    # Fallback: system npm location (Windows npm ships as a .cmd, but we want the .js)
    $npmCmd = Get-Command npm -ErrorAction SilentlyContinue
    if ($npmCmd) {
        # npm.cmd lives next to node.exe; the actual JS is in ../node_modules/npm/bin/npm-cli.js
        $npmDir = Split-Path $npmCmd.Source -Parent
        $cliJs = Join-Path $npmDir "node_modules\npm\bin\npm-cli.js"
        if (Test-Path $cliJs) { return $cliJs }
    }
    return $null
}

# Run npm via node.exe directly — avoids PowerShell's npm.ps1 wrapper
# which breaks with $ErrorActionPreference = "Stop" on stderr output.
# Uses & (call operator) instead of Start-Process so that child processes
# (like node-gyp-build) properly inherit the current $env:PATH.
function Invoke-Npm {
    param([string[]]$Arguments)
    $nodeExe = Get-NodeExe
    $npmCli = Get-NpmCliJs
    if (-not $nodeExe -or -not $npmCli) {
        Write-Err "Cannot find node.exe or npm-cli.js"
    }
    # Temporarily suppress stderr-as-error so npm "notice" output doesn't terminate
    $prevPref = $ErrorActionPreference
    $ErrorActionPreference = "SilentlyContinue"
    & $nodeExe $npmCli @Arguments
    $ErrorActionPreference = $prevPref
    if ($LASTEXITCODE -ne 0) {
        Write-Err "npm command failed with exit code ${LASTEXITCODE}: $Arguments"
    }
}

# ── Node.js ───────────────────────────────────────────────────────

function Test-NodeInstalled {
    $nodeExe = Get-NodeExe
    if ($nodeExe) {
        try {
            $version = & $nodeExe --version 2>$null
            if ($version) {
                $major = [int]($version -replace '^v' -split '\.')[0]
                if ($major -ge 20) {
                    Write-Info "Node.js $version found ($nodeExe)"
                    return $true
                }
                Write-Warn "Node.js $version found but v20+ required"
            }
        } catch {}
    }
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
    if (Test-Path $tmpDir) { Remove-Item $tmpDir -Recurse -Force }
    Expand-Archive -Path $tmpFile -DestinationPath $tmpDir -Force
    $extracted = Get-ChildItem $tmpDir | Select-Object -First 1
    Copy-Item -Path "$($extracted.FullName)\*" -Destination $nodeDir -Recurse -Force
    Remove-Item $tmpFile, $tmpDir -Recurse -Force

    # Add to PATH for this session
    $env:PATH = "$nodeDir;$env:PATH"
    Write-Info "Node.js installed to $nodeDir"
}

# ── Isolated local build ─────────────────────────────────────────
# Copies source to a temp directory inside AGENT_HOME, builds there
# using the local Node.js, then moves output to app/. The source
# directory is never modified.

function Install-AgentFromSource {
    param([string]$RepoRoot)

    $buildDir = Join-Path $AgentHome "build-tmp"
    $appDir   = Join-Path $AgentHome "app"

    # Clean previous build attempt
    if (Test-Path $buildDir) { Remove-Item $buildDir -Recurse -Force }

    Write-Info "Copying source to isolated build directory..."
    New-Item -ItemType Directory -Path $buildDir -Force | Out-Null

    # Copy source files (exclude .git, node_modules, dist to save time)
    $exclude = @(".git", "node_modules", "dist", ".agent-data")
    Get-ChildItem -Path $RepoRoot | Where-Object { $_.Name -notin $exclude } | ForEach-Object {
        if ($_.PSIsContainer) {
            Copy-Item -Path $_.FullName -Destination (Join-Path $buildDir $_.Name) -Recurse -Force
        } else {
            Copy-Item -Path $_.FullName -Destination $buildDir -Force
        }
    }
    Write-Info "Source copied to $buildDir"

    # npm install (using node.exe directly to avoid PowerShell npm.ps1 stderr issue)
    Write-Info "Installing dependencies (npm install)..."
    Push-Location $buildDir
    try {
        Invoke-Npm -Arguments @("install", "--ignore-scripts", "--no-audit", "--no-fund")
        Write-Info "Dependencies installed"

        # argon2 needs its native addon verified — run node-gyp-build directly
        # with the full path to node.exe (bypasses npm's script runner which
        # spawns cmd.exe and loses our custom PATH)
        Write-Info "Verifying native modules..."
        $nodeExe = Get-NodeExe
        $ngybJs = Join-Path $buildDir "node_modules\node-gyp-build\bin.js"
        $argon2Dir = Join-Path $buildDir "node_modules\argon2"
        if ((Test-Path $ngybJs) -and (Test-Path $argon2Dir)) {
            Push-Location $argon2Dir
            $prevPref = $ErrorActionPreference
            $ErrorActionPreference = "SilentlyContinue"
            & $nodeExe $ngybJs 2>$null
            $ErrorActionPreference = $prevPref
            Pop-Location
            if ($LASTEXITCODE -ne 0) {
                Write-Warn "argon2 native module verification failed (may still work with prebuilt binary)"
            } else {
                Write-Info "Native modules verified"
            }
        } else {
            Write-Warn "node-gyp-build not found, skipping native module verification"
        }

        # TypeScript build — use tsc from the build's own node_modules
        Write-Info "Compiling TypeScript..."
        $nodeExe = Get-NodeExe
        $tscBin = Join-Path $buildDir "node_modules\typescript\bin\tsc"
        if (-not (Test-Path $tscBin)) {
            $tscBin = Join-Path $buildDir "node_modules\.bin\tsc"
        }
        $prevPref = $ErrorActionPreference
        $ErrorActionPreference = "SilentlyContinue"
        & $nodeExe $tscBin
        $ErrorActionPreference = $prevPref
        if ($LASTEXITCODE -ne 0) {
            Write-Err "TypeScript compilation failed"
        }
        Write-Info "Build complete"
    } finally {
        Pop-Location
    }

    # Deploy to app/
    if (Test-Path $appDir) { Remove-Item $appDir -Recurse -Force }
    New-Item -ItemType Directory -Path $appDir -Force | Out-Null

    # Copy compiled output
    Copy-Item -Path (Join-Path $buildDir "dist\*") -Destination $appDir -Recurse -Force
    # Copy node_modules (needed at runtime for argon2, @solana/web3.js, etc.)
    Copy-Item -Path (Join-Path $buildDir "node_modules") -Destination $appDir -Recurse -Force
    # Copy package.json (needed for version detection)
    Copy-Item -Path (Join-Path $buildDir "package.json") -Destination $appDir -Force

    # Clean up build directory
    Remove-Item $buildDir -Recurse -Force
    Write-Info "Agent installed to $appDir (build directory cleaned up)"
}

# ── Remote source download + build ────────────────────────────────

function Install-AgentFromGitHub {
    $zipUrl = "https://github.com/${GitHubRepo}/archive/refs/heads/main.zip"
    $tmpZip = Join-Path $env:TEMP "endgame-agent-source.zip"
    $extractDir = Join-Path $env:TEMP "endgame-agent-extract"

    Write-Info "Downloading source from GitHub..."
    Invoke-WebRequest -Uri $zipUrl -OutFile $tmpZip -UseBasicParsing

    # Extract zip
    if (Test-Path $extractDir) { Remove-Item $extractDir -Recurse -Force }
    Expand-Archive -Path $tmpZip -DestinationPath $extractDir -Force
    Remove-Item $tmpZip -Force

    # Find the extracted repo folder (e.g., endgame-agent-main/)
    $innerDir = Get-ChildItem $extractDir | Select-Object -First 1
    if (-not $innerDir) { Write-Err "Extraction produced no files" }

    Write-Info "Source downloaded, building..."
    Install-AgentFromSource -RepoRoot $innerDir.FullName

    # Clean up extract directory
    Remove-Item $extractDir -Recurse -Force
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
    # Stop on real errors (file not found, network, etc.) but NOT on
    # native command stderr — that's handled per-command.
    $ErrorActionPreference = "Stop"

    Write-Host ""
    Write-Host "=================================" -ForegroundColor Cyan
    Write-Host "  EndGame Agent Installer" -ForegroundColor Cyan
    Write-Host "=================================" -ForegroundColor Cyan
    Write-Host ""
    Write-Host "  Everything installs to: $AgentHome" -ForegroundColor Gray
    Write-Host "  No system-wide changes (except user PATH)." -ForegroundColor Gray
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

    # 4. Run setup wizard (skip if already configured)
    $env:AGENT_HOME = $AgentHome
    $envFile = Join-Path $AgentHome "config\.env"
    if (Test-Path $envFile) {
        Write-Info "Existing config found — skipping setup wizard"
        Write-Info "Run 'endgame-agent setup' to reconfigure"
    } else {
        Write-Info "Starting setup wizard..."
        & endgame-agent setup
    }

    # 5. Start service (only if setup installed one)
    try {
        $taskQuery = schtasks /Query /TN "EndGameAgent" /FO CSV /NH 2>$null
        if ($taskQuery) {
            Write-Info "Starting agent service..."
            & endgame-agent start
        } else {
            Write-Info "No background service installed. Start manually with: endgame-agent run"
        }
    } catch {
        Write-Info "No background service installed. Start manually with: endgame-agent run"
    }

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
