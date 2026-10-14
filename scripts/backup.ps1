<#
.SYNOPSIS
  Back up the Mawdoo3 Visitors database: a timestamped pg_dump archive (custom format), taken as the
  schema owner, verified and checksummed.

.DESCRIPTION
  Writes <OutputDir>\<Database>-<yyyyMMddTHHmmssZ>.dump and a .sha256 file next to it (the format of
  `sha256sum`, so `sha256sum -c` checks it on Linux). The archive holds the schema, the data, the
  grants of the runtime role, the triggers and the Alembic version: scripts/restore.ps1 restores it
  into a fresh database. It does not hold the roles themselves (cluster-wide objects): provision them
  first on a new server (deploy/postgres/initdb/10-vms-roles.sh, or scripts/db.ps1 init locally).

  The dump is one consistent snapshot (pg_dump runs in a single REPEATABLE READ transaction) and does
  not block the running application; it waits at most 60 s for table locks (a migration in progress)
  and then fails instead of queueing behind it.

  The password comes from libpq, never from the command line: PGPASSWORD, or a password file
  (PGPASSFILE, default %APPDATA%\postgresql\pgpass.conf). The script never prompts (--no-password),
  so it can run from the Task Scheduler.

  The archive contains personal data, password hashes and the audit trail: the output folder and files
  are restricted to the current user. Copy them off the host (encrypted) as the backup policy requires
  (docs/decisions/phase-9-deploy.md: RPO/RTO).

  docker-compose deployments: scripts/backup.sh --compose (runs pg_dump inside the postgres container).

.PARAMETER Database
  Database to dump (default: vms).
.PARAMETER User
  Role to connect as: the schema owner (default: vms_owner), which can read every table.
.PARAMETER DbHost
  Server host (default: PGHOST, else localhost).
