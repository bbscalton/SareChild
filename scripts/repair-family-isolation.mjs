/**
 * Audits and repairs parentProfiles that point at a family the uid does not own
 * or belong to as guardian. Keeps neuereatec@gmail.com on family tS2mTEiFqoY76nq7ei1d.
 *
 * Usage:
 *   node scripts/repair-family-isolation.mjs
 *   node scripts/repair-family-isolation.mjs --apply
 */
import admin from "firebase-admin";

const PROJECT_ID = "safechild-f34ac";
const APPLY = process.argv.includes("--apply");
const PROTECTED_FAMILY_ID = "tS2mTEiFqoY76nq7ei1d";
const PROTECTED_OWNER_EMAIL = "neuereatec@gmail.com";

admin.initializeApp({ projectId: PROJECT_ID });
const db = admin.firestore();

async function verifyAccess(uid, familyId) {
  if (!familyId) return false;
  const [guardian, family] = await Promise.all([
    db.collection("families").doc(familyId).collection("guardians").doc(uid).get(),
    db.collection("families").doc(familyId).get(),
  ]);
  if (guardian.exists) return true;
  return family.exists && family.get("parentUid") === uid;
}

async function bootstrapFamily(uid, email, preserve = {}) {
  const now = Date.now();
  const familyRef = db.collection("families").doc();
  await familyRef.set({
    parentUid: uid,
    createdAtMs: now,
    parentEmail: email,
  });
  await familyRef.collection("guardians").doc(uid).set({
    email,
    role: "OWNER",
    joinedAtMs: now,
  });
  await db.collection("parentProfiles").doc(uid).set(
    {
      familyId: familyRef.id,
      ownedFamilyId: familyRef.id,
      email,
      repairedAtMs: now,
      ...preserve,
    },
    { merge: true },
  );
  return familyRef.id;
}

const profiles = await db.collection("parentProfiles").get();
console.log(`[repair] scanning ${profiles.size} parentProfiles (apply=${APPLY})`);

for (const doc of profiles.docs) {
  const uid = doc.id;
  const data = doc.data();
  const email = String(data.email ?? "");
  const familyId = data.familyId ?? null;

  if (email.toLowerCase() === PROTECTED_OWNER_EMAIL && familyId === PROTECTED_FAMILY_ID) {
    console.log(`[ok] protected owner ${email} stays on ${familyId}`);
    continue;
  }

  const allowed = await verifyAccess(uid, familyId);
  if (allowed) {
    if (!data.ownedFamilyId && familyId) {
      const family = await db.collection("families").doc(familyId).get();
      if (family.get("parentUid") === uid) {
        console.log(`[fix-owned] ${email || uid} add ownedFamilyId=${familyId}`);
        if (APPLY) {
          await doc.ref.set({ ownedFamilyId: familyId }, { merge: true });
        }
      }
    }
    continue;
  }

  console.log(
    `[split] ${email || uid} had familyId=${familyId ?? "none"} without guardian/owner access`,
  );

  if (familyId === PROTECTED_FAMILY_ID && email.toLowerCase() !== PROTECTED_OWNER_EMAIL) {
    const strayGuardian = await db
      .collection("families")
      .doc(PROTECTED_FAMILY_ID)
      .collection("guardians")
      .doc(uid)
      .get();
    if (strayGuardian.exists) {
      console.log(`[remove-guardian] orphan guardian ${uid} on protected family`);
      if (APPLY) await strayGuardian.ref.delete();
    }
  }

  if (APPLY) {
    const newFamilyId = await bootstrapFamily(uid, email, {
      plan: data.plan,
      status: data.status,
      trialStartedAt: data.trialStartedAt,
      trialEndsAt: data.trialEndsAt,
      tosAcceptedAt: data.tosAcceptedAt,
      tosVersion: data.tosVersion,
      privacyAcceptedAt: data.privacyAcceptedAt,
      registeredAt: data.registeredAt ?? data.createdAtMs,
      createdAtMs: data.createdAtMs,
    });
    console.log(`[split-applied] ${email || uid} -> new family ${newFamilyId}`);
  }
}

console.log("[repair] done");
