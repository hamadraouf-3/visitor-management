<#
.SYNOPSIS
  Restore a scripts/backup.ps1 archive into a NEW database and verify it (schema version, row counts,
  triggers, the runtime role's privileges).

.DESCRIPTION
  Never touches an existing database: the target must not exist. The script
    1. checks the archive's .sha256 (when present) and that pg_restore can read it;
    2. creates the target database (owner: -User; template0, so the cluster's UTF-8 / builtin C.UTF-8
       locale) and applies the database-level grants the provisioning gives (deploy/postgres/initdb):
       only the owner and the runtime role may connect, nobody else gets TEMPORARY, the public schema
       belongs to the owner and the runtime role may only use it;
    3. restores the archive in ONE transaction (all or nothing; on failure the new database is dropped);
    4. runs ANALYZE and verifies the result, failing when the schema version, the triggers or the
       runtime role's privileges are not what the application requires.
  Roles are not part of an archive: -User and -AppRole must exist (provision them first on a new server).

  Switching the application to the restored database is a separate, deliberate step: stop the API,
  point DATABASE_URL / MIGRATION_DATABASE_URL at it (or rename the databases), start the API (it refuses
  to start if the runtime role's privileges are wrong). See docs/decisions/phase-9-deploy.md.

  Passwords come from libpq (PGPASSWORD or a password file); the script never prompts.

.PARAMETER File
  The .dump archive written by scripts/backup.ps1 (or scripts/backup.sh).
.PARAMETER TargetDatabase
  Name of the database to create (must not exist), e.g. vms_restore_20261006.
.PARAMETER User
  Owner of the restored database and the role that restores it (default: vms_owner, the role that
  owned the dumped objects).
.PARAMETER AppRole
  The runtime role the archive grants to (default: vms_app).
.PARAMETER AdminUser
  Role that creates the database (default: -User; needs CREATEDB, or a superuser such as postgres).
.PARAMETER MaintenanceDatabase
  Database to connect to for CREATE DATABASE (default: postgres).
.PARAMETER DbHost
  Server host (default: PGHOST, else localhost).
.PARAMETER Port
  Server port (default: PGPORT, else 5433, the repository's local cluster).
.PARAMETER RequireChecksum
  Fail when the archive has no .sha256 file.
.PARAMETER PgBin
  Folder with psql.exe and pg_restore.exe (default: .local\pgsql\bin when present, else PATH).

.EXAMPLE
  .\scripts\restore.ps1 -File .local\backups\vms-20261006T080000Z.dump -TargetDatabase vms_restore_20261006
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$File,
    [Parameter(Mandatory = $true)]
    [string]$TargetDatabase,
    [string]$User = 'vms_owner',
    [string]$AppRole = 'vms_app',
    [string]$AdminUser,
    [string]$MaintenanceDatabase = 'postgres',
    [string]$DbHost,
    [int]$Port,
    [switch]$RequireChecksum,
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

# Native tools write notices to stderr; only their exit code decides success. SQL goes in on stdin, so
# psql variables (:"name", :'value') quote every identifier and value.
function Invoke-Native([string]$exe, [string[]]$arguments, [string]$sql) {
    $previous = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
        if ($sql) { $output = $sql | & $exe @arguments } else { $output = & $exe @arguments }
        $code = $LASTEXITCODE
    } finally {
        $ErrorActionPreference = $previous
    }
    if ($code -ne 0) { throw "$(Split-Path -Leaf $exe) failed with exit code $code" }
    return $output
}

foreach ($pair in @(@('TargetDatabase', $TargetDatabase), @('User', $User), @('AppRole', $AppRole), @('MaintenanceDatabase', $MaintenanceDatabase))) {
    if ($pair[1] -notmatch '^[a-z_][a-z0-9_]{0,62}$') { throw "-$($pair[0]) must be a plain lowercase PostgreSQL identifier" }
}
if (-not $AdminUser) { $AdminUser = $User }
if ($AdminUser -notmatch '^[a-z_][a-z0-9_]{0,62}$') { throw '-AdminUser must be a plain lowercase PostgreSQL identifier' }
if (-not $DbHost) { $DbHost = if ($env:PGHOST) { $env:PGHOST } else { 'localhost' } }
if (-not $Port) { $Port = if ($env:PGPORT) { [int]$env:PGPORT } else { 5433 } }

$psql = Resolve-PgTool 'psql' $PgBin
$pgRestore = Resolve-PgTool 'pg_restore' $PgBin
$File = (Resolve-Path -LiteralPath $File).Path
$connection = @("--host=$DbHost", "--port=$Port", '--no-password')
$psqlCommon = $connection + @('--no-psqlrc', '--quiet', '--tuples-only', '--no-align', '--set=ON_ERROR_STOP=1')

# 1. The archive ---------------------------------------------------------------------------------------
$checksum = "$File.sha256"
if (Test-Path -LiteralPath $checksum) {
    $expected = ((Get-Content -LiteralPath $checksum -Raw).Trim() -split '\s+')[0].ToLowerInvariant()
    $actual = (Get-FileHash -LiteralPath $File -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($expected -ne $actual) { throw "checksum mismatch for $File (expected $expected, got $actual): do not restore this file" }
    Write-Output "checksum: OK ($actual)"
} elseif ($RequireChecksum) {
    throw "$checksum is missing"
} else {
    Write-Warning "no $checksum next to the archive: integrity not checked"
}
$listing = Invoke-Native $pgRestore @('--list', $File)
if (-not ($listing | Where-Object { $_ -like '*TABLE DATA public alembic_version*' })) {
    throw "$File is not a Mawdoo3 Visitors archive (no alembic_version)"
}

# 2. The new database ------------------------------------------------------------------------------------
$exists = Invoke-Native $psql ($psqlCommon + @("--username=$AdminUser", "--dbname=$MaintenanceDatabase", "--set=db=$TargetDatabase")) "SELECT count(*) FROM pg_database WHERE datname = :'db';"
if ("$exists".Trim() -ne '0') { throw "database $TargetDatabase already exists: restore into a new database" }

$created = $false
$started = Get-Date
try {
    Invoke-Native $psql ($psqlCommon + @("--username=$AdminUser", "--dbname=$MaintenanceDatabase", "--set=db=$TargetDatabase", "--set=owner=$User")) 'CREATE DATABASE :"db" OWNER :"owner" TEMPLATE template0;' | Out-Null
    $created = $true

    $provision = @'
REVOKE ALL ON DATABASE :"db" FROM PUBLIC;
GRANT CONNECT ON DATABASE :"db" TO :"owner", :"app";
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
ALTER SCHEMA public OWNER TO :"owner";
GRANT USAGE ON SCHEMA public TO :"app";
'@
    Invoke-Native $psql ($psqlCommon + @("--username=$User", "--dbname=$TargetDatabase", "--set=db=$TargetDatabase", "--set=owner=$User", "--set=app=$AppRole")) $provision | Out-Null

    # 3. One transaction: either everything is restored or nothing is.
    Invoke-Native $pgRestore ($connection + @("--username=$User", "--dbname=$TargetDatabase", '--single-transaction', '--exit-on-error', $File)) | Out-Null
} catch {
    if ($created) {
        Write-Warning "restore failed; dropping the new database $TargetDatabase"
        try {
            Invoke-Native $psql ($psqlCommon + @("--username=$AdminUser", "--dbname=$MaintenanceDatabase", "--set=db=$TargetDatabase")) 'DROP DATABASE :"db";' | Out-Null
        } catch {
            Write-Warning "could not drop $TargetDatabase; drop it by hand"
        }
    }
    throw
}

# 4. Statistics and verification -------------------------------------------------------------------------
$verify = @'
SELECT format('ANALYZE public.%I;', c.relname) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relkind = 'r' \gexec
SELECT 'schema version: ' || string_agg(version_num, ',') FROM alembic_version;
SELECT 'triggers: ' || string_agg(tgname || '=' || tgenabled::text, ', ' ORDER BY tgname) FROM pg_trigger WHERE NOT tgisinternal;
SELECT 'runtime role: ' || concat_ws(', ',
    'insert audit_logs=' || has_any_column_privilege(:'app', 'public.audit_logs', 'INSERT'),
    'update audit_logs=' || has_table_privilege(:'app', 'public.audit_logs', 'UPDATE'),
    'delete audit_logs=' || has_table_privilege(:'app', 'public.audit_logs', 'DELETE'),
    'update visits=' || has_table_privilege(:'app', 'public.visits', 'UPDATE'),
    'delete visits=' || has_table_privilege(:'app', 'public.visits', 'DELETE'),
    'temporary=' || has_database_privilege(:'app', current_database(), 'TEMPORARY'),
    'create in public=' || has_schema_privilege(:'app', 'public', 'CREATE'));
SELECT 'rows: ' || string_agg(c.relname || '=' || (xpath('/row/n/text()', query_to_xml(format('SELECT count(*) AS n FROM public.%I', c.relname), false, true, '')))[1]::text, ', ' ORDER BY c.relname)
FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relkind = 'r';
'@
$report = Invoke-Native $psql ($psqlCommon + @("--username=$User", "--dbname=$TargetDatabase", "--set=app=$AppRole")) $verify
$report = @($report | Where-Object { $_ -and $_.Trim() })
$report | ForEach-Object { Write-Output $_ }

$problems = @()
$triggers = ($report | Where-Object { $_ -like 'triggers:*' }) -join ''
foreach ($trigger in @('audit_logs_immutable=O', 'visits_terminal_immutable=O')) {
    if ($triggers -notlike "*$trigger*") { $problems += "trigger $trigger missing or disabled" }
}
$role = ($report | Where-Object { $_ -like 'runtime role:*' }) -join ''
$expectedRole = 'runtime role: insert audit_logs=true, update audit_logs=false, delete audit_logs=false, update visits=true, delete visits=false, temporary=false, create in public=false'
if ($role -ne $expectedRole) { $problems += "runtime role privileges differ from the migrations' grants: $role" }
if (-not ($report | Where-Object { $_ -like 'schema version: *' -and $_ -ne 'schema version: ' })) { $problems += 'no schema version' }
if ($problems.Count -gt 0) { throw "restored database $TargetDatabase failed verification (kept for inspection; do not use it): $($problems -join '; ')" }

$seconds = [math]::Round(((Get-Date) - $started).TotalSeconds, 1)
Write-Output "restored: $File -> $TargetDatabase on ${DbHost}:$Port in $seconds s (verified)"
