param(
  [Parameter(Mandatory = $true)][int]$ParentPid,
  [Parameter(Mandatory = $true)][string]$InstallerPath,
  [Parameter(Mandatory = $true)][string]$CurrentExecutable,
  [Parameter(Mandatory = $true)][string]$StatePath,
  [Parameter(Mandatory = $true)][string]$RollbackDirectory,
  [Parameter(Mandatory = $true)][string]$LogPath
)

$ErrorActionPreference = "Stop"

function Write-UpdaterLog {
  param([string]$EventName, [string]$Message = "")
  $entry = [ordered]@{
    timestamp = [DateTime]::UtcNow.ToString("o")
    event = $EventName
  }
  if ($Message) { $entry.message = $Message }
  $directory = Split-Path -Parent $LogPath
  New-Item -ItemType Directory -Force -Path $directory | Out-Null
  Add-Content -LiteralPath $LogPath -Value (($entry | ConvertTo-Json -Compress)) -Encoding UTF8
}

function Set-UpdaterState {
  param([string]$Phase, [string]$Message, [string]$Failure = "")
  if (-not (Test-Path -LiteralPath $StatePath -PathType Leaf)) { return }
  $state = Get-Content -Raw -LiteralPath $StatePath | ConvertFrom-Json
  $state.status | Add-Member -NotePropertyName phase -NotePropertyValue $Phase -Force
  $state.status | Add-Member -NotePropertyName message -NotePropertyValue $Message -Force
  if ($Failure) {
    $state.status | Add-Member -NotePropertyName error -NotePropertyValue $Failure -Force
  } else {
    $state.status.PSObject.Properties.Remove("error")
  }
  $temporary = "$StatePath.$([Guid]::NewGuid().ToString('N')).tmp"
  $json = ($state | ConvertTo-Json -Depth 20) + [Environment]::NewLine
  [IO.File]::WriteAllText($temporary, $json, (New-Object Text.UTF8Encoding($false)))
  Move-Item -Force -LiteralPath $temporary -Destination $StatePath
}

function Invoke-RobocopyChecked {
  param([string]$Source, [string]$Destination)
  New-Item -ItemType Directory -Force -Path $Destination | Out-Null
  & robocopy.exe $Source $Destination /MIR /COPY:DAT /DCOPY:DAT /R:2 /W:1 /XJ /NFL /NDL /NJH /NJS /NP | Out-Null
  if ($LASTEXITCODE -gt 7) { throw "Program-file copy failed with robocopy exit code $LASTEXITCODE." }
}

$installer = [IO.Path]::GetFullPath($InstallerPath)
$executable = [IO.Path]::GetFullPath($CurrentExecutable)
$installDirectory = [IO.Path]::GetFullPath((Split-Path -Parent $executable))
$rollback = [IO.Path]::GetFullPath($RollbackDirectory)
$stateDirectory = [IO.Path]::GetFullPath((Split-Path -Parent $StatePath))

if ([IO.Path]::GetFileName($executable) -ne "Wheat.exe") { throw "Unexpected Wheat executable name." }
if ($installDirectory -eq [IO.Path]::GetPathRoot($installDirectory)) { throw "Refusing to update a drive root." }
if (-not $rollback.StartsWith($stateDirectory + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) { throw "Rollback directory escapes updater state." }
if (-not (Test-Path -LiteralPath $installer -PathType Leaf)) { throw "Staged installer is missing." }

try {
  Write-UpdaterLog "helper-started"
  try { Wait-Process -Id $ParentPid -ErrorAction Stop } catch { }

  if (Test-Path -LiteralPath $rollback) { Remove-Item -Recurse -Force -LiteralPath $rollback }
  Invoke-RobocopyChecked -Source $installDirectory -Destination $rollback
  Write-UpdaterLog "rollback-snapshot-created"
  $rollbackRoot = Split-Path -Parent $rollback
  Get-ChildItem -LiteralPath $rollbackRoot -Directory | Where-Object { $_.FullName -ne $rollback } | ForEach-Object {
    Remove-Item -Recurse -Force -LiteralPath $_.FullName
  }

  Set-UpdaterState -Phase "awaiting-confirmation" -Message "Installer running; waiting for Wheat startup confirmation"
  $installerProcess = Start-Process -FilePath $installer -ArgumentList @("/S", "--updated") -Wait -PassThru -WindowStyle Hidden
  if ($installerProcess.ExitCode -ne 0) { throw "NSIS installer exited with code $($installerProcess.ExitCode)." }

  Write-UpdaterLog "installer-completed"
  if (Test-Path -LiteralPath $executable -PathType Leaf) {
    Start-Process -FilePath $executable -ArgumentList @("--updated") -WindowStyle Hidden
  } else {
    throw "The updated Wheat executable was not found after installation."
  }
} catch {
  $failure = $_.Exception.Message
  Write-UpdaterLog "installation-failed" $failure
  try {
    if (Test-Path -LiteralPath $rollback -PathType Container) {
      Invoke-RobocopyChecked -Source $rollback -Destination $installDirectory
      Write-UpdaterLog "rollback-restored"
    }
  } catch {
    $failure = "$failure Rollback also failed: $($_.Exception.Message)"
    Write-UpdaterLog "rollback-failed" $_.Exception.Message
  }
  Set-UpdaterState -Phase "error" -Message "Update failed; the previous version was recovered where possible" -Failure $failure
  if (Test-Path -LiteralPath $executable -PathType Leaf) {
    Start-Process -FilePath $executable -ArgumentList @("--update-recovered") -WindowStyle Hidden
  }
  exit 1
}
