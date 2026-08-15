# Start the local PHP origin used by Cloudflare Tunnel (port 8787, storage app only).
$ErrorActionPreference = "Stop"
$php = "C:\xampp2\php\php.exe"
$root = "C:\xampp2\htdocs\sarechild-storage"
$listening = Get-NetTCPConnection -LocalPort 8787 -State Listen -ErrorAction SilentlyContinue
if (-not $listening) {
  Start-Process -FilePath $php -ArgumentList @("-S","127.0.0.1:8787","-t",$root,(Join-Path $root "router.php")) -WindowStyle Hidden
}
Write-Host "PHP origin http://127.0.0.1:8787/health.json"
Write-Host "Named tunnel config: C:\Users\Administrator\.cloudflared\sarechild-xampp.yml (add a Zero Trust public hostname for a stable URL)."
Write-Host "Local Apache: http://127.0.0.1/sarechild-storage/health.json"
