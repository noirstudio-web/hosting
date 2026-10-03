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
  Fail 'Node.js no esta instalado. Descargalo en https://nodejs.org (version LTS) y vuelve a abrir INICIAR.'
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

# 2. Tunel seguro (Cloudflare) para acceder desde otro computador por internet
$tunnel = $null
$publicUrl = $null
if (-not $SoloLocal) {
  $bin = Join-Path $Root 'bin'
  $cf = Join-Path $bin 'cloudflared.exe'
  if (-not (Test-Path -LiteralPath $cf)) {
    New-Item -ItemType Directory -Force -Path $bin | Out-Null
    Say 'Descargando el tunel seguro (cloudflared, solo la primera vez)...' 'DarkGray'
    try {
      [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
      $ProgressPreference = 'SilentlyContinue'
      Invoke-WebRequest -UseBasicParsing -Uri 'https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-windows-amd64.exe' -OutFile $cf
    } catch {
      Remove-Item -LiteralPath $cf -ErrorAction SilentlyContinue
      Fail "No se pudo descargar cloudflared: $($_.Exception.Message)"
    }
  }

  # Cierra tuneles anteriores de este hosting que hayan quedado abiertos
  Get-Process cloudflared -ErrorAction SilentlyContinue | Where-Object { $_.Path -eq $cf } | Stop-Process -Force -ErrorAction SilentlyContinue

  $logErr = Join-Path $bin 'tunnel.log'
  $logOut = Join-Path $bin 'tunnel.out.log'
  for ($attempt = 1; $attempt -le 3 -and -not $publicUrl; $attempt++) {
    if ($tunnel -and -not $tunnel.HasExited) { Stop-Process -Id $tunnel.Id -Force -ErrorAction SilentlyContinue }
    Remove-Item -LiteralPath $logErr, $logOut -ErrorAction SilentlyContinue
    Say "Abriendo tunel seguro HTTPS... (intento $attempt de 3)" 'DarkGray'
    $tunnel = Start-Process -FilePath $cf -ArgumentList @('tunnel', '--no-autoupdate', '--url', "http://127.0.0.1:$port") `
      -RedirectStandardError $logErr -RedirectStandardOutput $logOut -NoNewWindow -PassThru

    $deadline = (Get-Date).AddSeconds(40)
    while (-not $publicUrl -and (Get-Date) -lt $deadline -and -not $tunnel.HasExited) {
      Start-Sleep -Milliseconds 500
      if (Test-Path -LiteralPath $logErr) {
        try {
          $fs = [System.IO.File]::Open($logErr, 'Open', 'Read', 'ReadWrite')
          $text = (New-Object System.IO.StreamReader($fs)).ReadToEnd()
          $fs.Close()
          $m = [regex]::Match($text, 'https://(?!api\.)[a-z0-9-]+\.trycloudflare\.com')
          if ($m.Success) { $publicUrl = $m.Value }
        } catch {}
      }
    }
    if (-not $publicUrl) { Start-Sleep -Seconds 2 }
  }

  if ($publicUrl) {
    try { Set-Clipboard -Value $publicUrl } catch {}
    $linked = Publish-Link $publicUrl $true
  } else {
    Say 'No se pudo abrir el tunel a internet (revisa tu conexion). El hosting funcionara solo en la red local.' 'Yellow'
    Say "Detalles en: $logErr" 'DarkGray'
  }
}

# 3. Servidor
$env:NOIR_PUBLIC_URL = $publicUrl
if ($linked) { $env:NOIR_FIXED_URL = $fixedLink }
try {
  # Si el servidor se cae, se reinicia solo. Si falla 5 veces seguidas en menos de 15 s cada una, se rinde.
  $quickFails = 0
  do {
    $started = Get-Date
    & node server.js
    $code = $LASTEXITCODE
    if ($code -ne 0) {
      if (((Get-Date) - $started).TotalSeconds -lt 15) { $quickFails++ } else { $quickFails = 0 }
      if ($quickFails -ge 5) { Say 'El servidor no logra arrancar. Revisa los mensajes de arriba.' 'Red'; Read-Host '  Pulsa Enter para salir' | Out-Null; break }
      Say "El servidor se detuvo (codigo $code). Reiniciando en 3 segundos..." 'Yellow'
      Start-Sleep -Seconds 3
    }
  } while ($code -ne 0)
} finally {
  if ($tunnel -and -not $tunnel.HasExited) { Stop-Process -Id $tunnel.Id -Force -ErrorAction SilentlyContinue }
  if ($linked) { Publish-Link $publicUrl $false | Out-Null }
}
