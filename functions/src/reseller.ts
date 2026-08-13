import * as admin from "firebase-admin";
import { onCall, HttpsError, type CallableRequest } from "firebase-functions/v2/https";
import { onSchedule } from "firebase-functions/v2/scheduler";
import { logger } from "firebase-functions";
import { ADMIN_EMAIL, assertProjectAdmin, writeAuditLog } from "./admin";

if (!admin.apps.length) {
  admin.initializeApp();
}

const db = admin.firestore();
const DAY_MS = 24 * 60 * 60 * 1000;

export const PLAN_DAYS = [15, 30, 90] as const;
export type PlanDays = (typeof PLAN_DAYS)[number];

/** Default retail display prices (GYD). USD/XCD are derived for UI only. */
export const DEFAULT_RESELLER_PRICING = {
  plans: {
    15: { days: 15, retailGyd: 2200, label: "Starter" },
    30: { days: 30, retailGyd: 4000, label: "Monthly" },
    90: { days: 90, retailGyd: 10800, label: "Quarterly" },
  },
  gydPerUsd: 209,
  xcdPerUsd: 2.7,
  wholesaleGydPerCreditDay: 110,
};

function isPlanDays(n: number): n is PlanDays {
  return (PLAN_DAYS as readonly number[]).includes(n);
}

async function loadResellerPricing(): Promise<typeof DEFAULT_RESELLER_PRICING> {
  const snap = await db.collection("adminConfig").doc("resellerPricing").get();
  if (!snap.exists) return DEFAULT_RESELLER_PRICING;
  const data = snap.data() ?? {};
  return {
    ...DEFAULT_RESELLER_PRICING,
    ...data,
    plans: {
      ...DEFAULT_RESELLER_PRICING.plans,
      ...(data.plans as object | undefined),
    },
  } as typeof DEFAULT_RESELLER_PRICING;
}

export async function assertActiveReseller(request: CallableRequest): Promise<{
  uid: string;
  email: string;
  creditBalance: number;
  ref: FirebaseFirestore.DocumentReference;
  data: FirebaseFirestore.DocumentData;
}> {
  if (!request.auth?.uid) {
    throw new HttpsError("unauthenticated", "Sign in required.");
  }
  const uid = request.auth.uid;
  const email = String(request.auth.token.email ?? "").trim().toLowerCase();
  const ref = db.collection("resellers").doc(uid);
  const snap = await ref.get();
  if (!snap.exists) {
    throw new HttpsError("permission-denied", "Not a reseller account.");
  }
  const data = snap.data()!;
  if (data.status !== "active") {
    throw new HttpsError(
      "permission-denied",
      `Reseller status is ${String(data.status ?? "unknown")}. Contact SareChild ops.`
    );
  }
  return {
    uid,
    email,
    creditBalance: Number(data.creditBalance ?? 0),
    ref,
    data,
  };
}

async function writeResellerLedger(entry: {
  resellerUid: string;
  delta: number;
  balanceAfter: number;
  reason: string;
  actorUid: string;
  meta?: Record<string, unknown>;
}): Promise<void> {
  await db.collection("resellerLedger").add({
    ...entry,
    createdAtMs: Date.now(),
  });
}

/** Apply paid entitlement: stack days onto max(now, existing paidUntilMs). */
export async function applyPaidEntitlement(
  profileRef: FirebaseFirestore.DocumentReference,
  planDays: number,
  meta: {
    subscriptionSource: "reseller" | "voucher" | "tcd";
    activatedByResellerUid?: string | null;
    lastVoucherCode?: string | null;
  }
): Promise<{ paidUntilMs: number }> {
  const snap = await profileRef.get();
  if (!snap.exists) {
    throw new HttpsError("not-found", "Parent profile not found.");
  }
  const data = snap.data()!;
  const now = Date.now();
  const existingPaid = Number(data.paidUntilMs ?? 0);
  const base = Math.max(now, existingPaid > 0 ? existingPaid : 0);
  const paidUntilMs = base + planDays * DAY_MS;

  await profileRef.set(
    {
      plan: "paid",
      status: "active",
      adminBlocked: false,
      blockedAtMs: null,
      blockedReason: null,
      blockedBy: null,
      paidUntilMs,
      subscriptionSource: meta.subscriptionSource,
      activatedByResellerUid: meta.activatedByResellerUid ?? null,
      lastVoucherCode: meta.lastVoucherCode ?? null,
      lastActivatedAtMs: now,
      lastActiveAt: now,
    },
    { merge: true }
  );
  return { paidUntilMs };
}

