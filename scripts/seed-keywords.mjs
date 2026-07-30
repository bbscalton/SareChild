/**
 * One-time seed: keywordLists/default
 * Run from project root after: firebase login
 *   node scripts/seed-keywords.mjs
 */
import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import admin from "firebase-admin";

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectId = "safechild-f34ac";
const data = JSON.parse(
  readFileSync(join(__dirname, "..", "keywordLists.default.json"), "utf8")
);

admin.initializeApp({ projectId });
const db = admin.firestore();

await db.collection("keywordLists").doc("default").set(data);
console.log("Seeded keywordLists/default successfully.");
process.exit(0);
