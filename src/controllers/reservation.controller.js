const Reservation = require("../models/reservation");
const Product = require("../models/product");
const Offer = require("../models/offer");
const Store = require("../models/store");
const User = require("../models/user");
const notificationService = require("../services/notification.service");
const {
  assertNoMongoOperators,
  cleanString,
  requireObjectId,
} = require("../utils/inputSecurity.util");
const {
  buildReservationAnswers,
  isReservationEnabled,
  normalizeSelectedVariant,
} = require("../utils/reservationSettings.util");

const ITEM_TYPES = {
  product: "Product",
  offer: "Offer",
  Product: "Product",
  Offer: "Offer",
};

function normalizeItemType(raw) {
  const type = ITEM_TYPES[String(raw || "").trim()];
  if (!type) {
    throw Object.assign(new Error("نوع العنصر غير صالح"), { status: 400 });
  }
  return type;
}

function isOfferVisible(offer) {
  if (!offer || offer.isActive === false) return false;
  if (!offer.expiresAt) return true;
  return new Date(offer.expiresAt) > new Date();
}

async function loadReservableItem(itemType, itemId) {
  if (itemType === "Product") {
    const product = await Product.findById(itemId)
      .select("name image isActive store reservationSettings")
      .lean();
    if (!product || product.isActive === false) {
      throw Object.assign(new Error("العنصر غير موجود"), { status: 404 });
    }
    return {
      item: product,
      itemName: product.name || "",
      itemImage: product.image || "",
    };
  }

  const offer = await Offer.findById(itemId)
    .select("title image isActive expiresAt store reservationSettings")
    .lean();
  if (!offer || !isOfferVisible(offer)) {
    throw Object.assign(new Error("العنصر غير موجود"), { status: 404 });
  }
  return {
    item: offer,
    itemName: offer.title || "",
    itemImage: offer.image || "",
  };
}

async function requireOwnedStore(userId) {
  const store = await Store.findOne({ owner: userId, isActive: true }).select("_id name owner").lean();
  if (!store) {
    throw Object.assign(new Error("لا يوجد متجر مرتبط بحسابك"), { status: 404 });
  }
  return store;
}

function serializeReservation(doc) {
  if (!doc) return doc;
  const plain = typeof doc.toObject === "function" ? doc.toObject() : { ...doc };
  if (plain.item && typeof plain.item === "object") {
    plain.item = {
      _id: plain.item._id,
      name: plain.item.name || plain.item.title || plain.itemName,
      title: plain.item.title || plain.item.name || plain.itemName,
      image: plain.item.image || plain.itemImage,
    };
  }
  return plain;
}

exports.createReservation = async (req, res) => {
  try {
    assertNoMongoOperators(req.body, "reservation");
    const itemId = requireObjectId(req.body.itemId || req.body.item, "itemId");
    const itemType = normalizeItemType(req.body.itemType);
    const { item, itemName, itemImage } = await loadReservableItem(itemType, itemId);

    if (!isReservationEnabled(item.reservationSettings)) {
      return res.status(400).json({ message: "الحجز غير متاح لهذا العنصر" });
    }

    const store = await Store.findById(item.store).select("_id name owner isActive subscriptionActive").lean();
    if (!store || store.isActive === false || store.subscriptionActive === false) {
      return res.status(404).json({ message: "المتجر غير متاح" });
    }

    const answers = buildReservationAnswers(item.reservationSettings, req.body.answers);
    const selectedVariant = normalizeSelectedVariant(req.body.selectedVariant || req.body.variant);
    const customer = await User.findById(req.user.id).select("name phone").lean();

    const reservation = await Reservation.create({
      customer: req.user.id,
      store: store._id,
      item: item._id,
      itemType,
      itemName,
      itemImage,
      customerName: customer?.name || "",
      customerPhone: customer?.phone || "",
      selectedVariant,
      answers,
      status: "pending",
    });

    notificationService.create({
      user: store.owner,
      type: "store_new_reservation",
      title: "حجز جديد",
      body: `${reservation.customerName || "زبون"} طلب حجز: ${itemName}`,
      data: {
        pushApp: "store",
        reservationId: reservation._id,
        itemId: item._id,
        itemType,
        storeId: store._id,
        url: "/store/reservations",
      },
    }).catch(() => {});

    res.status(201).json({ message: "تم إرسال الحجز", reservation: serializeReservation(reservation) });
  } catch (err) {
    res.status(err.status || 500).json({ message: err.message });
  }
};

exports.getStoreReservations = async (req, res) => {
  try {
    const store = await requireOwnedStore(req.user.id);
    const status = cleanString(req.query.status, { field: "status", max: 20 });
    const filter = { store: store._id };
    if (status && ["pending", "accepted", "rejected"].includes(status)) {
      filter.status = status;
    }

    const reservations = await Reservation.find(filter)
      .populate("customer", "name phone")
      .populate("item", "name title image")
      .sort({ createdAt: -1 })
      .limit(200)
      .lean();

    res.json({ reservations: reservations.map(serializeReservation) });
  } catch (err) {
    res.status(err.status || 500).json({ message: err.message });
  }
};

exports.getStorePendingCount = async (req, res) => {
  try {
    const store = await requireOwnedStore(req.user.id);
    const count = await Reservation.countDocuments({ store: store._id, status: "pending" });
    res.json({ count });
  } catch (err) {
    res.status(err.status || 500).json({ message: err.message });
  }
};

async function decideReservation(req, res, status) {
  try {
    assertNoMongoOperators(req.body, "reservation");
    const reservationId = requireObjectId(req.params.id, "id");
    const store = await requireOwnedStore(req.user.id);
    const reservation = await Reservation.findOne({ _id: reservationId, store: store._id });
    if (!reservation) {
      return res.status(404).json({ message: "الحجز غير موجود" });
    }
    if (reservation.status !== "pending") {
      return res.status(400).json({ message: "تم اتخاذ قرار مسبقاً لهذا الحجز" });
    }

    reservation.status = status;
    reservation.decisionNote = cleanString(req.body.decisionNote || req.body.note, {
      field: "decisionNote",
      max: 500,
    });
    reservation.decidedAt = new Date();
    reservation.decidedBy = req.user.id;
    await reservation.save();

    const accepted = status === "accepted";
    notificationService.create({
      user: reservation.customer,
      type: accepted ? "reservation_accepted" : "reservation_rejected",
      title: accepted ? "تم قبول الحجز" : "تم رفض الحجز",
      body: accepted
        ? `تم قبول حجزك لـ ${reservation.itemName}`
        : `تم رفض حجزك لـ ${reservation.itemName}`,
      data: {
        reservationId: reservation._id,
        itemId: reservation.item,
        itemType: reservation.itemType,
        storeId: reservation.store,
        decisionNote: reservation.decisionNote || "",
      },
    }).catch(() => {});

    res.json({
      message: accepted ? "تم قبول الحجز" : "تم رفض الحجز",
      reservation: serializeReservation(reservation),
    });
  } catch (err) {
    res.status(err.status || 500).json({ message: err.message });
  }
}

exports.acceptReservation = (req, res) => decideReservation(req, res, "accepted");
exports.rejectReservation = (req, res) => decideReservation(req, res, "rejected");
