# Shared helpers for installing/updating the pi-client foundation package.
# Source of truth: this git clone (its "origin" remote, or the local path as fallback).
$ErrorActionPreference = "Stop"

function Get-PiClientRepoRoot {
    return (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
}

function Get-GitRemotePiClientOrigin {
    $repoRoot = Get-PiClientRepoRoot
    Push-Location $repoRoot
    try {
        $prevEap = $ErrorActionPreference
        $ErrorActionPreference = "SilentlyContinue"
        try {
            foreach ($remote in @("origin")) {
                $url = (git remote get-url $remote 2>$null | Out-String).Trim()
                if ($url) { return $url }
            }
            $remotes = @(git remote 2>$null)
            foreach ($remote in $remotes) {
                $url = (git remote get-url $remote 2>$null | Out-String).Trim()
                if ($url -and $url -match 'pi-client') { return $url }
            }
        } finally {
            $ErrorActionPreference = $prevEap
        }
        return $null
    } finally {
        Pop-Location
    }
}

function Get-PiClientInstallSources {
    $sources = @()

    # Prefer the same URL git pull uses for this clone; fall back to the local path.
    $origin = Get-GitRemotePiClientOrigin
    if ($origin) { $sources += $origin }

    $repoRoot = Get-PiClientRepoRoot
    if ($repoRoot -notin $sources) { $sources += $repoRoot }

    return $sources
}

function Get-PiAgentDir {
    return Join-Path $env:USERPROFILE ".pi\agent"
}

function Get-PiSettingsPath {
    return Join-Path (Get-PiAgentDir) "settings.json"
}

function Read-PiSettings {
    $path = Get-PiSettingsPath
    if (-not (Test-Path $path)) {
        return [ordered]@{ packages = @() }
    }
    return (Get-Content $path -Raw | ConvertFrom-Json)
}

function Write-PiSettings {
    param([object]$Settings)
    $path = Get-PiSettingsPath
    $dir = Split-Path -Parent $path
    if (-not (Test-Path $dir)) {
        New-Item -ItemType Directory -Path $dir -Force | Out-Null
    }
    $json = $Settings | ConvertTo-Json -Depth 20
    $utf8NoBom = New-Object System.Text.UTF8Encoding $false
    [System.IO.File]::WriteAllText($path, $json, $utf8NoBom)
}

function Get-PiPackageSource {
    param([object]$Entry)
    if ($Entry -is [string]) { return $Entry }
    if ($Entry.source) { return [string]$Entry.source }
    return $null
}

function Test-PiClientPackageSource {
    param([string]$Source)
    if (-not $Source) { return $false }
    if ($Source -match 'pi-client') { return $true }
    # Also recognize this clone's own sources (works even if the repo was renamed).
    foreach ($known in (Get-PiClientInstallSources)) {
        if ($Source -eq $known) { return $true }
    }
    return $false
}

function Get-InstalledPiClientSource {
    $settings = Read-PiSettings
    foreach ($entry in @($settings.packages)) {
        $source = Get-PiPackageSource $entry
        if (Test-PiClientPackageSource $source) {
            return $source
        }
    }
    return $null
}

function Write-PiCliLine {
    param([object]$Line)
    if ($null -eq $Line) { return }
    if ($Line -is [System.Management.Automation.ErrorRecord]) {
        # Git progress (clone/fetch) arrives on stderr - print as plain text, not a PS error.
        $text = if ($Line.Exception.Message) { $Line.Exception.Message } else { $Line.ToString() }
        if ($text) { Write-Host $text }
        return
    }
    $text = [string]$Line
    if ($text.Length -gt 0) { Write-Host $text }
}

function Invoke-PiCli {
    param(
        [Parameter(Mandatory)][string[]]$ArgumentList,
        [switch]$Quiet
    )
    $prevEap = $ErrorActionPreference
    $ErrorActionPreference = "SilentlyContinue"
    try {
        $output = & pi @ArgumentList 2>&1
    } finally {
        $ErrorActionPreference = $prevEap
    }
    if (-not $Quiet) {
        foreach ($line in @($output)) {
            Write-PiCliLine $line
        }
    }
    return $LASTEXITCODE
}

function Invoke-GitCli {
    param(
        [Parameter(Mandatory)][string[]]$ArgumentList,
        [switch]$Quiet
    )
    $prevEap = $ErrorActionPreference
    $ErrorActionPreference = "SilentlyContinue"
    try {
        $output = & git @ArgumentList 2>&1
    } finally {
        $ErrorActionPreference = $prevEap
    }
    if (-not $Quiet) {
        foreach ($line in @($output)) {
            Write-PiCliLine $line
        }
    }
    return $LASTEXITCODE
}

function Update-PiClientRepoClone {
    $repoRoot = Get-PiClientRepoRoot
    if (-not (Test-Path (Join-Path $repoRoot ".git"))) {
        Write-Host "Not a git clone - skipping git pull." -ForegroundColor Yellow
        return
    }

    Write-Host "Pulling latest pi-client scripts..." -ForegroundColor Cyan
    Push-Location $repoRoot
    try {
        $exitCode = Invoke-GitCli -ArgumentList @("pull", "--ff-only")
        if ($exitCode -ne 0) {
            throw "git pull failed (exit $exitCode). Fix the clone, then run this script again."
        }
    } finally {
        Pop-Location
    }
}

function Invoke-PiPackageInstall {
    param([string]$Source)

    Write-Host "  $Source" -ForegroundColor Gray
    Invoke-PiCli -ArgumentList @("install", $Source) | Out-Null
}

function Remove-PiClientPackages {
    $settings = Read-PiSettings
    $packages = @($settings.packages)
    if ($packages.Count -eq 0) { return 0 }

    $removed = 0
    foreach ($entry in $packages) {
        $source = Get-PiPackageSource $entry
        if (-not (Test-PiClientPackageSource $source)) { continue }
        Write-Host "Removing old pi-client entry: $source" -ForegroundColor Gray
        $exitCode = Invoke-PiCli -ArgumentList @("remove", $source) -Quiet
        if ($exitCode -ne 0) {
            Write-Host "  (pi remove failed; will clean settings manually)" -ForegroundColor DarkYellow
        } else {
            $removed++
        }
    }

    # Manual cleanup if pi remove missed duplicates or failed
    $settings = Read-PiSettings
    $kept = @()
    foreach ($entry in @($settings.packages)) {
        $source = Get-PiPackageSource $entry
        if (Test-PiClientPackageSource $source) { continue }
        $kept += $entry
    }
    if (@($settings.packages).Count -ne $kept.Count) {
        $settings.packages = $kept
        Write-PiSettings $settings
    }

    return $removed
}

function Install-PiClientPackage {
    param(
        [switch]$UpdateOnly
    )

    $installSources = Get-PiClientInstallSources
    $installedSource = Get-InstalledPiClientSource

    if ($installedSource) {
        if ($UpdateOnly) {
            Write-Host "Updating pi-client..." -ForegroundColor Cyan
            Write-Host "  $installedSource" -ForegroundColor Gray
            Invoke-PiCli -ArgumentList @("update", $installedSource) | Out-Null
            if (-not (Get-InstalledPiClientSource)) {
                throw "pi update completed but pi-client is not registered. Run install-on-client.bat again."
            }
        }
        return $installedSource
    }

    if ($UpdateOnly) {
        throw "pi-client is not registered in Pi. Run install-on-client.bat first."
    }

    Remove-PiClientPackages | Out-Null

    Write-Host "Installing pi-client package..." -ForegroundColor Cyan
    foreach ($source in $installSources) {
        Invoke-PiPackageInstall -Source $source
        $installedSource = Get-InstalledPiClientSource
        if ($installedSource) {
            Write-Host "Registered in Pi as: $installedSource" -ForegroundColor Green
            return $installedSource
        }
        if ($installSources.Count -gt 1) {
            Write-Host "That source did not register a package; trying the next one..." -ForegroundColor Yellow
        }
    }

    $fallback = ($installSources | Select-Object -First 1)
    throw @"
pi install did not register pi-client in ~/.pi/agent/settings.json.
Run manually and check for errors:
  pi install $fallback
"@
}

function Confirm-PiClientInstall {
    $source = Get-InstalledPiClientSource
    if (-not $source) {
        throw "pi-client is not registered. pi list would show no packages."
    }
    Write-Host "Verified: pi-client registered in Pi settings." -ForegroundColor Green
    Write-Host "  $source" -ForegroundColor Gray
    return $source
}

function Show-PiClientInstallSummary {
    $installedSource = Confirm-PiClientInstall

    Write-Host ""
    Write-Host "pi-client is up to date." -ForegroundColor Green
    Write-Host "Source: $installedSource" -ForegroundColor Gray

    $modelsDest = Join-Path (Get-PiAgentDir) "models.json"
    if (Test-Path $modelsDest) {
        try {
            $modelsJson = Get-Content $modelsDest -Raw | ConvertFrom-Json
            $providerNames = @($modelsJson.providers.PSObject.Properties.Name)
            if ($providerNames.Count -gt 0) {
                $first = $modelsJson.providers.($providerNames[0])
                Write-Host "Inference: $($first.baseUrl)" -ForegroundColor Gray
                Write-Host "Providers: $($providerNames -join ', ')" -ForegroundColor Gray
            }
        } catch {
            Write-Host "Warning: ~/.pi/agent/models.json could not be parsed." -ForegroundColor Yellow
        }
    }

    Write-Host ""
    Confirm-PlaywrightOnClient | Out-Null
    Show-ResearchKeyHint
    Write-Host ""
    Write-Host "Restart Pi if it was already running." -ForegroundColor Cyan
    Write-Host "Point ~/.pi/agent/models.json baseUrl at your OpenAI-compatible server (llama.cpp, LM Studio, Ollama, vLLM...)." -ForegroundColor Yellow
    return $installedSource
}

function Get-PiResearchConfigPath {
    return Join-Path $env:USERPROFILE ".pi\research.config.json"
}

function Test-ResearchApiKeyConfigured {
    if ($env:BRAVE_API_KEY -and $env:BRAVE_API_KEY.Trim()) { return $true }
    $path = Get-PiResearchConfigPath
    if (-not (Test-Path $path)) { return $false }
    try {
        $json = Get-Content $path -Raw | ConvertFrom-Json
        return [bool]($json.apiKey -and [string]$json.apiKey.Trim())
    } catch {
        return $false
    }
}

function Show-ResearchKeyHint {
    if (Test-ResearchApiKeyConfigured) {
        Write-Host "Web research: Brave API key configured." -ForegroundColor Green
        return
    }
    Write-Host "Web research: no Brave API key yet (optional)." -ForegroundColor Yellow
    Write-Host "  In Pi: /research setup   then   /research key YOUR_KEY" -ForegroundColor Gray
    Write-Host "  https://api-dashboard.search.brave.com/register" -ForegroundColor Gray
}

# One command: register if needed + pi update --extensions.
# (git pull runs in install-on-client.ps1 BEFORE this library is loaded.)
function Sync-PiClientOnClient {
    Ensure-NodeAndNpm
    Ensure-NpmGlobalBinOnUserPath
    Ensure-PiCli
    Ensure-NpmGlobalBinOnUserPath
    Ensure-PlaywrightOnClient
    Install-PiClientBootstrapModels
    $null = Install-PiClientPackage

    Write-Host "Updating Pi foundation extensions..." -ForegroundColor Cyan
    $exitCode = Invoke-PiCli -ArgumentList @("update", "--extensions")
    if ($exitCode -ne 0) {
        throw "pi update --extensions failed (exit $exitCode)"
    }

    Show-PiClientInstallSummary
}

function Install-PiClientBootstrapModels {
    $repoRoot = Get-PiClientRepoRoot
    $modelsSrc = Join-Path $repoRoot "bootstrap\models.json"
    $defaultsSrc = Join-Path $repoRoot "bootstrap\settings.defaults.json"
    $piAgentDir = Get-PiAgentDir

    if (-not (Test-Path $modelsSrc)) {
        throw "Missing $modelsSrc"
    }

    if (-not (Test-Path $piAgentDir)) {
        New-Item -ItemType Directory -Path $piAgentDir -Force | Out-Null
    }

    # Never clobber an existing models.json - it is the user's own provider setup.
    $modelsDest = Join-Path $piAgentDir "models.json"
    if (Test-Path $modelsDest) {
        Write-Host "Keeping existing ~/.pi/agent/models.json (template: bootstrap/models.json)." -ForegroundColor Gray
    } else {
        Copy-Item $modelsSrc $modelsDest -Force
        Write-Host "Created ~/.pi/agent/models.json from bootstrap template - edit baseUrl/model ids for your server." -ForegroundColor Yellow
    }

    $settings = Read-PiSettings
    # Only seed defaults when the user has not picked a provider/model yet.
    if (Test-Path $defaultsSrc) {
        $defaults = Get-Content $defaultsSrc -Raw | ConvertFrom-Json
        if ($defaults.defaultProvider -and -not $settings.defaultProvider) {
            $settings | Add-Member -NotePropertyName defaultProvider -NotePropertyValue $defaults.defaultProvider -Force
        }
        if ($defaults.defaultModel -and -not $settings.defaultModel) {
            $settings | Add-Member -NotePropertyName defaultModel -NotePropertyValue $defaults.defaultModel -Force
        }
    }
    if (-not $settings.PSObject.Properties.Match("packages").Count) {
        $settings | Add-Member -NotePropertyName packages -NotePropertyValue @() -Force
    }
    Write-PiSettings $settings
}

function Ensure-PiCli {
    Add-NpmGlobalBinToPath
    $piCmd = Get-Command pi -ErrorAction SilentlyContinue
    if ($piCmd) { return }
    Write-Host "Installing Pi coding agent..." -ForegroundColor Yellow
    npm install -g @earendil-works/pi-coding-agent
    if ($LASTEXITCODE -ne 0) {
        throw "npm install -g @earendil-works/pi-coding-agent failed. Install Node.js LTS, then run install-on-client.bat again."
    }
    Add-NpmGlobalBinToPath
}

function Ensure-NodeAndNpm {
    if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
        throw "Node.js is required but not on PATH. Install Node.js LTS, then run install-on-client.bat again."
    }
    if (-not (Get-Command npm -ErrorAction SilentlyContinue)) {
        throw "npm is required but not on PATH. Install Node.js LTS, then run install-on-client.bat again."
    }
}