async function findParentByEmail(emailRaw: string): Promise<{
  uid: string;
  ref: FirebaseFirestore.DocumentReference;
  data: FirebaseFirestore.DocumentData;
  email: string;
}> {
  const email = emailRaw.trim().toLowerCase();
  if (!email || !email.includes("@")) {
    throw new HttpsError("invalid-argument", "A valid email is required.");
  }

  // Prefer Auth lookup (canonical), then parentProfiles email field.
  let uid: string | null = null;
  try {
    const user = await admin.auth().getUserByEmail(email);
    uid = user.uid;
  } catch {
    uid = null;
  }

  if (uid) {
    const ref = db.collection("parentProfiles").doc(uid);
    const snap = await ref.get();
    if (snap.exists) {
      return { uid, ref, data: snap.data()!, email };
    }
  }

  const q = await db
    .collection("parentProfiles")
    .where("email", "==", email)
    .limit(1)
    .get();
  if (q.empty) {
    // Case-insensitive fallback scan is too expensive; try Auth-created profile missing email field.
    throw new HttpsError(
      "not-found",
      `No SareChild parent account found for ${email}. They must sign up first.`
    );
  }
  const doc = q.docs[0];
  return { uid: doc.id, ref: doc.ref, data: doc.data(), email };
}

function generateVoucherCode(): string {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const chunk = (n: number) => {
    let s = "";
    for (let i = 0; i < n; i++) {
      s += alphabet[Math.floor(Math.random() * alphabet.length)];
    }
    return s;
  };
  return `SC-${chunk(4)}-${chunk(4)}-${chunk(4)}`;
}

function sanitizeParentStatus(uid: string, data: FirebaseFirestore.DocumentData) {
  const now = Date.now();
  const paidUntilMs = Number(data.paidUntilMs ?? 0);
  const plan = String(data.plan ?? "trial");
  const hasPaidAccess = plan === "paid" && paidUntilMs > now;
  return {
    uid,
    email: String(data.email ?? ""),
    plan,
    status: String(data.status ?? "active"),
    adminBlocked: Boolean(data.adminBlocked),
    trialStartedAt: Number(data.trialStartedAt ?? 0),
    trialEndsAt: Number(data.trialEndsAt ?? 0),
    paidUntilMs: paidUntilMs || null,
    hasPaidAccess,
    subscriptionSource: (data.subscriptionSource as string | undefined) ?? null,
    familyId: (data.familyId as string | undefined) ?? null,
    lastLoginAt: data.lastLoginAt == null ? null : Number(data.lastLoginAt),
  };
}

// ---------- Admin callables ----------

/**
 * Activate / suspend a reseller. Pass uid or email of an existing Firebase Auth user
 * (they must have signed up via Google or email/password first).
 */
export const adminSetResellerStatus = onCall({ cors: true }, async (request) => {
  const adminEmail = assertProjectAdmin(request);
  const status = String(request.data?.status ?? "").trim() as "pending" | "active" | "suspended";
  if (!["pending", "active", "suspended"].includes(status)) {
    throw new HttpsError("invalid-argument", "status must be pending|active|suspended.");
  }

  let uid = String(request.data?.uid ?? "").trim();
  const emailArg = String(request.data?.email ?? "").trim().toLowerCase();
  let email = emailArg;
  let displayName = String(request.data?.displayName ?? "").trim();

  if (!uid && emailArg) {
    try {
      const user = await admin.auth().getUserByEmail(emailArg);
      uid = user.uid;
      email = (user.email ?? emailArg).toLowerCase();
      if (!displayName) displayName = user.displayName ?? "";
    } catch {
      throw new HttpsError("not-found", `No Auth user for ${emailArg}. They must sign up first.`);
    }
  }
  if (!uid) throw new HttpsError("invalid-argument", "uid or email is required.");

  if (!email) {
    try {
      const user = await admin.auth().getUser(uid);
      email = (user.email ?? "").toLowerCase();
      if (!displayName) displayName = user.displayName ?? "";
    } catch {
      throw new HttpsError("not-found", `No Auth user for uid ${uid}.`);
    }
  }

  const ref = db.collection("resellers").doc(uid);
  const existing = await ref.get();
  const now = Date.now();
  const patch: Record<string, unknown> = {
    email,
    status,
    lastActiveAtMs: now,
  };
  if (displayName) patch.displayName = displayName;
  if (request.data?.notes != null) patch.notes = String(request.data.notes);
  if (!existing.exists) {
    patch.creditBalance = 0;
    patch.createdAtMs = now;
  }
  if (status === "active" && (!existing.exists || existing.get("status") !== "active")) {
    patch.activatedAtMs = now;
    patch.activatedBy = adminEmail;
  }

  await ref.set(patch, { merge: true });

  await writeAuditLog({
    action: "set_reseller_status",
    adminEmail,
    targetUid: uid,
    targetEmail: email,
    detail: `Reseller status → ${status}`,
    meta: { status },
  });

  return { ok: true, uid, email, status };
});

