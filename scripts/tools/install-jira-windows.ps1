param(
  [Parameter(Mandatory = $true)]
  [string]$InstallRoot
)

$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"

$descriptorPath = Join-Path $PSScriptRoot "jira-windows.json"
$descriptor = Get-Content -LiteralPath $descriptorPath -Raw | ConvertFrom-Json
$version = [string]$descriptor.version
$archiveSha256 = [string]$descriptor.archive.sha256
$executableSha256 = [string]$descriptor.executable.sha256
$downloadUrl = [string]$descriptor.archive.url
$memberPath = [string]$descriptor.archive.memberPath

$resolvedRoot = [IO.Path]::GetFullPath($InstallRoot)
if ($resolvedRoot -eq [IO.Path]::GetPathRoot($resolvedRoot)) {
  throw "InstallRoot must not be a filesystem root"
}

$managedBin = Join-Path $resolvedRoot "bin"
$toolRoot = Join-Path $resolvedRoot "tools\jira\$version\windows-x64"
$target = Join-Path $toolRoot "jira.exe"

function Assert-Sha256([string]$Path, [string]$Expected, [string]$Label) {
  if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
    throw "$Label is missing: $Path"
  }
  $actual = (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant()
  if ($actual -ne $Expected) {
    throw "$Label SHA-256 mismatch"
  }
}

function Ensure-UserPath([string]$Directory) {
  $userPath = [Environment]::GetEnvironmentVariable("Path", "User")
  $entries = @($userPath -split ";" | Where-Object { $_ })
  if ($entries | Where-Object { [string]::Equals($_.TrimEnd("\"), $Directory.TrimEnd("\"), [StringComparison]::OrdinalIgnoreCase) }) {
    return
  }
  $nextPath = if ([string]::IsNullOrWhiteSpace($userPath)) { $Directory } else { "$($userPath.TrimEnd(';'));$Directory" }
  [Environment]::SetEnvironmentVariable("Path", $nextPath, "User")
}

New-Item -ItemType Directory -Force -Path $managedBin, $toolRoot | Out-Null
if (Test-Path -LiteralPath $target -PathType Leaf) {
  Assert-Sha256 $target $executableSha256 "managed Jira executable"
  Copy-Item -LiteralPath $target -Destination (Join-Path $managedBin "jira.exe") -Force
  Ensure-UserPath $managedBin
  Write-Output $target
  exit 0
}

$temporaryRoot = Join-Path ([IO.Path]::GetTempPath()) ("oh-my-harness-jira-" + [guid]::NewGuid().ToString("N"))
$archivePath = Join-Path $temporaryRoot "jira.zip"
$extractRoot = Join-Path $temporaryRoot "extract"
try {
  New-Item -ItemType Directory -Force -Path $temporaryRoot, $extractRoot | Out-Null
  Invoke-WebRequest -UseBasicParsing -Uri $downloadUrl -OutFile $archivePath
  Assert-Sha256 $archivePath $archiveSha256 "Jira archive"
  Expand-Archive -LiteralPath $archivePath -DestinationPath $extractRoot
  $source = Join-Path $extractRoot ($memberPath -replace "/", "\")
  Assert-Sha256 $source $executableSha256 "Jira executable"
  Copy-Item -LiteralPath $source -Destination $target
  Copy-Item -LiteralPath $source -Destination (Join-Path $managedBin "jira.exe") -Force
  Ensure-UserPath $managedBin
  Write-Output $target
} finally {
  Remove-Item -LiteralPath $temporaryRoot -Recurse -Force -ErrorAction SilentlyContinue
}
