<?php
declare(strict_types=1);

/**
 * Shared helpers for the XAMPP local archive. No shell_exec. Paths stay
 * under STORE_ROOT. Mutating routes require X-SareChild-Storage-Key.
 */

const SARECHILD_STORE_NAME = 'store';
const SARECHILD_MAX_LIST = 500;
const SARECHILD_HEADER = 'HTTP_X_SARECHILD_STORAGE_KEY';

function sarechild_store_root(): string
{
    $root = realpath(__DIR__ . DIRECTORY_SEPARATOR . SARECHILD_STORE_NAME);
    if ($root === false) {
        $path = __DIR__ . DIRECTORY_SEPARATOR . SARECHILD_STORE_NAME;
        if (!is_dir($path) && !mkdir($path, 0775, true) && !is_dir($path)) {
            throw new RuntimeException('Could not create store directory.');
        }
        $root = realpath($path);
        if ($root === false) {
            throw new RuntimeException('Store directory is not resolvable.');
        }
    }
    return $root;
}

function sarechild_load_secret(): string
{
    $env = getenv('SARECHILD_STORAGE_SECRET');
    if (is_string($env) && $env !== '') {
        return trim($env);
    }
    $file = __DIR__ . DIRECTORY_SEPARATOR . '.secret';
    if (is_readable($file)) {
        return trim((string) file_get_contents($file));
    }
    return '';
}

function sarechild_json_exit(array $payload, int $status = 200): never
{
    http_response_code($status);
    header('Content-Type: application/json; charset=utf-8');
    header('Cache-Control: no-store');
    echo json_encode($payload, JSON_UNESCAPED_SLASHES);
    exit;
}

function sarechild_require_secret(): void
{
    $expected = sarechild_load_secret();
    if ($expected === '') {
        sarechild_json_exit(['ok' => false, 'error' => 'Storage secret is not configured on this PC.'], 503);
    }
    $got = '';
    if (!empty($_SERVER[SARECHILD_HEADER]) && is_string($_SERVER[SARECHILD_HEADER])) {
        $got = $_SERVER[SARECHILD_HEADER];
    } elseif (!empty($_SERVER['HTTP_AUTHORIZATION']) && is_string($_SERVER['HTTP_AUTHORIZATION'])) {
        if (preg_match('/^Bearer\s+(.+)$/i', $_SERVER['HTTP_AUTHORIZATION'], $m)) {
            $got = $m[1];
        }
    }
    if ($got === '' || !hash_equals($expected, $got)) {
        sarechild_json_exit(['ok' => false, 'error' => 'Unauthorized'], 401);
    }
}

function sarechild_dir_stats(string $root): array
{
    $bytes = 0;
    $files = 0;
    $folders = [];
    if (!is_dir($root)) {
        return ['bytes' => 0, 'files' => 0, 'folders' => []];
    }
    $iterator = new RecursiveIteratorIterator(
        new RecursiveDirectoryIterator($root, FilesystemIterator::SKIP_DOTS),
        RecursiveIteratorIterator::SELF_FIRST
    );
    foreach ($iterator as $item) {
        /** @var SplFileInfo $item */
        if ($item->isDir()) {
            $rel = substr($item->getPathname(), strlen($root) + 1);
            if ($rel !== false && $rel !== '') {
                $folders[] = str_replace('\\', '/', $rel);
            }
            continue;
        }
        if ($item->getFilename() === '.htaccess') {
            continue;
        }
        $bytes += $item->isFile() ? (int) $item->getSize() : 0;
        $files += 1;
    }
    sort($folders);
    return ['bytes' => $bytes, 'files' => $files, 'folders' => $folders];
}