function Get-NpmGlobalBin {
    $npmBin = (npm prefix -g 2>$null | Out-String).Trim()
    if (-not $npmBin) { return $null }
    return $npmBin
}

function Add-NpmGlobalBinToPath {
    $npmBin = Get-NpmGlobalBin
    if (-not $npmBin) { return }
    $segments = @($env:PATH -split ';' | Where-Object { $_ })
    if ($segments -notcontains $npmBin) {
        $env:PATH = "$npmBin;$env:PATH"
    }
}

function Ensure-NpmGlobalBinOnUserPath {
    $npmBin = Get-NpmGlobalBin
    if (-not $npmBin) { return }

    Add-NpmGlobalBinToPath

    $userPath = [Environment]::GetEnvironmentVariable("Path", "User")
    $segments = @($userPath -split ';' | Where-Object { $_ })
    if ($segments -notcontains $npmBin) {
        $newPath = if ($userPath) { "$npmBin;$userPath" } else { $npmBin }
        [Environment]::SetEnvironmentVariable("Path", $newPath, "User")
        Write-Host "Added npm global bin to user PATH: $npmBin" -ForegroundColor Gray
    }
}

function Resolve-PlaywrightCli {
    Add-NpmGlobalBinToPath

    $cmd = Get-Command playwright -ErrorAction SilentlyContinue
    if ($cmd) { return $cmd.Source }

    $npmBin = Get-NpmGlobalBin
    if (-not $npmBin) { return $null }

    foreach ($name in @("playwright.cmd", "playwright.ps1", "playwright")) {
        $candidate = Join-Path $npmBin $name
        if (Test-Path $candidate) { return $candidate }
    }
    return $null
}

