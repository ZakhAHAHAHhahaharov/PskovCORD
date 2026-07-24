# Нативный запуск SFU под Windows (без Docker), как start-native.ps1 для бэка.
# Читает SFU_* переменные из ../.env (если есть), иначе — dev-значения по умолчанию.
# Использование:  ./run-native.ps1   (из каталога sfu/)

$ErrorActionPreference = 'Stop'

# --- подхватить SFU_* / *_SECRET из корневого .env ---
$envFile = Join-Path $PSScriptRoot '..\.env'
if (Test-Path $envFile) {
    Get-Content $envFile | ForEach-Object {
        if ($_ -match '^\s*([A-Z0-9_]+)\s*=\s*(.*)$') {
            $name = $matches[1]
            $value = $matches[2].Trim()
            if ($name -like 'SFU_*') {
                [Environment]::SetEnvironmentVariable($name, $value, 'Process')
            }
        }
    }
}

# Дефолты для локали, если в .env не заданы.
if (-not $env:SFU_LISTEN_PORT)   { $env:SFU_LISTEN_PORT   = '4443' }
if (-not $env:SFU_SECRET)        { $env:SFU_SECRET        = 'dev-insecure-sfu-secret' }
if (-not $env:SFU_ANNOUNCED_IP)  { $env:SFU_ANNOUNCED_IP  = '127.0.0.1' }
if (-not $env:SFU_RTC_MIN_PORT)  { $env:SFU_RTC_MIN_PORT  = '40000' }
if (-not $env:SFU_RTC_MAX_PORT)  { $env:SFU_RTC_MAX_PORT  = '40100' }

Write-Host "[sfu] SFU_ANNOUNCED_IP=$($env:SFU_ANNOUNCED_IP) port=$($env:SFU_LISTEN_PORT) rtc=$($env:SFU_RTC_MIN_PORT)-$($env:SFU_RTC_MAX_PORT)"

if (-not (Test-Path (Join-Path $PSScriptRoot 'node_modules'))) {
    Write-Host '[sfu] npm install...'
    npm install
}

# Собрать при отсутствии dist и запустить.
if (-not (Test-Path (Join-Path $PSScriptRoot 'dist'))) {
    Write-Host '[sfu] npm run build...'
    npm run build
}

node dist/index.js