.PARAMETER Port
  Server port (default: PGPORT, else 5433, the repository's local cluster; production usually 5432).
.PARAMETER OutputDir
  Folder for the archives (default: .local\backups in the repository, which git ignores).
.PARAMETER RetentionDays
  Delete this script's archives of the same database older than this many days, always keeping the
  newest (default: 0 = delete nothing).
.PARAMETER PgBin
  Folder with pg_dump.exe and pg_restore.exe (default: .local\pgsql\bin when present, else PATH). Use
  binaries of the server's major version or newer.

.EXAMPLE
  $env:PGPASSFILE = "$env:APPDATA\postgresql\pgpass.conf"
  .\scripts\backup.ps1 -Database vms -User vms_owner -DbHost db.internal -Port 5432 -OutputDir D:\vms-backups -RetentionDays 14
#>
[CmdletBinding()]
param(
    [string]$Database = 'vms',
    [string]$User = 'vms_owner',
    [string]$DbHost,
    [int]$Port,
    [string]$OutputDir,
    [ValidateRange(0, 3650)]
    [int]$RetentionDays = 0,
    [string]$PgBin
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$repo = Split-Path -Parent $PSScriptRoot

function Resolve-PgTool([string]$name, [string]$folder) {
    if ($folder) {
        $path = Join-Path $folder "$name.exe"
        if (-not (Test-Path $path)) { throw "$name.exe not found in $folder" }
        return $path
    }
    $local = Join-Path $repo ".local\pgsql\bin\$name.exe"
    if (Test-Path $local) { return $local }
    $command = Get-Command $name -ErrorAction SilentlyContinue
    if ($null -eq $command) { throw "$name not found: install the PostgreSQL client tools or pass -PgBin" }
    return $command.Source
}

# Native tools write notices to stderr; only their exit code decides success.
function Invoke-Native([string]$exe, [string[]]$arguments) {
    $previous = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
        $output = & $exe @arguments
        $code = $LASTEXITCODE
    } finally {
        $ErrorActionPreference = $previous
    }
    if ($code -ne 0) { throw "$(Split-Path -Leaf $exe) failed with exit code $code" }
    return $output
}

# Owner-only access (the archive holds personal data and password hashes).
function Protect-Path([string]$path) {
    $isFolder = Test-Path -LiteralPath $path -PathType Container
    if ($isFolder) {
        $acl = New-Object System.Security.AccessControl.DirectorySecurity
        $inherit = [System.Security.AccessControl.InheritanceFlags]'ContainerInherit, ObjectInherit'
    } else {
        $acl = New-Object System.Security.AccessControl.FileSecurity
        $inherit = [System.Security.AccessControl.InheritanceFlags]::None
    }
    $acl.SetAccessRuleProtection($true, $false)
    $me = [System.Security.Principal.WindowsIdentity]::GetCurrent().User
    $rule = New-Object System.Security.AccessControl.FileSystemAccessRule(
        $me, [System.Security.AccessControl.FileSystemRights]::FullControl, $inherit,
        [System.Security.AccessControl.PropagationFlags]::None, [System.Security.AccessControl.AccessControlType]::Allow)
    $acl.AddAccessRule($rule)
    Set-Acl -LiteralPath $path -AclObject $acl
}

foreach ($pair in @(@('Database', $Database), @('User', $User))) {
    if ($pair[1] -notmatch '^[a-z_][a-z0-9_]{0,62}$') { throw "-$($pair[0]) must be a plain lowercase PostgreSQL identifier" }
}
if (-not $DbHost) { $DbHost = if ($env:PGHOST) { $env:PGHOST } else { 'localhost' } }
if (-not $Port) { $Port = if ($env:PGPORT) { [int]$env:PGPORT } else { 5433 } }
if (-not $OutputDir) { $OutputDir = Join-Path $repo '.local\backups' }

$pgDump = Resolve-PgTool 'pg_dump' $PgBin
$pgRestore = Resolve-PgTool 'pg_restore' $PgBin

if (-not (Test-Path -LiteralPath $OutputDir)) {
    New-Item -ItemType Directory -Path $OutputDir | Out-Null
    Protect-Path $OutputDir
}
$OutputDir = (Resolve-Path -LiteralPath $OutputDir).Path

$stamp = (Get-Date).ToUniversalTime().ToString('yyyyMMddTHHmmssZ')
$name = "$Database-$stamp.dump"
$final = Join-Path $OutputDir $name
$partial = "$final.partial"
if (Test-Path -LiteralPath $final) { throw "$final already exists" }

$started = Get-Date
try {
    # Custom format: compressed, restorable selectively and in parallel, readable by pg_restore --list.
    Invoke-Native $pgDump @(
        "--host=$DbHost", "--port=$Port", "--username=$User", "--dbname=$Database", '--no-password',
        '--format=custom', '--lock-wait-timeout=60s', "--file=$partial"
    ) | Out-Null
    Protect-Path $partial

    # The archive must be complete and be this application's database.
    $listing = Invoke-Native $pgRestore @('--list', $partial)
    foreach ($expected in @('TABLE DATA public alembic_version', 'TABLE DATA public audit_logs', 'TRIGGER public audit_logs audit_logs_immutable')) {
        if (-not ($listing | Where-Object { $_ -like "*$expected*" })) {
            throw "the archive does not contain '$expected': is $Database the Mawdoo3 Visitors database?"
        }
    }
    Move-Item -LiteralPath $partial -Destination $final
} catch {
    Remove-Item -LiteralPath $partial -Force -ErrorAction SilentlyContinue
    throw
}

$hash = (Get-FileHash -LiteralPath $final -Algorithm SHA256).Hash.ToLowerInvariant()
$checksum = "$final.sha256"
# sha256sum format, LF, no BOM.
[System.IO.File]::WriteAllText($checksum, "$hash  $name`n", (New-Object System.Text.UTF8Encoding($false)))
Protect-Path $checksum

if ($RetentionDays -gt 0) {
    $pattern = '^' + [regex]::Escape($Database) + '-\d{8}T\d{6}Z\.dump$'
    $cutoff = (Get-Date).AddDays(-$RetentionDays)
    $archives = Get-ChildItem -LiteralPath $OutputDir -File | Where-Object { $_.Name -match $pattern } | Sort-Object Name -Descending
    foreach ($old in ($archives | Select-Object -Skip 1 | Where-Object { $_.LastWriteTime -lt $cutoff })) {
        Remove-Item -LiteralPath $old.FullName -Force
        Remove-Item -LiteralPath "$($old.FullName).sha256" -Force -ErrorAction SilentlyContinue
        Write-Output "deleted (older than $RetentionDays days): $($old.Name)"
    }
}

$size = (Get-Item -LiteralPath $final).Length
$seconds = [math]::Round(((Get-Date) - $started).TotalSeconds, 1)
Write-Output "backup:   $final"
$entries = @($listing | Where-Object { $_ -match '^\d+;' }).Count
Write-Output "size:     $([math]::Round($size / 1KB, 1)) KiB, $entries archive entries, $seconds s"
Write-Output "sha256:   $hash"