function Invoke-PlaywrightCli {
    param(
        [Parameter(Mandatory)][string[]]$ArgumentList,
        [switch]$Quiet
    )

    $cli = Resolve-PlaywrightCli
    if (-not $cli) { return 1 }

    $prevEap = $ErrorActionPreference
    $ErrorActionPreference = "SilentlyContinue"
    try {
        $output = & $cli @ArgumentList 2>&1
        if (-not $Quiet) {
            foreach ($line in @($output)) {
                if ($line -is [string] -and $line) { Write-Host $line }
            }
        }
    } finally {
        $ErrorActionPreference = $prevEap
    }
    return $LASTEXITCODE
}

function Confirm-PlaywrightOnClient {
    $cli = Resolve-PlaywrightCli
    if (-not $cli) {
        Write-Host "Warning: Playwright not found — web acceptance scenarios will be skipped." -ForegroundColor Yellow
        Write-Host "  Re-run install-on-client.bat or: npm install -g @playwright/test" -ForegroundColor Gray
        return $false
    }

    $prevEap = $ErrorActionPreference
    $ErrorActionPreference = "SilentlyContinue"
    $version = & $cli --version 2>&1
    $exitCode = $LASTEXITCODE
    $ErrorActionPreference = $prevEap
    if ($exitCode -ne 0) {
        Write-Host "Warning: Playwright CLI failed — web acceptance scenarios will be skipped." -ForegroundColor Yellow
        return $false
    }

    $versionText = @($version | ForEach-Object { "$_" } | Where-Object { $_.Trim() } | Select-Object -First 1)
    if (-not $versionText) { $versionText = "installed" }
    Write-Host "Verified: Playwright ready ($versionText)." -ForegroundColor Green
    return $true
}

function Ensure-PlaywrightOnClient {
    Add-NpmGlobalBinToPath

    if (-not (Resolve-PlaywrightCli)) {
        Write-Host "Installing Playwright globally (acceptance scenarios)..." -ForegroundColor Yellow
        npm install -g @playwright/test
        if ($LASTEXITCODE -ne 0) {
            Write-Host "Warning: npm install -g @playwright/test failed. Web scenarios need this on the client PC." -ForegroundColor Yellow
            return
        }
        Ensure-NpmGlobalBinOnUserPath
        if (-not (Resolve-PlaywrightCli)) {
            Write-Host "Warning: Playwright CLI not found after install. Open a new terminal and run install-on-client.bat again." -ForegroundColor Yellow
            return
        }
    }

    Write-Host "Ensuring Playwright browsers..." -ForegroundColor Cyan
    $exitCode = Invoke-PlaywrightCli -ArgumentList @("install")
    if ($exitCode -ne 0) {
        Write-Host "Warning: playwright install failed. Re-run install-on-client.bat or: playwright install" -ForegroundColor Yellow
        return
    }

    Write-Host "Playwright browsers ready." -ForegroundColor Green
}
