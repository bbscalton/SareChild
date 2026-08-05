import * as admin from "firebase-admin";
import { onCall, HttpsError } from "firebase-functions/v2/https";
import { logger } from "firebase-functions";

if (!admin.apps.length) {
  admin.initializeApp();
}

const db = admin.firestore();

/**
 * Accepts a families/{familyId}/guardianInvites-issued caregiver code server-side.
 *
 * This used to be a pure client write (setDoc on guardians/{uid} + parentProfiles/{uid})
 * gated only by a Firestore rule allowing "a user may write their own guardians/{uid}
 * doc under ANY familyId". That rule was the multi-tenant isolation hole that let one
 * account grant itself guardian/OWNER access to a different family's data without ever
 * holding a valid invite (see 2026-08-05 privacy incident: nathonheart@gmail.com could
 * read neuereatec@gmail.com's whole family by writing a guardians/{uid} doc directly).
 *
 * Moving invite redemption into a transactional Cloud Function means the ONLY way to
 * gain guardians/{familyId}/{uid} membership is: (a) be the family owner (client-side
 * bootstrap, verified by firestore.rules' isFamilyOwner), or (b) redeem a real,
 * unexpired, unclaimed invite through this function, which runs with Admin SDK
 * privileges and is therefore not subject to (and cannot be bypassed via) client rules.
 */
export const acceptGuardianInvite = onCall({ cors: true }, async (request) => {
  if (!request.auth?.uid) {
    throw new HttpsError("unauthenticated", "Sign in required.");
  }
  const uid = request.auth.uid;
  const email = String(request.auth.token.email ?? "").trim();
  const code = String(request.data?.code ?? "").trim().toUpperCase();
  if (!code) {
    throw new HttpsError("invalid-argument", "Invite code is required.");
  }

  const inviteRef = db.collection("guardianInvites").doc(code);
  const profileRef = db.collection("parentProfiles").doc(uid);

  const familyId = await db.runTransaction(async (tx) => {
    const inviteSnap = await tx.get(inviteRef);
    if (!inviteSnap.exists) {
      throw new HttpsError("not-found", "Invalid invite code.");
    }
    const invite = inviteSnap.data()!;
    if (invite.claimed) {
      throw new HttpsError("failed-precondition", "This invite was already used.");
    }
    const expiresAtMs = Number(invite.expiresAtMs ?? 0);
    if (expiresAtMs && Date.now() > expiresAtMs) {
      throw new HttpsError("failed-precondition", "This invite has expired.");
    }
    const targetFamilyId = String(invite.familyId ?? "");
    if (!targetFamilyId) {
      throw new HttpsError("internal", "Invite is missing a family.");
    }

    const familySnap = await tx.get(db.collection("families").doc(targetFamilyId));
    if (!familySnap.exists) {
      throw new HttpsError("not-found", "The family for this invite no longer exists.");
    }
    // A person can never redeem an invite into a family they already own — that would
    // let an owner silently demote their own OWNER doc to CAREGIVER via a stray invite.
    if (familySnap.get("parentUid") === uid) {
      throw new HttpsError("failed-precondition", "You already own this family.");
    }

    const profileSnap = await tx.get(profileRef);
    const ownedFamilyId = profileSnap.exists
      ? (profileSnap.get("ownedFamilyId") as string | undefined)
      : undefined;

    const now = Date.now();
    tx.set(
      db.collection("families").doc(targetFamilyId).collection("guardians").doc(uid),
      {
        email: email || String(invite.email ?? ""),
        role: "CAREGIVER",
        joinedAtMs: now,
      }
    );
    tx.set(
      profileRef,
      {
        familyId: targetFamilyId,
        email: email || String(invite.email ?? ""),
        ...(ownedFamilyId ? { ownedFamilyId } : {}),
      },
      { merge: true }
    );
    tx.update(inviteRef, {
      claimed: true,
      claimedAtMs: now,
      claimedByUid: uid,
    });

    return targetFamilyId;
  });

  logger.info(`acceptGuardianInvite: uid=${uid} joined family=${familyId} via code=${code}`);

  return { ok: true, familyId };
});
