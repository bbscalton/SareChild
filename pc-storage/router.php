<?php
declare(strict_types=1);

/**
 * Router for `php -S 127.0.0.1:8787 router.php` (Cloudflare Tunnel origin).
 * Apache uses .htaccess instead; this file blocks secrets if the built-in server is used.
 */
$uri = parse_url($_SERVER['REQUEST_URI'] ?? '/', PHP_URL_PATH) ?: '/';
$uri = '/' . ltrim($uri, '/');
$blocked = ['/.secret', '/secret.php', '/lib.php', '/router.php', '/.htaccess'];
foreach ($blocked as $b) {
    if (strcasecmp($uri, $b) === 0 || str_ends_with(strtolower($uri), $b)) {
        http_response_code(404);
        header('Content-Type: text/plain');
        echo 'Not found';
        return true;
    }
}
if ($uri === '/health.json' || $uri === '/') {
    require __DIR__ . '/health.php';
    return true;
}
$file = __DIR__ . str_replace('/', DIRECTORY_SEPARATOR, $uri);
if (is_file($file)) {
    return false;
}
return false;
