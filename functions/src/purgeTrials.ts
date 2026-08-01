import * as admin from "firebase-admin";
import { logger } from "firebase-functions";
import { deleteCollectionRecursive, FAMILY_SUBCOLLECTIONS } from "./admin";

const db = admin.firestore();

const TRIAL_DAYS = 30;
const CHECK_IN_STALE_DAYS = 7;
const INACTIVITY_GRACE_DAYS = 3;
const DAY_MS = 24 * 60 * 60 * 1000;

type TrialDecision = "keep" | "warn" | "purge";

function decideTrialFate(
  now: number,
  data: FirebaseFirestore.DocumentData
): TrialDecision {
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

async function deleteFamilyDeep(familyId: string): Promise<void> {
  const familyRef = db.collection("families").doc(familyId);
  for (const sub of FAMILY_SUBCOLLECTIONS) {
    await deleteCollectionRecursive(familyRef.collection(sub));
  }
  await familyRef.delete();
}

export async function runPurgeInactiveTrials(): Promise<{
  warned: number;
  purged: number;
  scanned: number;
}> {
  const now = Date.now();
  const profiles = await db.collection("parentProfiles").where("plan", "==", "trial").get();

  let warned = 0;
  let purged = 0;

  for (const profile of profiles.docs) {
    const data = profile.data();
    const decision = decideTrialFate(now, data);
    if (decision === "keep") continue;

    if (decision === "warn") {
      if (!data.purgeWarnedAt) {
        await profile.ref.set({ status: "at_risk", purgeWarnedAt: now }, { merge: true });
        warned++;
      }
      continue;
    }

    const uid = profile.id;
    const familyId = data.familyId as string | undefined;
    try {
      if (familyId) {
        const familySnap = await db.collection("families").doc(familyId).get();
        if (familySnap.exists && familySnap.get("parentUid") === uid) {
          await deleteFamilyDeep(familyId);
        } else {
          await db
            .collection("families")
            .doc(familyId)
            .collection("guardians")
            .doc(uid)
            .delete()
            .catch(() => undefined);
        }
      }
      await admin
        .auth()
        .deleteUser(uid)
        .catch((err) => logger.warn(`Auth delete failed for ${uid}`, err));
      await profile.ref.set({ status: "purged", plan: "trial", purgedAtMs: now }, { merge: false });
      purged++;
    } catch (err) {
      logger.error(`Failed to purge trial account ${uid}`, err);
    }
  }

  logger.info(`purgeInactiveTrials: warned=${warned} purged=${purged} scanned=${profiles.size}`);
  return { warned, purged, scanned: profiles.size };
}
