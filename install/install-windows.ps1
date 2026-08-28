<#
.SYNOPSIS
  RealUptime Monitor agent: Windows Server installer (REA-181).

.DESCRIPTION
  Installs the agent under C:\Program Files\RealUptime Agent and registers it
  as a Scheduled Task that starts at boot, runs as LOCAL SERVICE, and restarts
  on failure. Run from an elevated PowerShell:

    iwr -useb https://realuptime.io/agent/install.ps1 | iex; Install-RealUptimeAgent -Token rua_...

  or save this file and run:

    .\install-windows.ps1 -Token rua_...

  Why a Scheduled Task and not `New-Service`: node.exe is not a Service
  Control Manager-aware binary, so a service pointing straight at it starts
  and is immediately killed with error 1053 ("did not respond in a timely
  fashion"). The usual fix is a third-party wrapper (WinSW, NSSM). The
  agent's whole point is zero third-party code on your machine, so this
  installer uses the supervisor Windows already ships: Task Scheduler,
  with -AtStartup, -RestartCount and -RestartInterval. `Get-ScheduledTask
  'RealUptime Agent'` shows it; `Stop-ScheduledTask`/`Start-ScheduledTask`
  control it. If you already run WinSW, `New-Service` with its XML pointing
  at node.exe and dist\agent.js works exactly as well; the agent does not
  care which supervisor it runs under.

  What it does, in order, and nothing else:
    1. Requires Node.js 22+ (https://nodejs.org) on PATH.
    2. Downloads the release zip and SHA256SUMS, verifies the checksum, and
       refuses to unpack on a mismatch.
    3. Unpacks to the install directory, writes the token to
       <install>\env.json readable by Administrators and LOCAL SERVICE only.
    4. Registers and starts the scheduled task.

  The token is passed to the agent as an environment variable from that
  file, never on a command line where Task Manager could read it.

.PARAMETER Token
  The rua_... agent token from the dashboard (shown once at registration).
.PARAMETER Url
  Override the RealUptime origin (self-hosted or staging only).
.PARAMETER Cluster
  Optional cluster label (REALUPTIME_CLUSTER) for the dashboard's cluster view.
.PARAMETER Node
  Optional node label (REALUPTIME_NODE); defaults to the computer name.
.PARAMETER Version
  Pin a release (default: latest).
.PARAMETER Uninstall
  Stop and remove the task and the install directory.
#>
[CmdletBinding()]
param(
  [Parameter(Mandatory = $false)] [string] $Token = $env:REALUPTIME_TOKEN,
  [string] $Url = $env:REALUPTIME_URL,
  [string] $Cluster = $env:REALUPTIME_CLUSTER,
  [string] $Node = $env:REALUPTIME_NODE,
  [string] $Version = "latest",
  [switch] $Uninstall
)

$ErrorActionPreference = "Stop"
$TaskName = "RealUptime Agent"
$InstallDir = Join-Path $env:ProgramFiles "RealUptime Agent"
$ReleaseBase = if ($env:REALUPTIME_RELEASE_BASE) { $env:REALUPTIME_RELEASE_BASE } else { "https://github.com/realuptimehq/realuptime/releases/download" }

function Assert-Admin {
  $principal = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
  if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    throw "Run this from an elevated (Administrator) PowerShell."
  }
}

function Uninstall-RealUptimeAgent {
  Assert-Admin
  if (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue) {
    Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
  }
  if (Test-Path $InstallDir) { Remove-Item -Recurse -Force $InstallDir }
  Write-Host "removed the RealUptime agent task and install directory"
}

function Resolve-ReleaseTag([string] $RequestedVersion) {
  if ($RequestedVersion -ne "latest") { return "agent-$RequestedVersion" }
  $response = Invoke-WebRequest -UseBasicParsing -MaximumRedirection 0 -ErrorAction SilentlyContinue `
    -Uri "https://github.com/realuptimehq/realuptime/releases/latest"
  $location = $response.Headers["Location"]
  if (-not $location) { throw "could not resolve the latest agent release; pass -Version" }
  $tag = ($location -split "/")[-1]
  if ($tag -notlike "agent-*") { throw "latest release '$tag' is not an agent release; pass -Version" }
  return $tag
}

function Install-RealUptimeAgent {
  Assert-Admin
  if (-not $Token) { throw "no token. Pass -Token rua_... (shown once when you register the agent in the dashboard)." }
  if ($Token -notlike "rua_*") { throw "that does not look like an agent token (expected rua_...)" }

  $node = Get-Command node.exe -ErrorAction SilentlyContinue
  if (-not $node) { throw "Node.js 22 or newer is required (https://nodejs.org)." }
  $major = [int]((& node.exe -p "process.versions.node.split('.')[0]").Trim())
  if ($major -lt 22) { throw "Node.js $major found; 22 or newer is required." }

  $tag = Resolve-ReleaseTag $Version
  $ver = $tag.Substring(6)
  $work = Join-Path $env:TEMP ("realuptime-agent-" + [guid]::NewGuid())
  New-Item -ItemType Directory -Path $work | Out-Null
  $zip = Join-Path $work "realuptime-agent-$ver.zip"
  Write-Host "downloading $tag"
  Invoke-WebRequest -UseBasicParsing -Uri "$ReleaseBase/$tag/realuptime-agent-$ver.zip" -OutFile $zip
  Invoke-WebRequest -UseBasicParsing -Uri "$ReleaseBase/$tag/SHA256SUMS" -OutFile (Join-Path $work "SHA256SUMS")

  $expected = (Get-Content (Join-Path $work "SHA256SUMS") | Where-Object { $_ -match "realuptime-agent-$ver\.zip$" } | ForEach-Object { ($_ -split "\s+")[0] })
  if (-not $expected) { throw "SHA256SUMS does not list realuptime-agent-$ver.zip" }
  $actual = (Get-FileHash -Algorithm SHA256 $zip).Hash.ToLower()
  if ($actual -ne $expected.ToLower()) { throw "checksum mismatch: refusing to install" }
  Write-Host "verified SHA256 checksum"

  if (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue) {
    Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
  }
  New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null
  Expand-Archive -Force -Path $zip -DestinationPath $InstallDir
  Remove-Item -Recurse -Force $work

  # The environment for the agent, read by the launcher below. Administrators
  # and LOCAL SERVICE only: the token is a credential.
  $envFile = Join-Path $InstallDir "env.json"
  $envMap = @{ REALUPTIME_TOKEN = $Token }
  if ($Url) { $envMap.REALUPTIME_URL = $Url }
  if ($Cluster) { $envMap.REALUPTIME_CLUSTER = $Cluster }
  if ($Node) { $envMap.REALUPTIME_NODE = $Node }
  $envMap | ConvertTo-Json -Compress | Set-Content -Path $envFile -Encoding UTF8
  $acl = Get-Acl $envFile
  $acl.SetAccessRuleProtection($true, $false)
  foreach ($who in @("BUILTIN\Administrators", "NT AUTHORITY\LOCAL SERVICE", "NT AUTHORITY\SYSTEM")) {
    $acl.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule($who, "Read", "Allow")))
  }
  $acl.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule("BUILTIN\Administrators", "FullControl", "Allow")))
  Set-Acl $envFile $acl

  # A tiny launcher that loads env.json into the environment and execs the
  # agent. Kept as a file in the install dir so the task's command line
  # carries no secret.
  $launcher = Join-Path $InstallDir "run-agent.ps1"
  @'
$ErrorActionPreference = "Stop"
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$envMap = Get-Content (Join-Path $here "env.json") -Raw | ConvertFrom-Json
foreach ($p in $envMap.PSObject.Properties) { [Environment]::SetEnvironmentVariable($p.Name, $p.Value, "Process") }
& node.exe (Join-Path $here "dist\agent.js")
exit $LASTEXITCODE
'@ | Set-Content -Path $launcher -Encoding UTF8

  $action = New-ScheduledTaskAction -Execute "powershell.exe" `
    -Argument "-NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$launcher`""
  $trigger = New-ScheduledTaskTrigger -AtStartup
  $settings = New-ScheduledTaskSettingsSet -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) `
    -ExecutionTimeLimit ([TimeSpan]::Zero) -StartWhenAvailable -MultipleInstances IgnoreNew
  $principal = New-ScheduledTaskPrincipal -UserId "NT AUTHORITY\LOCAL SERVICE" -LogonType ServiceAccount -RunLevel Limited
  Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Settings $settings -Principal $principal -Force | Out-Null
  Start-ScheduledTask -TaskName $TaskName
  Write-Host "done. Get-ScheduledTask '$TaskName' shows the agent; it appears in the dashboard within a minute."
}

if ($Uninstall) { Uninstall-RealUptimeAgent } elseif ($MyInvocation.InvocationName -ne ".") { Install-RealUptimeAgent }
