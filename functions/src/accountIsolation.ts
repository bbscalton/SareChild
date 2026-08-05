import * as admin from "firebase-admin";
import { onCall, HttpsError } from "firebase-functions/v2/https";
import { logger } from "firebase-functions";
import {
  assertProjectAdmin,
  createFreshFamilyForUser,
  writeAuditLog,
} from "./admin";

if (!admin.apps.length) {
  admin.initializeApp();
}

const db = admin.firestore();

/**
 * Shared legitimacy check for family membership.
 *
 * Legitimate if:
 *  - families/{familyId}.parentUid === uid (true owner), OR
 *  - non-OWNER guardian with a claimed guardianInvites row
 *    (familyId + claimedByUid == uid)
 *
 * Illegitimate (2026-08-05 exploit pattern):
 *  - guardians/{uid} with role OWNER when user is not parentUid
 *  - caregiver guardian with no matching claimed invite
 *  - no guardian doc and not owner
 */
export async function isLegitimateFamilyAccess(
  uid: string,
  familyId: string
): Promise<{ legitimate: boolean; reason: string }> {
  const familySnap = await db.collection("families").doc(familyId).get();
  if (!familySnap.exists) {
    return { legitimate: false, reason: "family_missing" };
  }
  const parentUid = familySnap.get("parentUid") as string | undefined;
  if (parentUid === uid) {
    return { legitimate: true, reason: "owner" };
  }

  const guardianSnap = await db
    .collection("families")
    .doc(familyId)
    .collection("guardians")
    .doc(uid)
    .get();
  if (!guardianSnap.exists) {
    return { legitimate: false, reason: "no_guardian_and_not_owner" };
  }

  const role = String(guardianSnap.get("role") ?? "").toUpperCase();
  if (role === "OWNER") {
    return { legitimate: false, reason: "rogue_owner_guardian" };
  }

  const inviteSnap = await db
    .collection("guardianInvites")
    .where("familyId", "==", familyId)
    .where("claimedByUid", "==", uid)
    .limit(1)
    .get();
  if (inviteSnap.empty) {
    return { legitimate: false, reason: "caregiver_without_claimed_invite" };
  }
  return { legitimate: true, reason: "claimed_caregiver_invite" };
}

async function repairIllegitimateAccess(
  uid: string,
  familyId: string,
  email: string,
  reason: string
): Promise<string> {
  const guardianRef = db
    .collection("families")
    .doc(familyId)
    .collection("guardians")
    .doc(uid);
  const guardianSnap = await guardianRef.get();
  if (guardianSnap.exists) {
    await guardianRef.delete();
  }

  const newFamilyId = await createFreshFamilyForUser(uid, email);
  await db.collection("parentProfiles").doc(uid).set(
    {
      familyId: newFamilyId,
      ownedFamilyId: newFamilyId,
    },
    { merge: true }
  );

  const msg = `Repaired ${email || uid}: removed rogue access to ${familyId} (${reason}) → ${newFamilyId}`;
  logger.warn(msg);
  return msg;
}

/**
 * Scans all parentProfiles and repairs any with illegitimate familyId links
 * (cross-tenant guardian docs from the 2026-08-05 rules hole).
 */
export const adminRepairCrossTenantGuardians = onCall({ cors: true }, async (request) => {
  const adminEmail = assertProjectAdmin(request);
  const fixes: string[] = [];
  const profiles = await db.collection("parentProfiles").get();

  for (const profileDoc of profiles.docs) {
    const data = profileDoc.data();
    const uid = profileDoc.id;
    const familyId = data.familyId as string | undefined;
    const email = String(data.email ?? "");
    if (!familyId) continue;

    const { legitimate, reason } = await isLegitimateFamilyAccess(uid, familyId);
    if (legitimate) continue;

    fixes.push(await repairIllegitimateAccess(uid, familyId, email, reason));
  }

  if (fixes.length === 0) fixes.push("No cross-tenant guardian repairs needed.");

  await writeAuditLog({
    action: "repair_cross_tenant",
    adminEmail,
    targetUid: "system",
    detail: fixes.join(" "),
    meta: { fixes },
  });

  return { ok: true, fixes };
});

/**
 * Repairs a single account by email (e.g. nathonheart@gmail.com after the
 * 2026-08-05 cross-tenant isolation incident).
 */
export const adminResetAccountFamilyIsolation = onCall({ cors: true }, async (request) => {
  const adminEmail = assertProjectAdmin(request);
  const email = String(request.data?.email ?? "")
    .trim()
    .toLowerCase();
  if (!email) {
    throw new HttpsError("invalid-argument", "email is required.");
  }

  const profiles = await db
    .collection("parentProfiles")
    .where("email", "==", email)
    .limit(5)
    .get();

  // Also try Auth lookup if profile email casing differs.
  let uids = profiles.docs.map((d) => d.id);
  if (uids.length === 0) {
    try {
      const user = await admin.auth().getUserByEmail(email);
      uids = [user.uid];
    } catch {
      throw new HttpsError("not-found", `No account found for ${email}.`);
    }
  }

  const fixes: string[] = [];
  for (const uid of uids) {
    const profileSnap = await db.collection("parentProfiles").doc(uid).get();
    if (!profileSnap.exists) {
      fixes.push(`No parentProfiles doc for ${email} (${uid}).`);
      continue;
    }
    const data = profileSnap.data() ?? {};
    const familyId = data.familyId as string | undefined;
    const profileEmail = String(data.email ?? email);
    if (!familyId) {
      const newFamilyId = await createFreshFamilyForUser(uid, profileEmail);
      await profileSnap.ref.set(
        { familyId: newFamilyId, ownedFamilyId: newFamilyId },
        { merge: true }
      );
      fixes.push(`Bootstrapped missing family for ${profileEmail} → ${newFamilyId}`);
      continue;
    }

    const { legitimate, reason } = await isLegitimateFamilyAccess(uid, familyId);
    if (legitimate) {
      fixes.push(`${profileEmail} already has legitimate access to ${familyId} (${reason}).`);
      continue;
    }
    fixes.push(await repairIllegitimateAccess(uid, familyId, profileEmail, reason));
  }

  await writeAuditLog({
    action: "repair_cross_tenant",
    adminEmail,
    targetUid: uids[0] ?? "unknown",
    targetEmail: email,
    detail: fixes.join(" "),
    meta: { fixes },
  });

  return { ok: true, fixes };
});
