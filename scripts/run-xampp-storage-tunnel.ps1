# Run the dedicated sarechild-xampp tunnel (does not replace the existing `net` Windows service).
$ErrorActionPreference = "Stop"
$cf = "C:\Program Files (x86)\cloudflared\cloudflared.exe"
$cfg = "C:\Users\Administrator\.cloudflared\sarechild-xampp.yml"
& $cf tunnel --config $cfg --no-autoupdate run
