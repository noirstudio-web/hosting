param([switch]$SoloLocal)
# Noir Studio - Lanzador del hosting (servidor + tunel seguro HTTPS)

$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent $PSScriptRoot
Set-Location -LiteralPath $Root
try { $Host.UI.RawUI.WindowTitle = 'Noir Studio - Hosting' } catch {}
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

function Say([string]$Text, [string]$Color = 'Gray') { Write-Host "  $Text" -ForegroundColor $Color }
function Fail([string]$Text) { Write-Host ''; Say $Text 'Red'; Write-Host ''; Read-Host '  Pulsa Enter para salir' | Out-Null; exit 1 }

if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  # Node.js es necesario: se instala solo la primera vez (Windows puede pedir permiso de administrador).
  Say 'Node.js no esta instalado en este PC. Instalandolo (solo la primera vez, 1-3 minutos)...' 'Yellow'
  if (Get-Command winget -ErrorAction SilentlyContinue) {
    & winget install --id OpenJS.NodeJS.LTS -e --silent --accept-package-agreements --accept-source-agreements | Out-Host
  } else {
    try {
      $msi = Join-Path $env:TEMP 'node-lts-x64.msi'
      $ProgressPreference = 'SilentlyContinue'
      [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
      $index = Invoke-RestMethod 'https://nodejs.org/dist/index.json'
      $lts = ($index | Where-Object { $_.lts } | Select-Object -First 1).version
      Invoke-WebRequest -UseBasicParsing "https://nodejs.org/dist/$lts/node-$lts-x64.msi" -OutFile $msi
      Start-Process msiexec.exe -ArgumentList "/i `"$msi`" /qn" -Verb RunAs -Wait
    } catch { Say "No se pudo descargar Node.js: $($_.Exception.Message)" 'Red' }
  }
  $env:Path = [Environment]::GetEnvironmentVariable('Path', 'Machine') + ';' + [Environment]::GetEnvironmentVariable('Path', 'User')
  if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
    Fail 'No se pudo instalar Node.js automaticamente. Instalalo desde https://nodejs.org (boton LTS) y vuelve a abrir INICIAR.bat.'
  }
  Say "Node.js instalado ($(node -v))." 'Green'
}

# 1. Configuracion (los usuarios se crean desde el navegador en el primer inicio)
$cfgPath = Join-Path $Root 'config.json'
$cfg = $null
if (Test-Path -LiteralPath $cfgPath) { try { $cfg = Get-Content -LiteralPath $cfgPath -Raw | ConvertFrom-Json } catch {} }
$port = if ($cfg -and $cfg.port) { [int]$cfg.port } else { 8420 }
$repo = if ($cfg -and $cfg.githubRepo) { [string]$cfg.githubRepo } else { 'noirstudio-web/hosting' }
$owner, $repoName = $repo.Split('/')
$fixedLink = "https://$($owner.ToLower()).github.io/$repoName/"

# Guarda la direccion actual del tunel en GitHub para que el enlace fijo redirija a ella
function Publish-Link([string]$Url, [bool]$Online) {
  if (-not (Get-Command gh -ErrorAction SilentlyContinue)) { Say 'GitHub CLI no instalado: el enlace fijo no se actualizara.' 'Yellow'; return $false }
  $json = @{ url = $Url; online = $Online; updated = (Get-Date).ToUniversalTime().ToString('o') } | ConvertTo-Json -Compress
  $b64 = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($json))
  $prevEAP = $ErrorActionPreference; $ErrorActionPreference = 'Continue'
  try {
    $sha = gh api "repos/$repo/contents/docs/url.json" --jq .sha 2>$null
    $msg = if ($Online) { 'Hosting en linea' } else { 'Hosting apagado' }
    $ghArgs = @('api', '-X', 'PUT', "repos/$repo/contents/docs/url.json", '-f', "message=$msg", '-f', "content=$b64")
    if ($sha) { $ghArgs += @('-f', "sha=$sha") }
    gh @ghArgs 2>$null | Out-Null
    if ($LASTEXITCODE -eq 0) { return $true }
    if ($Online) { Say 'Enlace fijo no disponible (repositorio de GitHub sin crear). Usa la direccion de abajo.' 'Yellow' }
    return $false
  } finally { $ErrorActionPreference = $prevEAP }
}

# App para el PC de almacenamiento (se construye una sola vez)
if (-not (Test-Path -LiteralPath (Join-Path $Root 'bin\NoirAlmacenamiento.exe'))) {
  Say 'Preparando la app de almacenamiento (solo la primera vez, ~1 minuto)...' 'DarkGray'
  & node scripts\build-agent.cjs | Out-Null
}

# 2. Servidor + tunel seguro, vigilados por el supervisor:
#    si el tunel se corta (suspension, corte de internet) se vuelve a abrir solo y el enlace fijo se actualiza.
$cf = Join-Path $Root 'bin\cloudflared.exe'
Get-Process cloudflared -ErrorAction SilentlyContinue | Where-Object { $_.Path -eq $cf } | Stop-Process -Force -ErrorAction SilentlyContinue
$env:NOIR_HOME = $Root
$env:NOIR_DEV = '1'
if ($SoloLocal) { $env:NOIR_NO_TUNNEL = '1' }
Write-Host ''
Say "Enlace fijo: $fixedLink" 'Yellow'
Say 'Deja esta ventana abierta. El servidor y el tunel se reinician solos si fallan.' 'DarkGray'
Write-Host ''
& node app\main.js --run
