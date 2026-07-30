/**
 * Manual/backup runner for the trial auto-cleanup rule that normally runs as the
 * `purgeInactiveTrials` Cloud Function (functions/src/index.ts) every 24 hours.
 *
 * Use this when you want to dry-run the purge locally, audit what *would* be purged,
 * or re-run cleanup manually (e.g. the day after re-enabling Cloud Functions billing).
 * It uses the same decision logic as the Cloud Function so results match exactly.
 *
 * Auth: uses Application Default Credentials — run `gcloud auth application-default
 * login` once, or set GOOGLE_APPLICATION_CREDENTIALS to a service account JSON path
 * (never commit that file). Requires Firestore + Firebase Auth admin access on
 * safechild-f34ac.
 *
 * Usage:
 *   node scripts/purge-inactive-trials.mjs            # dry run, prints decisions only
 *   node scripts/purge-inactive-trials.mjs --apply     # actually warn/purge accounts
 */
import admin from "firebase-admin";

const PROJECT_ID = "safechild-f34ac";
const TRIAL_DAYS = 30;
const CHECK_IN_STALE_DAYS = 7;
const INACTIVITY_GRACE_DAYS = 3;
const DAY_MS = 24 * 60 * 60 * 1000;

const APPLY = process.argv.includes("--apply");

admin.initializeApp({ projectId: PROJECT_ID });
const db = admin.firestore();

const FAMILY_SUBCOLLECTIONS = [
  "devices",
  "alerts",
  "familyChat",
  "geofences",
  "commands",
  "appEvents",
  "usageDaily",
  "locationTrail",
  "callSmsPreviews",
  "digests",
  "sosContacts",
  "safeContacts",
  "safetySettings",
  "appLimits",
  "appBlockSchedules",
  "screenShareSchedules",
  "guardians",
];

/** Mirrors decideTrialFate() in functions/src/index.ts — keep these two in sync. */
function decideTrialFate(now, data) {
  if (data.plan !== "trial") return "keep";
  if (data.status === "purged") return "keep";

  const trialStartedAt = Number(data.trialStartedAt ?? now);
  const trialEndsAt = Number(data.trialEndsAt ?? trialStartedAt + TRIAL_DAYS * DAY_MS);
  const lastLoginAt = data.lastLoginAt ? Number(data.lastLoginAt) : null;
  const lastCheckInAt = data.lastParentCheckInAt ? Number(data.lastParentCheckInAt) : null;

  if (now > trialEndsAt) return "purge";

  const neverLoggedBackIn = !lastLoginAt || now - trialStartedAt > TRIAL_DAYS * DAY_MS;
  const loginStale = lastLoginAt != null && now - lastLoginAt > TRIAL_DAYS * DAY_MS;
  const checkInStale = !lastCheckInAt || now - lastCheckInAt > CHECK_IN_STALE_DAYS * DAY_MS;
  const inactive = (neverLoggedBackIn || loginStale) && checkInStale;
  if (!inactive) return "keep";

  const warnedAt = data.purgeWarnedAt ? Number(data.purgeWarnedAt) : null;
  if (warnedAt && now - warnedAt > INACTIVITY_GRACE_DAYS * DAY_MS) return "purge";
  return "warn";
}

async function deleteCollectionRecursive(ref, batchSize = 200) {
  for (;;) {
    const snap = await ref.limit(batchSize).get();
    if (snap.empty) return;
    const batch = db.batch();
    snap.docs.forEach((d) => batch.delete(d.ref));
    await batch.commit();
    if (snap.size < batchSize) return;
  }
}

async function deleteFamilyDeep(familyId) {
  const familyRef = db.collection("families").doc(familyId);
  for (const sub of FAMILY_SUBCOLLECTIONS) {
    await deleteCollectionRecursive(familyRef.collection(sub));
  }
  await familyRef.delete();
}

const now = Date.now();
const profiles = await db.collection("parentProfiles").where("plan", "==", "trial").get();

let warned = 0;
let purged = 0;
let kept = 0;

for (const profile of profiles.docs) {
  const data = profile.data();
  const decision = decideTrialFate(now, data);
  const uid = profile.id;

  if (decision === "keep") {
    kept++;
    continue;
  }

  if (decision === "warn") {
    console.log(`[warn]  ${uid} (${data.email ?? "no-email"}) — inactive, entering grace period`);
    if (APPLY && !data.purgeWarnedAt) {
      await profile.ref.set({ status: "at_risk", purgeWarnedAt: now }, { merge: true });
    }
    warned++;
    continue;
  }

  console.log(`[purge] ${uid} (${data.email ?? "no-email"}) — familyId=${data.familyId ?? "none"}`);
  if (APPLY) {
    const familyId = data.familyId;
    try {
      if (familyId) {
        const familySnap = await db.collection("families").doc(familyId).get();
        if (familySnap.exists && familySnap.get("parentUid") === uid) {
          await deleteFamilyDeep(familyId);
        } else {
          await db.collection("families").doc(familyId).collection("guardians").doc(uid).delete().catch(() => {});
        }
      }
      await admin.auth().deleteUser(uid).catch((err) => console.warn(`  auth delete failed: ${err.message}`));
      await profile.ref.set({ status: "purged", plan: "trial", purgedAtMs: now }, { merge: false });
    } catch (err) {
      console.error(`  FAILED to purge ${uid}:`, err);
    }
  }
  purged++;
}

console.log(
  `\n${APPLY ? "Applied" : "Dry run"}: scanned=${profiles.size} kept=${kept} warned=${warned} purged=${purged}`,
);
if (!APPLY) {
  console.log("Re-run with --apply to actually warn/purge the accounts listed above.");
}
process.exit(0);