function sarechild_health(): array
{
    $root = sarechild_store_root();
    $drive = strtoupper(substr($root, 0, 1)) . ':';
    $total = @disk_total_space($drive);
    $free = @disk_free_space($drive);
    $total = is_float($total) || is_int($total) ? (int) $total : 0;
    $free = is_float($free) || is_int($free) ? (int) $free : 0;
    $used = $total > 0 ? max(0, $total - $free) : 0;
    $percent = $total > 0 ? round(($used / $total) * 100, 1) : 0;
    $stats = sarechild_dir_stats($root);

    return [
        'ok' => true,
        'apache' => true,
        'php' => PHP_VERSION,
        'backend' => 'xampp-pc',
        'storePath' => $root,
        'appPath' => __DIR__,
        'folders' => $stats['folders'],
        'storeBytes' => $stats['bytes'],
        'storeFiles' => $stats['files'],
        'disk' => [
            'drive' => $drive,
            'usedBytes' => $used,
            'freeBytes' => $free,
            'totalBytes' => $total,
            'percent' => $percent,
        ],
        'roles' => [
            'ops-health',
            'local-archive',
            'optional-staging-mirror',
        ],
        'mediaNote' => 'This folder is a local archive on the Windows PC. Live child-device media still uploads to Cloudflare R2 and Firestore unless you copy files here.',
        'takenAtMs' => (int) round(microtime(true) * 1000),
    ];
}

function sarechild_safe_rel(string $rel): string
{
    $rel = str_replace('\\', '/', $rel);
    $rel = ltrim($rel, '/');
    if ($rel === '' || str_contains($rel, '..') || str_starts_with($rel, '/')) {
        throw new InvalidArgumentException('Invalid path.');
    }
    $root = sarechild_store_root();
    $full = $root . DIRECTORY_SEPARATOR . str_replace('/', DIRECTORY_SEPARATOR, $rel);
    $realRoot = $root;
    $parent = realpath(dirname($full));
    if ($parent === false || !str_starts_with($parent, $realRoot)) {
        throw new InvalidArgumentException('Path escapes the store sandbox.');
    }
    return $full;
}

function sarechild_list(): array
{
    $root = sarechild_store_root();
    $entries = [];
    $iterator = new RecursiveIteratorIterator(
        new RecursiveDirectoryIterator($root, FilesystemIterator::SKIP_DOTS)
    );
    foreach ($iterator as $item) {
        /** @var SplFileInfo $item */
        if (!$item->isFile() || $item->getFilename() === '.htaccess') {
            continue;
        }
        $rel = substr($item->getPathname(), strlen($root) + 1);
        $entries[] = [
            'path' => str_replace('\\', '/', (string) $rel),
            'bytes' => (int) $item->getSize(),
            'mtimeMs' => ((int) $item->getMTime()) * 1000,
        ];
        if (count($entries) >= SARECHILD_MAX_LIST) {
            break;
        }
    }
    usort($entries, static fn($a, $b) => $b['mtimeMs'] <=> $a['mtimeMs']);
    $stats = sarechild_dir_stats($root);
    return [
        'ok' => true,
        'truncated' => count($entries) >= SARECHILD_MAX_LIST,
        'files' => $entries,
        'storeBytes' => $stats['bytes'],
        'storeFiles' => $stats['files'],
        'storePath' => $root,
    ];
}

function sarechild_clear(): array
{
    $root = sarechild_store_root();
    $deleted = 0;
    $bytes = 0;
    $iterator = new RecursiveIteratorIterator(
        new RecursiveDirectoryIterator($root, FilesystemIterator::SKIP_DOTS),
        RecursiveIteratorIterator::CHILD_FIRST
    );
    foreach ($iterator as $item) {
        /** @var SplFileInfo $item */
        $name = $item->getFilename();
        if ($name === '.htaccess') {
            continue;
        }
        if ($item->isFile()) {
            $bytes += (int) $item->getSize();
            if (@unlink($item->getPathname())) {
                $deleted += 1;
            }
            continue;
        }
        if ($item->isDir()) {
            @rmdir($item->getPathname());
        }
    }
    return [
        'ok' => true,
        'deletedFiles' => $deleted,
        'deletedBytes' => $bytes,
        'storePath' => $root,
    ];
}
