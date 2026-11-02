# Windows desktop entrypoint. Keep the server attached to its console so that
# Ctrl+C / closing that window stops this launch without a hidden background service.
[CmdletBinding()]
param(
    [switch] $Check,
    [switch] $NoBrowser
)

$ErrorActionPreference = 'Stop'
$OutputEncoding = [Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding = $OutputEncoding
$projectRoot = Split-Path -Parent $PSScriptRoot
$ownsMutex = $false
$mutex = $null
$locationPushed = $false

function Test-SillyTavern([string] $BaseUrl) {
    $response = $null
    $reader = $null
    try {
        $request = [Net.HttpWebRequest]::Create($BaseUrl + 'version')
        $request.Proxy = $null
        $request.AllowAutoRedirect = $false
        $request.Timeout = 1500
        $request.ReadWriteTimeout = 1500
        $response = $request.GetResponse()
        $reader = [IO.StreamReader]::new($response.GetResponseStream())
        $version = $reader.ReadToEnd() | ConvertFrom-Json
        return ([string] $version.agent).StartsWith('SillyTavern:')
    }
    catch { return $false }
    finally {
        if ($reader) { $reader.Dispose() }
        if ($response) { $response.Dispose() }
    }
}

function Test-Port([string] $Hostname, [int] $Port) {
    $client = [Net.Sockets.TcpClient]::new()
    try {
        $task = $client.ConnectAsync($Hostname, $Port)
        return ($task.Wait(1500) -and $client.Connected)
    }
    catch { return $false }
    finally { $client.Dispose() }
}

function Open-ExistingSession([string] $Url) {
    Write-Host "[SillyTavern] Already running. Reusing $Url"
    if (-not $NoBrowser) {
        # The browser is the interactive application requested by the shortcut.
        Start-Process -FilePath $Url | Out-Null
    }
}

try {
    Push-Location -LiteralPath $projectRoot
    $locationPushed = $true
    if (-not (Test-Path -LiteralPath (Join-Path $projectRoot 'server.js'))) {
        throw 'Keep SillyTavern.bat and its launcher folder in the SillyTavern project.'
    }
    $node = (Get-Command node.exe -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1).Source
    if (-not $node) { throw 'Node.js was not found. Install Node.js 20 or newer, then try again.' }
    $nodeVersion = & $node --version
    if ($LASTEXITCODE -ne 0 -or [int] ($nodeVersion.TrimStart('v').Split('.')[0]) -lt 20) {
        throw 'SillyTavern requires Node.js 20 or newer.'
    }
    if (-not (Test-Path -LiteralPath 'node_modules\yaml\package.json') -or
        -not (Test-Path -LiteralPath 'node_modules\express\package.json')) {
        throw 'Dependencies are missing. Run the original Start.bat once to install them.'
    }

    # Read only the local connection settings; never return credentials or chats.
    $readSettings = @'
const fs = require('node:fs');
const config = require('yaml').parse(fs.readFileSync('config.yaml', 'utf8'));
const port = config.port ?? 8000;
if (!Number.isInteger(port) || port < 1 || port > 65535) throw Error('Invalid config.yaml port');
const hostname = config.protocol?.ipv4 === false ? '[::1]' : '127.0.0.1';
const scheme = config.ssl?.enabled ? 'https' : 'http';
const probeUrl = scheme + '://' + hostname + ':' + port + '/';
const browserHostname = config.browserLaunch?.hostname;
const browserPort = config.browserLaunch?.port;
const url = new URL(probeUrl);
if (browserHostname && browserHostname !== 'auto') url.hostname = browserHostname;
if (Number.isInteger(browserPort) && browserPort > 0) url.port = String(browserPort);
console.log(JSON.stringify({port, hostname: hostname.replace(/[\[\]]/g, ''), probeUrl, browserUrl: url.href}));
'@
    $settingsJson = & $node --input-type=commonjs --eval $readSettings
    if ($LASTEXITCODE -ne 0) { throw 'Could not read config.yaml. See the error above.' }
    $settings = $settingsJson | ConvertFrom-Json

    if ($Check) {
        [pscustomobject]@{
            ProjectRoot = $projectRoot
            Node = $node
            NodeVersion = $nodeVersion
            ProbeUrl = $settings.probeUrl
            BrowserUrl = $settings.browserUrl
            DependenciesPresent = $true
        } | ConvertTo-Json
        exit 0
    }

    $sha = [Security.Cryptography.SHA256]::Create()
    try { $rootHash = [BitConverter]::ToString($sha.ComputeHash([Text.Encoding]::UTF8.GetBytes($projectRoot.ToLowerInvariant()))).Replace('-', '') }
    finally { $sha.Dispose() }
    $mutex = [Threading.Mutex]::new($false, "Local\SillyTavern-Desktop-$rootHash")
    try { $ownsMutex = $mutex.WaitOne(0) }
    catch [Threading.AbandonedMutexException] { $ownsMutex = $true }

    if (-not $ownsMutex) {
        Write-Host '[SillyTavern] Waiting for the existing launch...'
        $deadline = [DateTime]::UtcNow.AddSeconds(90)
        do {
            if (Test-SillyTavern $settings.probeUrl) {
                Open-ExistingSession $settings.browserUrl
                exit 0
            }
            Start-Sleep -Milliseconds 750
        } while ([DateTime]::UtcNow -lt $deadline)
        throw 'Another launch is still active but not ready. Check its console window.'
    }

    if (Test-SillyTavern $settings.probeUrl) {
        Open-ExistingSession $settings.browserUrl
        exit 0
    }
    if (Test-Port $settings.hostname $settings.port) {
        throw "Port $($settings.port) is occupied but the service could not be identified as SillyTavern. Check the existing service; no process was stopped."
    }

    $env:NODE_ENV = 'production'
    Write-Host "[SillyTavern] Starting $projectRoot"
    Write-Host "[SillyTavern] URL: $($settings.browserUrl)"
    Write-Host '[SillyTavern] Keep this window open. Press Ctrl+C here to stop the server.'
    $browserEnabled = if ($NoBrowser) { 'false' } else { 'true' }
    & $node (Join-Path $projectRoot 'server.js') --browserLaunchEnabled $browserEnabled
    exit $LASTEXITCODE
}
catch {
    Write-Host "[SillyTavern] $($_.Exception.Message)" -ForegroundColor Red
    exit 1
}
finally {
    if ($ownsMutex) { $mutex.ReleaseMutex() }
    if ($mutex) { $mutex.Dispose() }
    if ($locationPushed) { Pop-Location }
}
