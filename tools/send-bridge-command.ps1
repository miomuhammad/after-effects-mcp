[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$Command,

    [string]$ArgsJson,
    [string]$ArgsFile,
    [switch]$ArgsStdin,
    [switch]$Wait,
    [int]$TimeoutMs = 12000,
    [int]$PollMs = 250,
    [string]$BridgeDir
)

$repoRoot = Split-Path -Parent $PSScriptRoot
$scriptPath = Join-Path $PSScriptRoot "send-bridge-command.mjs"
$nodeArgs = @($scriptPath, "--command", $Command, "--timeout-ms", $TimeoutMs, "--poll-ms", $PollMs)

if ($ArgsJson) {
    $nodeArgs += @("--args-json", $ArgsJson)
}

if ($ArgsFile) {
    $nodeArgs += @("--args-file", $ArgsFile)
}

if ($ArgsStdin.IsPresent) {
    $nodeArgs += "--args-stdin"
}

if ($Wait.IsPresent) {
    $nodeArgs += "--wait"
}

if ($BridgeDir) {
    $nodeArgs += @("--bridge-dir", $BridgeDir)
}

Push-Location $repoRoot
try {
    if ($ArgsStdin.IsPresent) {
        $stdinText = [Console]::In.ReadToEnd()
        if (-not [string]::IsNullOrWhiteSpace($stdinText)) {
            $stdinText | node @nodeArgs
        } else {
            node @nodeArgs
        }
    } else {
        node @nodeArgs
    }
} finally {
    Pop-Location
}
