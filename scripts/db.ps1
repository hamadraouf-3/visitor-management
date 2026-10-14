<#
.SYNOPSIS
  Manage the portable local PostgreSQL cluster used for development and tests.

.DESCRIPTION
  Uses the PostgreSQL binaries in .local/pgsql (gitignored) and keeps data in .local/pgdata.
  Nothing is installed system-wide and no Windows service is registered; deleting .local removes it all.

  Usage:
    ./scripts/db.ps1 init     # one-time: initdb + create app role and databases (vms, vms_test)
    ./scripts/db.ps1 start
    ./scripts/db.ps1 stop
    ./scripts/db.ps1 status
    ./scripts/db.ps1 psql     # interactive psql against the dev database

  Two login roles are created (see docs/security.md):
    vms_owner  owns the schema; used only for migrations and by the test harness to create/drop databases
    vms_app    runtime role used by the application: DML on business tables, INSERT/SELECT only on audit_logs,
               no DDL (no CREATE on schema public, no TEMPORARY on the databases)
  Local-only defaults can be overridden with VMS_PG_PORT (5433), VMS_PG_OWNER_PASSWORD, VMS_PG_APP_PASSWORD.
  The cluster uses the builtin C.UTF-8 locale so lower()/ILIKE fold non-ASCII (accented Latin, Arabic) correctly.
