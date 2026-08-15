<?php
declare(strict_types=1);
require __DIR__ . '/lib.php';

$action = (string) ($_GET['action'] ?? $_POST['action'] ?? '');
$method = strtoupper((string) ($_SERVER['REQUEST_METHOD'] ?? 'GET'));

if ($action === '' || $action === 'health') {
    sarechild_json_exit(sarechild_health());
}

sarechild_require_secret();

if ($action === 'list') {
    sarechild_json_exit(sarechild_list());
}

if ($action === 'clear') {
    if ($method !== 'POST') {
        sarechild_json_exit(['ok' => false, 'error' => 'Use POST to clear the local store.'], 405);
    }
    $confirm = (string) ($_POST['confirm'] ?? $_GET['confirm'] ?? '');
    $raw = file_get_contents('php://input') ?: '';
    if ($raw !== '') {
        $json = json_decode($raw, true);
        if (is_array($json) && isset($json['confirm'])) {
            $confirm = (string) $json['confirm'];
        }
    }
    if ($confirm !== 'CLEAR-PC-STORE') {
        sarechild_json_exit(['ok' => false, 'error' => 'Type CLEAR-PC-STORE to confirm.'], 412);
    }
    sarechild_json_exit(sarechild_clear());
}

sarechild_json_exit(['ok' => false, 'error' => 'Unknown action.'], 400);
