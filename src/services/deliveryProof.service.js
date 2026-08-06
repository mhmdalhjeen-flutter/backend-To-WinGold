const DeliverySession = require("../models/deliverySession");
const DeliveryCompany = require("../models/deliveryCompany");
const DeliveryCompanyDriver = require("../models/deliveryCompanyDriver");
const { SESSION_STATUSES } = require("../constants/deliverySession.constants");
const { cleanString, requireObjectId } = require("../utils/inputSecurity.util");

function escapeRegex(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function formatProofCard(session, { includeCompany = true } = {}) {
  const plain = session.toObject ? session.toObject() : { ...session };
  const snap = plain.deliveryProofSnapshot || {};
  const assigned = plain.assignedDriver || {};
  const photo = snap.photo || plain.driverDeliveryProof || "";
  const deliveredAt = snap.deliveredAt || plain.driverDeliveredAt || plain.updatedAt;
  const verificationCode = snap.verificationCode
    || (snap.verificationCodes && snap.verificationCodes[0])
    || (plain.storeStops || []).map((s) => s.verificationCode).filter(Boolean)[0]
    || "";

  const card = {
    id: plain._id,
    _id: plain._id,
    photo,
    hasPhoto: Boolean(photo),
    note: snap.note || plain.driverDeliveryNote || "",
    deliveredAt,
    driverId: snap.driverId || assigned.driverId || null,
    driverName: snap.driverName || assigned.name || "",
    driverPhone: snap.driverPhone || assigned.phone || "",
    verificationCode,
    verificationCodes: snap.verificationCodes?.length
      ? snap.verificationCodes
      : (verificationCode ? [verificationCode] : []),
    orderIds: snap.orderIds?.length ? snap.orderIds : (plain.orders || []),
    orderNumbers: snap.orderNumbers || [],
    customerName: snap.customerName || plain.customerName || "",
    customerPhone: snap.customerPhone || plain.customerPhone || "",
    customerId: plain.customer || null,
  };

  if (includeCompany) {
    const company = plain.deliveryCompany;
    card.companyId = snap.companyId || company?._id || company || null;
    card.companyName = snap.companyName || company?.name || "";
  }

  return card;
}

function buildProofQuery(filters = {}, { companyId = null } = {}) {
  const query = {
    status: { $in: [SESSION_STATUSES.COMPLETED, "delivered"] },
    $or: [
      { "deliveryProofSnapshot.photo": { $exists: true, $nin: [null, ""] } },
      { driverDeliveryProof: { $exists: true, $nin: [null, ""] } },
    ],
  };

  if (companyId) {
    query.deliveryCompany = companyId;
  } else if (filters.companyId) {
    query.deliveryCompany = requireObjectId(filters.companyId, "companyId");
  }

  if (filters.driverId) {
    const did = requireObjectId(filters.driverId, "driverId");
    query.$and = query.$and || [];
    query.$and.push({
      $or: [
        { "deliveryProofSnapshot.driverId": did },
        { "assignedDriver.driverId": did },
      ],
    });
  }

  if (filters.from || filters.to) {
    const range = {};
    if (filters.from) range.$gte = new Date(filters.from);
    if (filters.to) {
      const to = new Date(filters.to);
      to.setHours(23, 59, 59, 999);
      range.$lte = to;
    }
    query.$and = query.$and || [];
    query.$and.push({
      $or: [
        { "deliveryProofSnapshot.deliveredAt": range },
        { driverDeliveredAt: range },
      ],
    });
  }

  const q = cleanString(filters.q, { field: "q", max: 120 });
  if (q) {
    const regex = new RegExp(escapeRegex(q), "i");
    query.$and = query.$and || [];
    query.$and.push({
      $or: [
        { "deliveryProofSnapshot.verificationCode": regex },
        { "deliveryProofSnapshot.verificationCodes": regex },
        { "deliveryProofSnapshot.customerName": regex },
        { "deliveryProofSnapshot.customerPhone": regex },
        { "deliveryProofSnapshot.driverName": regex },
        { "deliveryProofSnapshot.companyName": regex },
        { customerName: regex },
        { customerPhone: regex },
        { "assignedDriver.name": regex },
        { "storeStops.verificationCode": regex },
        { "storeStops.orderNumber": regex },
      ],
    });
  }

  if (filters.verificationCode) {
    const code = cleanString(filters.verificationCode, { field: "verificationCode", max: 64 });
    if (code) {
      query.$and = query.$and || [];
      query.$and.push({
        $or: [
          { "deliveryProofSnapshot.verificationCode": code },
          { "deliveryProofSnapshot.verificationCodes": code },
          { "storeStops.verificationCode": code },
        ],
      });
    }
  }

  if (filters.customer) {
    const customer = cleanString(filters.customer, { field: "customer", max: 120 });
    if (customer) {
      const regex = new RegExp(escapeRegex(customer), "i");
      query.$and = query.$and || [];
      query.$and.push({
        $or: [
          { "deliveryProofSnapshot.customerName": regex },
          { "deliveryProofSnapshot.customerPhone": regex },
          { customerName: regex },
          { customerPhone: regex },
        ],
      });
    }
  }

  return query;
}

async function listProofs(filters = {}, { companyId = null, includeCompany = true, limit = 50 } = {}) {
  const query = buildProofQuery(filters, { companyId });
  let q = DeliverySession.find(query)
    .select(
      "deliveryProofSnapshot driverDeliveryProof driverDeliveryNote driverDeliveredAt assignedDriver customer customerName customerPhone deliveryCompany orders storeStops status updatedAt",
    )
    .sort({ "deliveryProofSnapshot.deliveredAt": -1, driverDeliveredAt: -1, updatedAt: -1 })
    .limit(Math.min(parseInt(limit, 10) || 50, 200));

  if (includeCompany) {
    q = q.populate("deliveryCompany", "name phone");
  }

  const sessions = await q.lean();
  return sessions.map((s) => formatProofCard(s, { includeCompany }));
}

async function getProofById(proofId, { companyId = null, includeCompany = true } = {}) {
  const id = requireObjectId(proofId, "proofId");
  const query = { _id: id };
  if (companyId) query.deliveryCompany = companyId;

  let q = DeliverySession.findOne(query).select(
    "deliveryProofSnapshot driverDeliveryProof driverDeliveryNote driverDeliveredAt assignedDriver customer customerName customerPhone deliveryCompany orders storeStops status updatedAt",
  );
  if (includeCompany) {
    q = q.populate("deliveryCompany", "name phone");
  }
  const session = await q.lean();
  if (!session) {
    const err = new Error("إثبات التوصيل غير موجود");
    err.status = 404;
    throw err;
  }

  const hasProof = Boolean(
    session.deliveryProofSnapshot?.photo || session.driverDeliveryProof,
  );
  if (!hasProof) {
    const err = new Error("لا يوجد إثبات توصيل لهذا الطلب");
    err.status = 404;
    throw err;
  }

  return formatProofCard(session, { includeCompany });
}

async function listProofFilterOptions({ companyId = null } = {}) {
  const base = {
    status: { $in: [SESSION_STATUSES.COMPLETED, "delivered"] },
    $or: [
      { "deliveryProofSnapshot.photo": { $exists: true, $nin: [null, ""] } },
      { driverDeliveryProof: { $exists: true, $nin: [null, ""] } },
    ],
  };
  if (companyId) base.deliveryCompany = companyId;

  const [companies, drivers] = await Promise.all([
    companyId
      ? []
      : DeliveryCompany.find({ deletedAt: null })
          .select("name")
          .sort({ name: 1 })
          .limit(200)
          .lean(),
    DeliveryCompanyDriver.find(companyId ? { deliveryCompany: companyId } : {})
      .select("name phone deliveryCompany")
      .sort({ name: 1 })
      .limit(300)
      .lean(),
  ]);

  return {
    companies: companies.map((c) => ({ id: c._id, name: c.name })),
    drivers: drivers.map((d) => ({
      id: d._id,
      name: d.name,
      phone: d.phone,
      companyId: d.deliveryCompany,
    })),
  };
}

module.exports = {
  formatProofCard,
  listProofs,
  getProofById,
  listProofFilterOptions,
};