export const adminTopUpResellerCredits = onCall({ cors: true }, async (request) => {
  const adminEmail = assertProjectAdmin(request);
  const uid = String(request.data?.uid ?? "").trim();
  const amount = Math.floor(Number(request.data?.amount ?? 0));
  const note = String(request.data?.note ?? "").trim();
  if (!uid) throw new HttpsError("invalid-argument", "uid is required.");
  if (!Number.isFinite(amount) || amount === 0) {
    throw new HttpsError("invalid-argument", "amount must be a non-zero integer (credit-days).");
  }

  const ref = db.collection("resellers").doc(uid);
  const balanceAfter = await db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) throw new HttpsError("not-found", "Reseller not found.");
    const current = Number(snap.get("creditBalance") ?? 0);
    const next = current + amount;
    if (next < 0) throw new HttpsError("failed-precondition", "Balance cannot go negative.");
    tx.set(
      ref,
      { creditBalance: next, lastTopUpAtMs: Date.now(), lastTopUpBy: adminEmail },
      { merge: true }
    );
    return next;
  });

  await writeResellerLedger({
    resellerUid: uid,
    delta: amount,
    balanceAfter,
    reason: amount > 0 ? "tcd_topup" : "adjust",
    actorUid: request.auth!.uid,
    meta: { note, adminEmail },
  });

  await writeAuditLog({
    action: "topup_reseller_credits",
    adminEmail,
    targetUid: uid,
    targetEmail: String((await ref.get()).get("email") ?? ""),
    detail: `Top-up ${amount} credit-days → balance ${balanceAfter}`,
    meta: { amount, balanceAfter, note },
  });

  return { ok: true, creditBalance: balanceAfter };
});

export const adminSaveResellerPricing = onCall({ cors: true }, async (request) => {
  const adminEmail = assertProjectAdmin(request);
  const pricing = request.data?.pricing;
  if (!pricing || typeof pricing !== "object") {
    throw new HttpsError("invalid-argument", "pricing object required.");
  }
  await db.collection("adminConfig").doc("resellerPricing").set(
    { ...pricing, updatedAtMs: Date.now(), updatedBy: adminEmail },
    { merge: true }
  );
  await writeAuditLog({
    action: "save_reseller_pricing",
    adminEmail,
    targetUid: "system",
    detail: "Updated resellerPricing",
    meta: pricing as Record<string, unknown>,
  });
  return { ok: true };
});

export const adminListResellers = onCall({ cors: true }, async (request) => {
  assertProjectAdmin(request);
  const snap = await db.collection("resellers").orderBy("createdAtMs", "desc").limit(200).get();
  return {
    ok: true,
    resellers: snap.docs.map((d) => ({
      uid: d.id,
      ...d.data(),
    })),
  };
});

export const adminGetResellerLedger = onCall({ cors: true }, async (request) => {
  assertProjectAdmin(request);
  const uid = String(request.data?.uid ?? "").trim();
  if (!uid) throw new HttpsError("invalid-argument", "uid is required.");
  const snap = await db
    .collection("resellerLedger")
    .where("resellerUid", "==", uid)
    .orderBy("createdAtMs", "desc")
    .limit(100)
    .get();
  return {
    ok: true,
    entries: snap.docs.map((d) => ({ id: d.id, ...d.data() })),
  };
});

// ---------- Reseller callables ----------

