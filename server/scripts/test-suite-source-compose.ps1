$ErrorActionPreference = 'Stop'
$root = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$emptyEnv = New-TemporaryFile
$synthetic = @{
    SESSION_SECRET = 'fixture-session-secret-not-for-production'
    ROBIN_ADMIN_ENCRYPTION_KEY = 'fixture-encryption-key-not-for-production'
    DB_PASSWORD = 'fixture-database-password'
    SUITE_LOG_MOUNT = (Join-Path $root 'fixture-suite-logs')
    ROBIN_ADMIN_PUBLIC_URL = 'https://admin.example.test'
    FLEET_AGENTS_BOOTSTRAP_JSON = ''
    FLEET_SERVICES_BOOTSTRAP_JSON = ''
    SUITE_AGENT_CREDENTIAL = ''
    SUITE_AGENT_ENROLLMENT_TOKEN = ''
    COMPOSE_PROFILES = ''
}
$previous = @{}
try {
    foreach ($key in $synthetic.Keys) {
        $previous[$key] = [Environment]::GetEnvironmentVariable($key)
        [Environment]::SetEnvironmentVariable($key, $synthetic[$key])
    }
    $files = @('-f', (Join-Path $root 'docker-compose.yaml'), '-f', (Join-Path $root 'docker-compose.suite-source.yaml'))
    foreach ($hostControl in @($false, $true)) {
        $argsForCompose = @('--env-file', $emptyEnv.FullName) + $files
        if ($hostControl) {
            $argsForCompose += @('-f', (Join-Path $root 'docker-compose.suite-source-host-control.yaml'))
        }
        $json = & docker compose @argsForCompose config --format json
        if ($LASTEXITCODE -ne 0) { throw 'Compose model validation failed' }
        $model = ($json -join "`n") | ConvertFrom-Json
        $admin = $model.services.'suite-admin'
        if ($admin.depends_on.'suite-admin-agent') { throw 'Admin must not depend on host control' }
        if ($admin.environment.NODE_ENV -ne 'production' -or $admin.environment.COOKIE_SECURE -ne 'true') {
            throw 'Local-source production defaults must remain secure'
        }
        if ($admin.image -ne 'robin-admin-server:local-source' -or !$admin.build.context) {
            throw 'Local source must not silently use the published Admin image'
        }
        if ($admin.environment.FLEET_AGENTS_BOOTSTRAP_JSON -ne '[]') { throw 'Unexpected automatic agent enrollment' }
        $fleet = $admin.environment.FLEET_SERVICES_BOOTSTRAP_JSON | ConvertFrom-Json
        foreach ($service in $fleet) {
            if ($service.agentId -or $service.configAgentId -or $service.logAgentId) {
                throw 'Default services must not reference an inactive agent'
            }
        }
        if ($model.services.'suite-admin-agent') { throw 'Host-control profile must remain inactive by default' }
    }
    $enabledArgs = $argsForCompose + @('--profile', 'host-control')
    $enabledJson = & docker compose @enabledArgs config --format json
    if ($LASTEXITCODE -ne 0) { throw 'Enabled host-control model validation failed' }
    $enabled = ($enabledJson -join "`n") | ConvertFrom-Json
    $agent = $enabled.services.'suite-admin-agent'
    if (!$agent -or $agent.profiles -notcontains 'host-control') { throw 'Host-control service must be explicitly profiled' }
    if (!($agent.volumes | Where-Object { $_.target -eq '/var/run/docker.sock' })) { throw 'Host-control trust boundary missing' }
    if ($agent.environment.ROBIN_AGENT_CREDENTIAL -ne '') { throw 'Inactive credentials must not be required' }
    Write-Output 'Passed: source-only, inactive host-control, and enabled host-control Compose models (no containers started).'
} finally {
    foreach ($key in $previous.Keys) {
        [Environment]::SetEnvironmentVariable($key, $previous[$key])
    }
    Remove-Item -LiteralPath $emptyEnv.FullName
}
