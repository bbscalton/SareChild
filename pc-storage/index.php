<?php
declare(strict_types=1);
require __DIR__ . '/lib.php';
$health = sarechild_health();
$accept = (string) ($_SERVER['HTTP_ACCEPT'] ?? '');
if (str_contains($accept, 'application/json') || isset($_GET['json'])) {
    sarechild_json_exit($health);
}
header('Content-Type: text/html; charset=utf-8');
$path = htmlspecialchars($health['storePath'], ENT_QUOTES, 'UTF-8');
$used = number_format((int) $health['disk']['usedBytes'] / (1024 * 1024 * 1024), 2);
$total = number_format((int) $health['disk']['totalBytes'] / (1024 * 1024 * 1024), 2);
$storeMb = number_format((int) $health['storeBytes'] / (1024 * 1024), 2);
?>
<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>SareChild PC storage (XAMPP)</title>
  <style>
    body { font: 16px/1.45 Segoe UI, sans-serif; max-width: 40rem; margin: 2rem auto; color: #10231a; }
    code { background: #eef4ef; padding: 0.1em 0.35em; border-radius: 4px; }
    .muted { color: #4d6358; }
  </style>
</head>
<body>
  <h1>This PC (XAMPP)</h1>
  <p>Local archive on this Windows machine. GitHub Pages TCD is HTTPS, so the browser cannot call this HTTP page (mixed content). Cloud Functions reach it only through a Cloudflare Tunnel or port-forward.</p>
  <ul>
    <li>Store folder: <code><?= $path ?></code></li>
    <li>Archive used: <?= $storeMb ?> MB (<?= (int) $health['storeFiles'] ?> files)</li>
    <li>Drive <?= htmlspecialchars($health['disk']['drive'], ENT_QUOTES, 'UTF-8') ?>: <?= $used ?> / <?= $total ?> GB</li>
    <li>Health JSON: <a href="health.json">health.json</a></li>
  </ul>
  <p class="muted"><?= htmlspecialchars($health['mediaNote'], ENT_QUOTES, 'UTF-8') ?></p>
</body>
</html>