export const resellerGetDashboard = onCall({ cors: true }, async (request) => {
  const reseller = await assertActiveReseller(request);
  const pricing = await loadResellerPricing();
  const ledgerSnap = await db
    .collection("resellerLedger")
    .where("resellerUid", "==", reseller.uid)
    .orderBy("createdAtMs", "desc")
    .limit(30)
    .get();
  const voucherSnap = await db
    .collection("vouchers")
    .where("createdByResellerUid", "==", reseller.uid)
    .orderBy("createdAtMs", "desc")
    .limit(50)
    .get();

  return {
    ok: true,
    reseller: {
      uid: reseller.uid,
      email: reseller.email,
      displayName: String(reseller.data.displayName ?? ""),
      creditBalance: reseller.creditBalance,
      status: reseller.data.status,
    },
    pricing,
    ledger: ledgerSnap.docs.map((d) => ({ id: d.id, ...d.data() })),
    vouchers: voucherSnap.docs.map((d) => ({ code: d.id, ...d.data() })),
  };
});

export const resellerLookupParent = onCall({ cors: true }, async (request) => {
  await assertActiveReseller(request);
  const email = String(request.data?.email ?? "").trim();
  const found = await findParentByEmail(email);
  return { ok: true, account: sanitizeParentStatus(found.uid, found.data) };
});

export const resellerActivateParent = onCall({ cors: true }, async (request) => {
  const reseller = await assertActiveReseller(request);
  const email = String(request.data?.email ?? "").trim();
  const planDays = Math.floor(Number(request.data?.planDays ?? 0));
  if (!isPlanDays(planDays)) {
    throw new HttpsError("invalid-argument", "planDays must be 15, 30, or 90.");
  }

  const found = await findParentByEmail(email);

  const balanceAfter = await db.runTransaction(async (tx) => {
    const rSnap = await tx.get(reseller.ref);
    const balance = Number(rSnap.get("creditBalance") ?? 0);
    if (balance < planDays) {
      throw new HttpsError(
        "failed-precondition",
        `Not enough credits (${balance} left, need ${planDays}).`
      );
    }
    const next = balance - planDays;
    tx.set(reseller.ref, { creditBalance: next, lastActiveAtMs: Date.now() }, { merge: true });
    return next;
  });

  const { paidUntilMs } = await applyPaidEntitlement(found.ref, planDays, {
    subscriptionSource: "reseller",
    activatedByResellerUid: reseller.uid,
  });

  await writeResellerLedger({
    resellerUid: reseller.uid,
    delta: -planDays,
    balanceAfter,
    reason: "activate",
    actorUid: reseller.uid,
    meta: {
      targetUid: found.uid,
      targetEmail: found.email,
      planDays,
      paidUntilMs,
    },
  });

  logger.info(
    `resellerActivateParent: reseller=${reseller.uid} target=${found.uid} days=${planDays} until=${paidUntilMs}`
  );

  return {
    ok: true,
    creditBalance: balanceAfter,
    account: {
      ...sanitizeParentStatus(found.uid, {
        ...found.data,
        plan: "paid",
        paidUntilMs,
        status: "active",
      }),
      paidUntilMs,
      hasPaidAccess: true,
    },
  };
});

export const resellerCreateVoucher = onCall({ cors: true }, async (request) => {
  const reseller = await assertActiveReseller(request);
  const planDays = Math.floor(Number(request.data?.planDays ?? 0));
  const redeemWithinDays = Math.floor(Number(request.data?.redeemWithinDays ?? 60));
  if (!isPlanDays(planDays)) {
    throw new HttpsError("invalid-argument", "planDays must be 15, 30, or 90.");
  }
  if (![30, 60, 90].includes(redeemWithinDays)) {
    throw new HttpsError("invalid-argument", "redeemWithinDays must be 30, 60, or 90.");
  }

  const balanceAfter = await db.runTransaction(async (tx) => {
    const rSnap = await tx.get(reseller.ref);
    const balance = Number(rSnap.get("creditBalance") ?? 0);
    if (balance < planDays) {
      throw new HttpsError(
        "failed-precondition",
        `Not enough credits (${balance} left, need ${planDays}).`
      );
    }
    tx.set(
      reseller.ref,
      { creditBalance: balance - planDays, lastActiveAtMs: Date.now() },
      { merge: true }
    );
    return balance - planDays;
  });

  const now = Date.now();
  let code = generateVoucherCode();
  for (let i = 0; i < 5; i++) {
    const existing = await db.collection("vouchers").doc(code).get();
    if (!existing.exists) break;
    code = generateVoucherCode();
  }

  const expiresAtMs = now + redeemWithinDays * DAY_MS;
  await db.collection("vouchers").doc(code).set({
    planDays,
    expiresAtMs,
    status: "active",
    createdByResellerUid: reseller.uid,
    createdByResellerEmail: reseller.email,
    createdAtMs: now,
    redeemedByUid: null,
    redeemedAtMs: null,
    creditCost: planDays,
  });

  await writeResellerLedger({
    resellerUid: reseller.uid,
    delta: -planDays,
    balanceAfter,
    reason: "voucher_mint",
    actorUid: reseller.uid,
    meta: { code, planDays, expiresAtMs },
  });

  return {
    ok: true,
    creditBalance: balanceAfter,
    voucher: { code, planDays, expiresAtMs, status: "active" },
  };
});

