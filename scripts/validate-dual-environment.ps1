[CmdletBinding()]
param(
  [Parameter()]
  [ValidateNotNullOrEmpty()]
  [string]$Distro = "Ubuntu",

  [Parameter()]
  [string]$RepositoryRoot = ""
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

if ([string]::IsNullOrWhiteSpace($RepositoryRoot)) {
  $RepositoryRoot = Split-Path -Parent (
    Split-Path -Parent $MyInvocation.MyCommand.Path
  )
}
$script:Node = (Get-Command node -ErrorAction Stop).Source
$script:Cli = Join-Path $RepositoryRoot "dist\cli\main.js"
$script:Wsl = (Get-Command wsl.exe -ErrorAction Stop).Source
$script:ExpectedPreviewExit = 2
$script:ExpectedReadyExit = 0
$script:ExpectedStaleExit = 4
$script:ExpectedUnreadyExit = 6
$script:LspCommands = [ordered]@{
  "jdtls" = "Install Eclipse JDT Language Server and expose jdtls on the trusted WSL PATH."
  "kotlin-lsp" = "Install the reviewed Kotlin language server and expose kotlin-lsp on the trusted WSL PATH."
  "csharp-ls" = "Install csharp-ls and expose csharp-ls on the trusted WSL PATH."
  "clangd" = "Install clangd and expose clangd on the trusted WSL PATH."
  "gopls" = "Install gopls and expose gopls on the trusted WSL PATH."
  "pyright-langserver" = "Install Pyright and expose pyright-langserver on the trusted WSL PATH."
  "typescript-language-server" = "Install typescript-language-server and expose it on the trusted WSL PATH."
}

function Write-Step {
  param([Parameter(Mandatory = $true)][string]$Message)
  Write-Host "==> $Message"
}

function Invoke-Wsl {
  param(
    [Parameter(Mandatory = $true)]
    [string[]]$Arguments,

    [Parameter()]
    [int[]]$ExpectedExitCodes = @(0)
  )

  $output = & $script:Wsl -d $Distro --exec @Arguments 2>&1
  $exitCode = $LASTEXITCODE
  if ($ExpectedExitCodes -notcontains $exitCode) {
    throw "WSL command failed with exit $exitCode`: $($output -join [Environment]::NewLine)"
  }
  return ($output -join [Environment]::NewLine).Trim()
}

function Get-WslHome {
  $wslHomePath = Invoke-Wsl -Arguments @(
    "/bin/sh",
    "-c",
    'printf "%s" "$HOME"'
  )
  if (
    -not $wslHomePath.StartsWith("/") -or
    $wslHomePath.StartsWith("/mnt/")
  ) {
    throw "Ubuntu HOME is not a trusted Linux path: $wslHomePath"
  }
  return $wslHomePath
}

function Get-WslTrustedPath {
  param([Parameter(Mandatory = $true)][string]$WslHome)
  return "$WslHome/.local/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"
}

function Resolve-WslCommand {
  param(
    [Parameter(Mandatory = $true)][string]$Command,
    [Parameter(Mandatory = $true)][string]$WslHome,
    [Parameter(Mandatory = $true)][string]$Path
  )

  $resolved = Invoke-Wsl -Arguments @(
    "/bin/sh",
    "-c",
    'PATH="$1"; HOME="$2"; command -v -- "$3"',
    "omh-command-probe",
    $Path,
    $WslHome,
    $Command
  ) -ExpectedExitCodes @(0, 127)
  if ([string]::IsNullOrWhiteSpace($resolved)) {
    return $null
  }
  if (-not $resolved.StartsWith("/") -or $resolved.StartsWith("/mnt/")) {
    throw "$Command resolved outside the trusted Linux filesystem: $resolved"
  }
  return $resolved
}

function Assert-WslPrerequisites {
  Write-Step "Preflight trusted external Node, Git, and seven LSP executables"
  $wslHomePath = Get-WslHome
  $trustedPath = Get-WslTrustedPath -WslHome $wslHomePath
  $nodeProbe = Invoke-Wsl -Arguments @(
    "/usr/bin/env",
    "-i",
    "HOME=$wslHomePath",
    "PATH=$trustedPath",
    "node",
    "-e",
    'process.stdout.write(JSON.stringify({version:process.versions.node,path:process.execPath,platform:process.platform}))'
  )
  $node = $nodeProbe | ConvertFrom-Json
  $versionParts = @($node.version.Split(".") | ForEach-Object { [int]$_ })
  if (
    $node.platform -ne "linux" -or
    -not $node.path.StartsWith("/") -or
    $node.path.StartsWith("/mnt/") -or
    $versionParts.Count -lt 3 -or
    $versionParts[0] -lt 22 -or
    ($versionParts[0] -eq 22 -and $versionParts[1] -lt 19)
  ) {
    throw "Ubuntu requires an operator-owned trusted Linux Node >=22.19.0 outside /mnt. OMH will not install or own Node."
  }

  $missing = New-Object System.Collections.Generic.List[string]
  if ($null -eq (Resolve-WslCommand -Command "git" -WslHome $wslHomePath -Path $trustedPath)) {
    $missing.Add("git: Install Git in Ubuntu and expose it on the trusted WSL PATH.")
  }
  foreach ($entry in $script:LspCommands.GetEnumerator()) {
    if ($null -eq (Resolve-WslCommand -Command $entry.Key -WslHome $wslHomePath -Path $trustedPath)) {
      $missing.Add("$($entry.Key): $($entry.Value)")
    }
  }
  if ($missing.Count -gt 0) {
    throw @"
Required external WSL prerequisites are missing. No OMH preview or apply was run:
$($missing -join [Environment]::NewLine)
Install these operator-owned prerequisites, then rerun this validator. OMH never installs, upgrades, owns, repairs, or removes them.
"@
  }
  return @{
    Home = $wslHomePath
    Path = $trustedPath
  }
}

function Get-PathFingerprint {
  param([Parameter(Mandatory = $true)][string[]]$Paths)
  $manifest = New-Object System.Collections.Generic.List[string]
  foreach ($path in $Paths) {
    if (-not (Test-Path -LiteralPath $path)) {
      $manifest.Add("missing|$path")
      continue
    }
    $item = Get-Item -LiteralPath $path -Force
    if (-not $item.PSIsContainer) {
      $manifest.Add("file|$path|$((Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash)")
      continue
    }
    $manifest.Add("directory|$path")
    Get-ChildItem -LiteralPath $path -Force -Recurse |
      Sort-Object FullName |
      ForEach-Object {
        if (($_.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
          $manifest.Add("reparse|$($_.FullName)")
        } elseif (-not $_.PSIsContainer) {
          $manifest.Add(
            "file|$($_.FullName)|$((Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256).Hash)"
          )
        }
      }
  }
  $bytes = [Text.Encoding]::UTF8.GetBytes(($manifest -join "`n"))
  $sha = [Security.Cryptography.SHA256]::Create()
  try {
    return ([BitConverter]::ToString($sha.ComputeHash($bytes))).Replace("-", "").ToLowerInvariant()
  } finally {
    $sha.Dispose()
  }
}

function Get-WslAuthFingerprint {
  param(
    [Parameter(Mandatory = $true)][string]$WslHome,
    [Parameter(Mandatory = $true)][string]$Path
  )
  return Invoke-Wsl -Arguments @(
    "/bin/sh",
    "-c",
    @'
set -eu
HOME="$1"
PATH="$2"
{
  for relative in .config/gh .config/linear .config/notion .config/ntn; do
    target="$HOME/$relative"
    if [ ! -e "$target" ]; then
      printf 'missing|%s\n' "$relative"
      continue
    fi
    find "$target" -type f -print0 \
      | sort -z \
      | xargs -0 -r sha256sum
  done
} | sha256sum | awk '{print $1}'
'@,
    "omh-auth-fingerprint",
    $WslHome,
    $Path
  )
}

function Get-PreservationSnapshot {
  param(
    [Parameter(Mandatory = $true)][string]$WslHome,
    [Parameter(Mandatory = $true)][string]$WslPath
  )
  $codexRoot = Join-Path $HOME ".codex"
  return @{
    Codex = Get-PathFingerprint -Paths @(
      (Join-Path $codexRoot "config.toml"),
      (Join-Path $codexRoot "plugins"),
      (Join-Path $codexRoot "skills")
    )
    WslAuth = Get-WslAuthFingerprint -WslHome $WslHome -Path $WslPath
  }
}

function Assert-Preservation {
  param(
    [Parameter(Mandatory = $true)][hashtable]$Before,
    [Parameter(Mandatory = $true)][hashtable]$After
  )
  if ($Before.Codex -ne $After.Codex) {
    throw "Codex configuration/plugin/skill state changed during dual-environment acceptance."
  }
  if ($Before.WslAuth -ne $After.WslAuth) {
    throw "WSL CLI-owned authentication state changed during dual-environment acceptance."
  }
}

function Invoke-OmhJson {
  param(
    [Parameter(Mandatory = $true)][string[]]$Arguments,
    [Parameter(Mandatory = $true)][int[]]$ExpectedExitCodes
  )
  $stderrPath = Join-Path ([IO.Path]::GetTempPath()) (
    "omh-dual-validation-{0}.stderr" -f [Guid]::NewGuid().ToString("N")
  )
  try {
    $effective = @($Arguments)
    if ($effective -notcontains "--json") {
      $effective += "--json"
    }
    $stdout = & $script:Node $script:Cli @effective 2> $stderrPath
    $exitCode = $LASTEXITCODE
    $stderrContent = if (Test-Path -LiteralPath $stderrPath) {
      Get-Content -LiteralPath $stderrPath -Raw
    } else {
      $null
    }
    $stderr = if ($null -eq $stderrContent) {
      ""
    } else {
      ([string]$stderrContent).Trim()
    }
    $text = ($stdout -join [Environment]::NewLine).Trim()
    if ([string]::IsNullOrWhiteSpace($text)) {
      throw "OMH returned no JSON for '$($effective -join " ")': $stderr"
    }
    try {
      $json = $text | ConvertFrom-Json
    } catch {
      $sample = $text.Substring(0, [Math]::Min($text.Length, 2048))
      throw "OMH returned invalid JSON for '$($effective -join " ")': $sample"
    }
    if ($ExpectedExitCodes -notcontains $exitCode) {
      $detail = if (
        $null -ne $json.apply -and
        -not [string]::IsNullOrWhiteSpace([string]$json.apply.failure)
      ) {
        [string]$json.apply.failure
      } elseif (-not [string]::IsNullOrWhiteSpace([string]$json.output)) {
        [string]$json.output
      } else {
        "state=$($json.state)"
      }
      throw "OMH exited $exitCode for '$($effective -join " ")': $detail; stderr: $stderr"
    }
    return @{
      ExitCode = $exitCode
      Json = $json
      Stderr = $stderr
    }
  } finally {
    Remove-Item -LiteralPath $stderrPath -Force -ErrorAction SilentlyContinue
  }
}

function Assert-Ready {
  param(
    [Parameter(Mandatory = $true)]$Result,
    [Parameter(Mandatory = $true)][string]$Label
  )
  if (@("ready", "ready-with-optional-gaps") -notcontains $Result.Json.state) {
    throw "$Label is not ready: $($Result.Json | ConvertTo-Json -Depth 12)"
  }
}

if (-not (Test-Path -LiteralPath $script:Cli -PathType Leaf)) {
  throw "Compiled CLI is missing. Run npm run build before this validator."
}

$initialList = & $script:Wsl --list --verbose 2>&1
$listText = [regex]::Replace(($initialList -join "`n"), "\x00", "")
$distributionMatch = [regex]::Match(
  $listText,
  "(?m)^\s*\*?\s*$([regex]::Escape($Distro))\s+(Running|Stopped)\s+2\s*$"
)
if ($LASTEXITCODE -ne 0 -or -not $distributionMatch.Success) {
  throw "WSL2 distribution '$Distro' is required."
}
$initiallyRunning = $distributionMatch.Groups[1].Value -eq "Running"
$distroTerminated = $false

try {
  $preflight = Assert-WslPrerequisites
  $before = Get-PreservationSnapshot -WslHome $preflight.Home -WslPath $preflight.Path

  # --target wsl-ubuntu
  $wslBase = @(
    "setup", "--target", "wsl-ubuntu",
    "--profile", "personal",
    "--agents", "claude-code,opencode",
    "--tools", "github,linear,notion",
    "--capability-set", "profile",
    "--clean"
  )
  # --target windows-native and --tool-route wsl-ubuntu
  $windowsBase = @(
    "setup", "--target", "windows-native",
    "--profile", "personal",
    "--agents", "claude-code,opencode",
    "--tools", "github,linear,notion",
    "--capability-set", "workflow-only",
    "--tool-route", "wsl-ubuntu",
    "--clean"
  )

  Write-Step "Preview and apply Ubuntu WSL"
  $wslPreview = Invoke-OmhJson -Arguments $wslBase -ExpectedExitCodes @($script:ExpectedPreviewExit)
  if ($wslPreview.Json.preview.digest -notmatch "^[0-9a-f]{64}$") {
    throw "WSL preview did not emit an exact digest."
  }
  # --apply --digest
  $wslApply = Invoke-OmhJson -Arguments (
    $wslBase + @("--apply", "--digest", $wslPreview.Json.preview.digest)
  ) -ExpectedExitCodes @($script:ExpectedReadyExit)
  Assert-Ready -Result $wslApply -Label "WSL apply"

  Write-Step "Verify WSL target-native status and doctor"
  $wslStatus = Invoke-OmhJson -Arguments @(
    "status", "--target", "wsl-ubuntu"
  ) -ExpectedExitCodes @($script:ExpectedReadyExit)
  $wslDoctor = Invoke-OmhJson -Arguments @(
    "doctor", "--target", "wsl-ubuntu"
  ) -ExpectedExitCodes @($script:ExpectedReadyExit)
  Assert-Ready -Result $wslStatus -Label "WSL status"
  Assert-Ready -Result $wslDoctor -Label "WSL doctor"

  Write-Step "Preview and apply Windows with the exact WSL route receipt"
  $windowsPreview = Invoke-OmhJson -Arguments $windowsBase -ExpectedExitCodes @($script:ExpectedPreviewExit)
  if ($windowsPreview.Json.preview.digest -notmatch "^[0-9a-f]{64}$") {
    throw "Windows preview did not emit an exact digest."
  }
  $stale = Invoke-OmhJson -Arguments (
    $windowsBase + @("--apply", "--digest", $wslPreview.Json.preview.digest)
  ) -ExpectedExitCodes @($script:ExpectedStaleExit)
  if ($stale.Json.state -ne "stale-preview") {
    throw "Cross-target digest was not rejected as stale-preview."
  }
  $windowsApply = Invoke-OmhJson -Arguments (
    $windowsBase + @("--apply", "--digest", $windowsPreview.Json.preview.digest)
  ) -ExpectedExitCodes @($script:ExpectedReadyExit)
  Assert-Ready -Result $windowsApply -Label "Windows apply"

  # --target all
  Write-Step "Verify aggregate status/doctor and idempotent reapply"
  $aggregateStatus = Invoke-OmhJson -Arguments @(
    "status", "--target", "all"
  ) -ExpectedExitCodes @($script:ExpectedReadyExit)
  $aggregateDoctor = Invoke-OmhJson -Arguments @(
    "doctor", "--target", "all"
  ) -ExpectedExitCodes @($script:ExpectedReadyExit)
  Assert-Ready -Result $aggregateStatus -Label "Aggregate status"
  Assert-Ready -Result $aggregateDoctor -Label "Aggregate doctor"

  $wslRepeat = Invoke-OmhJson -Arguments $wslBase -ExpectedExitCodes @($script:ExpectedPreviewExit)
  $wslRepeatApply = Invoke-OmhJson -Arguments (
    $wslBase + @("--apply", "--digest", $wslRepeat.Json.preview.digest)
  ) -ExpectedExitCodes @($script:ExpectedReadyExit)
  Assert-Ready -Result $wslRepeatApply -Label "WSL idempotent reapply"
  $windowsRepeat = Invoke-OmhJson -Arguments $windowsBase -ExpectedExitCodes @($script:ExpectedPreviewExit)
  $windowsRepeatApply = Invoke-OmhJson -Arguments (
    $windowsBase + @("--apply", "--digest", $windowsRepeat.Json.preview.digest)
  ) -ExpectedExitCodes @($script:ExpectedReadyExit)
  Assert-Ready -Result $windowsRepeatApply -Label "Windows idempotent reapply"

  # --terminate
  Write-Step "Verify read-only stopped-WSL degradation"
  & $script:Wsl --terminate $Distro
  if ($LASTEXITCODE -ne 0) {
    throw "Unable to stop WSL distribution '$Distro' for degradation verification."
  }
  $distroTerminated = $true
  $degraded = Invoke-OmhJson -Arguments @(
    "status", "--target", "all"
  ) -ExpectedExitCodes @($script:ExpectedUnreadyExit)
  if ($degraded.Json.state -ne "unverifiable") {
    throw "Stopped WSL did not degrade aggregate readiness."
  }

  Invoke-Wsl -Arguments @("/bin/true") | Out-Null
  $distroTerminated = $false
  $finalStatus = Invoke-OmhJson -Arguments @(
    "status", "--target", "all"
  ) -ExpectedExitCodes @($script:ExpectedReadyExit)
  Assert-Ready -Result $finalStatus -Label "Final aggregate status"

  $after = Get-PreservationSnapshot -WslHome $preflight.Home -WslPath $preflight.Path
  Assert-Preservation -Before $before -After $after
} finally {
  if ($initiallyRunning -and $distroTerminated) {
    & $script:Wsl -d $Distro --exec /bin/true | Out-Null
  } elseif (-not $initiallyRunning) {
    & $script:Wsl --terminate $Distro | Out-Null
  }
}

Write-Host "Dual-environment acceptance passed for Windows and $Distro."
