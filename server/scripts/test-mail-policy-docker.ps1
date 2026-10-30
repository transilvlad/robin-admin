param(
  [Parameter(Mandatory = $true)][string]$MigrationPath
)
$ErrorActionPreference = 'Stop'
$migration = (Resolve-Path -LiteralPath $MigrationPath).Path
$suffix = [guid]::NewGuid().ToString('N').Substring(0, 12)
$container = "robin-admin-policy-test-$suffix"
$database = "robin_admin_policy_test_$suffix"
$serverRoot = Split-Path $PSScriptRoot -Parent
$keys = @('DB_HOST', 'DB_PORT', 'DB_NAME', 'DB_USER', 'DB_PASSWORD', 'MAIL_POLICY_IT_DB')
$previous = @{}
$created = $false
foreach ($key in $keys) { $previous[$key] = [Environment]::GetEnvironmentVariable($key, 'Process') }

function Assert-NativeSuccess([string]$operation) {
  if ($LASTEXITCODE -ne 0) { throw "$operation failed (exit $LASTEXITCODE)" }
}

try {
  docker run --detach --pull never --name $container --memory 256m --cpus 1 `
    --publish 127.0.0.1::5432 --env POSTGRES_USER=fixture `
    --env POSTGRES_PASSWORD=synthetic-fixture-password --env "POSTGRES_DB=$database" postgres:18-alpine | Out-Null
  Assert-NativeSuccess 'Start isolated PostgreSQL'
  $created = $true
  $ready = $false
  for ($attempt = 0; $attempt -lt 60; $attempt++) {
    docker exec $container pg_isready -U fixture -d $database *> $null
    if ($LASTEXITCODE -eq 0) { $ready = $true; break }
    Start-Sleep -Seconds 1
  }
  if (!$ready) { throw 'Isolated PostgreSQL did not become ready' }
  docker cp "$serverRoot\tests\fixtures\mail-policy.sql" "${container}:/tmp/fixture.sql"
  Assert-NativeSuccess 'Copy fixture'
  docker cp $migration "${container}:/tmp/migration.sql"
  Assert-NativeSuccess 'Copy suite migration'
  docker exec $container psql -v ON_ERROR_STOP=1 -U fixture -d $database -f /tmp/fixture.sql
  Assert-NativeSuccess 'Initialize fixture'
  docker exec $container psql -v ON_ERROR_STOP=1 -U fixture -d $database -f /tmp/migration.sql
  Assert-NativeSuccess 'Apply actual suite migration'
  $binding = docker inspect --format '{{(index (index .NetworkSettings.Ports "5432/tcp") 0).HostPort}}' $container
  Assert-NativeSuccess 'Read isolated port'
  $env:DB_HOST = '127.0.0.1'
  $env:DB_PORT = $binding.Trim()
  $env:DB_NAME = $database
  $env:DB_USER = 'fixture'
  $env:DB_PASSWORD = 'synthetic-fixture-password'
  $env:MAIL_POLICY_IT_DB = '1'
  Push-Location $serverRoot
  try {
    npm test -- src/db/queries/mail-policy.integration.test.ts
    Assert-NativeSuccess 'Mail policy integration tests'
  } finally { Pop-Location }
  Write-Output "PASS: actual suite migration and Admin queries on isolated PostgreSQL ($container, loopback port $binding)"
} finally {
  foreach ($key in $keys) { [Environment]::SetEnvironmentVariable($key, $previous[$key], 'Process') }
  if ($created) { docker rm --force --volumes $container | Out-Null }
}