export const resellerVoidVoucher = onCall({ cors: true }, async (request) => {
  const reseller = await assertActiveReseller(request);
  const code = String(request.data?.code ?? "")
    .trim()
    .toUpperCase();
  if (!code) throw new HttpsError("invalid-argument", "code is required.");

  const vRef = db.collection("vouchers").doc(code);
  const result = await db.runTransaction(async (tx) => {
    const vSnap = await tx.get(vRef);
    if (!vSnap.exists) throw new HttpsError("not-found", "Voucher not found.");
    const v = vSnap.data()!;
    if (v.createdByResellerUid !== reseller.uid && request.auth?.token.email !== ADMIN_EMAIL) {
      throw new HttpsError("permission-denied", "Not your voucher.");
    }
    if (v.status !== "active") {
      throw new HttpsError("failed-precondition", `Voucher is already ${v.status}.`);
    }
    const refund = Number(v.creditCost ?? v.planDays ?? 0);
    tx.set(vRef, { status: "void", voidedAtMs: Date.now() }, { merge: true });

    const rSnap = await tx.get(reseller.ref);
    const balance = Number(rSnap.get("creditBalance") ?? 0);
    const balanceAfter = balance + refund;
    tx.set(reseller.ref, { creditBalance: balanceAfter }, { merge: true });
    return { refund, balanceAfter };
  });

  await writeResellerLedger({
    resellerUid: reseller.uid,
    delta: result.refund,
    balanceAfter: result.balanceAfter,
    reason: "voucher_void_refund",
    actorUid: reseller.uid,
    meta: { code },
  });

  return { ok: true, creditBalance: result.balanceAfter, refunded: result.refund };
});

/** Parent redeems a voucher onto their own account. */
export const redeemVoucher = onCall({ cors: true }, async (request) => {
  if (!request.auth?.uid) {
    throw new HttpsError("unauthenticated", "Sign in required.");
  }
  const uid = request.auth.uid;
  const code = String(request.data?.code ?? "")
    .trim()
    .toUpperCase();
  if (!code) throw new HttpsError("invalid-argument", "Voucher code is required.");

  const vRef = db.collection("vouchers").doc(code);
  const profileRef = db.collection("parentProfiles").doc(uid);

  const planDays = await db.runTransaction(async (tx) => {
    const vSnap = await tx.get(vRef);
    if (!vSnap.exists) throw new HttpsError("not-found", "Invalid voucher code.");
    const v = vSnap.data()!;
    const now = Date.now();
    if (v.status === "redeemed") {
      throw new HttpsError("failed-precondition", "This voucher was already redeemed.");
    }
    if (v.status === "void") {
      throw new HttpsError("failed-precondition", "This voucher was voided.");
    }
    if (v.status === "expired" || Number(v.expiresAtMs ?? 0) < now) {
      if (v.status === "active") {
        tx.set(vRef, { status: "expired" }, { merge: true });
      }
      throw new HttpsError("failed-precondition", "This voucher has expired.");
    }
    if (v.status !== "active") {
      throw new HttpsError("failed-precondition", `Voucher cannot be redeemed (${v.status}).`);
    }
    const days = Number(v.planDays ?? 0);
    if (!isPlanDays(days)) {
      throw new HttpsError("internal", "Voucher has invalid planDays.");
    }
    tx.set(
      vRef,
      {
        status: "redeemed",
        redeemedByUid: uid,
        redeemedAtMs: now,
      },
      { merge: true }
    );
    return days;
  });

  const { paidUntilMs } = await applyPaidEntitlement(profileRef, planDays, {
    subscriptionSource: "voucher",
    lastVoucherCode: code,
  });

  const profile = await profileRef.get();
  return {
    ok: true,
    planDays,
    paidUntilMs,
    account: sanitizeParentStatus(uid, profile.data() ?? {}),
  };
});