#>
param(
    [Parameter(Mandatory = $true, Position = 0)]
    [ValidateSet('init', 'start', 'stop', 'status', 'psql')]
    [string]$Command
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$pgBin = Join-Path $root '.local\pgsql\bin'
$pgData = Join-Path $root '.local\pgdata'
$pgLog = Join-Path $root '.local\postgres.log'

$port = if ($env:VMS_PG_PORT) { $env:VMS_PG_PORT } else { '5433' }
$superPassword = if ($env:VMS_PG_SUPER_PASSWORD) { $env:VMS_PG_SUPER_PASSWORD } else { 'postgres_local_dev' }
$ownerPassword = if ($env:VMS_PG_OWNER_PASSWORD) { $env:VMS_PG_OWNER_PASSWORD } else { 'vms_owner_local_dev' }
$appPassword = if ($env:VMS_PG_APP_PASSWORD) { $env:VMS_PG_APP_PASSWORD } else { 'vms_app_local_dev' }

if (-not (Test-Path (Join-Path $pgBin 'pg_ctl.exe'))) {
    throw "PostgreSQL binaries not found in $pgBin. See docs/development.md for how to download them."
}

function Invoke-Pg([string]$exe, [string[]]$pgArgs) {
    & (Join-Path $pgBin $exe) @pgArgs
    if ($LASTEXITCODE -ne 0) { throw "$exe exited with code $LASTEXITCODE" }
}

function Test-Running {
    & (Join-Path $pgBin 'pg_ctl.exe') status -D $pgData *> $null
    return ($LASTEXITCODE -eq 0)
}

function Start-Cluster {
    if (Test-Running) { Write-Host "PostgreSQL already running on port $port"; return }
    # Start-Process (no output capture) so the long-lived postmaster does not inherit this shell's
    # stdout/stderr pipes; inheriting them makes callers that capture output wait forever.
    $p = Start-Process -FilePath (Join-Path $pgBin 'pg_ctl.exe') `
        -ArgumentList @('start', '-D', "`"$pgData`"", '-l', "`"$pgLog`"", '-w', '-o', "`"-p $port`"") `
        -WindowStyle Hidden -PassThru
    # WaitForExit() waits for pg_ctl only; Start-Process -Wait would also wait for the postmaster child.
    $p.WaitForExit()
    if ($p.ExitCode -ne 0) { throw "pg_ctl start failed (exit $($p.ExitCode)); see $pgLog" }
    Write-Host "PostgreSQL started on port $port"
}

switch ($Command) {
    'init' {
        if (Test-Path (Join-Path $pgData 'PG_VERSION')) {
            Write-Host "Cluster already initialized at $pgData"
        } else {
            $pwFile = Join-Path $env:TEMP "vms-pg-init-$PID.txt"
            Set-Content -Path $pwFile -Value $superPassword -NoNewline -Encoding ascii
            try {
                Invoke-Pg 'initdb.exe' @('-D', $pgData, '-U', 'postgres', '--auth=scram-sha-256', "--pwfile=$pwFile", '-E', 'UTF8',
                    '--locale-provider=builtin', '--builtin-locale=C.UTF-8', '--locale=C', '--lc-ctype=en-US')
            } finally {
                Remove-Item $pwFile -Force -ErrorAction SilentlyContinue
            }
            # Business timestamps are UTC end to end; never let a naive value be read in a local zone.
            Add-Content -Path (Join-Path $pgData 'postgresql.conf') -Value "`ntimezone = 'UTC'`nlog_timezone = 'UTC'"
        }
        Start-Cluster
        $env:PGPASSWORD = $superPassword
        $psql = Join-Path $pgBin 'psql.exe'
        $roles = @(
            @{ Name = 'vms_owner'; Password = $ownerPassword; Attrs = 'LOGIN CREATEDB' },
            @{ Name = 'vms_app'; Password = $appPassword; Attrs = 'LOGIN' }
        )
        foreach ($r in $roles) {
            $exists = & $psql -h localhost -p $port -U postgres -d postgres -tAc "SELECT 1 FROM pg_roles WHERE rolname='$($r.Name)'"
            if ($exists -ne '1') {
                Invoke-Pg 'psql.exe' @('-h', 'localhost', '-p', $port, '-U', 'postgres', '-d', 'postgres', '-v', 'ON_ERROR_STOP=1', '-c', "CREATE ROLE $($r.Name) $($r.Attrs) PASSWORD '$($r.Password)'")
                Write-Host "Created role $($r.Name)"
            }
        }
        # vms_owner may hand its databases' privileges to vms_app (needed by tests that create databases on the fly).
        Invoke-Pg 'psql.exe' @('-h', 'localhost', '-p', $port, '-U', 'postgres', '-d', 'postgres', '-v', 'ON_ERROR_STOP=1', '-c', 'GRANT vms_app TO vms_owner')
        foreach ($db in @('vms', 'vms_e2e')) {
            $dbExists = & $psql -h localhost -p $port -U postgres -d postgres -tAc "SELECT 1 FROM pg_database WHERE datname='$db'"
            if ($dbExists -ne '1') {
                Invoke-Pg 'psql.exe' @('-h', 'localhost', '-p', $port, '-U', 'postgres', '-d', 'postgres', '-v', 'ON_ERROR_STOP=1', '-c', "CREATE DATABASE $db OWNER vms_owner")
                Write-Host "Created database $db"
            }
            # No DDL for the runtime role: revoke what PUBLIC is granted by default (CREATE on schema public
            # before PostgreSQL 15, TEMPORARY on every database). Idempotent: re-running init applies it.
            Invoke-Pg 'psql.exe' @('-h', 'localhost', '-p', $port, '-U', 'postgres', '-d', $db, '-v', 'ON_ERROR_STOP=1', '-c', "REVOKE CREATE ON SCHEMA public FROM PUBLIC; REVOKE TEMPORARY ON DATABASE $db FROM PUBLIC; ALTER SCHEMA public OWNER TO vms_owner; GRANT USAGE ON SCHEMA public TO vms_app")
        }
        Write-Host "Ready on port ${port}: databases vms (dev) and vms_e2e (Playwright); tests create throwaway databases as vms_owner."
    }
    'start' { Start-Cluster }
    'stop' {
        if (Test-Running) { Invoke-Pg 'pg_ctl.exe' @('stop', '-D', $pgData, '-m', 'fast', '-w') } else { Write-Host 'PostgreSQL is not running' }
    }
    'status' {
        if (Test-Running) { Write-Host "PostgreSQL running on port $port (data: $pgData)" } else { Write-Host 'PostgreSQL is not running'; exit 1 }
    }
    'psql' {
        $env:PGPASSWORD = $ownerPassword
        & (Join-Path $pgBin 'psql.exe') -h localhost -p $port -U vms_owner -d vms
    }
}