/**
 * Mark paid subscriptions past paidUntilMs so clients treat them as expired.
 * Flips plan back to trial with trialEndsAt = paidUntilMs (already past).
 */
export async function runExpirePaidSubscriptions(): Promise<{ expired: number }> {
  const now = Date.now();
  const snap = await db.collection("parentProfiles").where("plan", "==", "paid").get();
  let expired = 0;
  for (const doc of snap.docs) {
    const paidUntilMs = Number(doc.get("paidUntilMs") ?? 0);
    if (paidUntilMs > 0 && paidUntilMs < now) {
      await doc.ref.set(
        {
          plan: "trial",
          trialEndsAt: paidUntilMs,
          status: doc.get("status") === "blocked" ? "blocked" : "active",
          subscriptionExpiredAtMs: now,
        },
        { merge: true }
      );
      expired++;
    }
  }
  logger.info(`expirePaidSubscriptions: expired=${expired} scanned=${snap.size}`);
  return { expired };
}

export const expirePaidSubscriptions = onSchedule("every 24 hours", async () => {
  await runExpirePaidSubscriptions();
});

export const adminTriggerExpirePaid = onCall({ cors: true }, async (request) => {
  const adminEmail = assertProjectAdmin(request);
  const result = await runExpirePaidSubscriptions();
  await writeAuditLog({
    action: "trigger_expire_paid",
    adminEmail,
    targetUid: "system",
    detail: `Expired ${result.expired} paid subscription(s)`,
    meta: result,
  });
  return { ok: true, ...result };
});

function clampStr(raw: unknown, max: number): string {
  return String(raw ?? "")
    .trim()
    .slice(0, max);
}

/**
 * Public marketing intake — no Auth required. Writes to resellerApplications for ops review.
 * Activation still happens via adminSetResellerStatus after the partner creates an Auth account.
 */
export const resellerApply = onCall({ cors: true }, async (request) => {
  const name = clampStr(request.data?.name, 120);
  const email = clampStr(request.data?.email, 200).toLowerCase();
  const phone = clampStr(request.data?.phone, 40);
  const country = clampStr(request.data?.country, 80);
  const businessType = clampStr(request.data?.businessType, 80);
  const message = clampStr(request.data?.message, 2000);

  if (name.length < 2) {
    throw new HttpsError("invalid-argument", "Please enter your name.");
  }
  if (!email.includes("@") || email.length < 5) {
    throw new HttpsError("invalid-argument", "A valid email is required.");
  }
  if (phone.length < 6) {
    throw new HttpsError("invalid-argument", "Please enter a phone or WhatsApp number.");
  }
  if (country.length < 2) {
    throw new HttpsError("invalid-argument", "Please enter your country.");
  }

  // Light rate-limit: reject duplicate open applications from the same email within 24h.
  const dayAgo = Date.now() - DAY_MS;
  const recent = await db
    .collection("resellerApplications")
    .where("email", "==", email)
    .limit(8)
    .get();
  const hasRecent = recent.docs.some((d) => Number(d.get("createdAtMs") ?? 0) > dayAgo);
  if (hasRecent) {
    throw new HttpsError(
      "already-exists",
      "We already received an application from this email today. We'll be in touch soon."
    );
  }

  const ref = await db.collection("resellerApplications").add({
    name,
    email,
    phone,
    country,
    businessType: businessType || null,
    message: message || null,
    status: "new",
    source: "marketing",
    createdAtMs: Date.now(),
    applicantUid: request.auth?.uid ?? null,
  });

  logger.info(`resellerApply: id=${ref.id} email=${email} country=${country}`);
  return { ok: true, applicationId: ref.id };
});

/** Ops: list recent reseller applications from the marketing form. */
export const adminListResellerApplications = onCall({ cors: true }, async (request) => {
  assertProjectAdmin(request);
  const snap = await db
    .collection("resellerApplications")
    .orderBy("createdAtMs", "desc")
    .limit(100)
    .get();
  return {
    ok: true,
    applications: snap.docs.map((d) => ({ id: d.id, ...d.data() })),
  };
});
