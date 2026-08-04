const mongoose = require("mongoose");
const Rating = require("../models/rating");
const Store = require("../models/store");
const Offer = require("../models/offer");
const Product = require("../models/product");

const MODEL_MAP = {
  store: Store,
  offer: Offer,
  product: Product,
};

async function recalculateAggregates(targetType, targetId) {
  const oid = new mongoose.Types.ObjectId(targetId);
  const agg = await Rating.aggregate([
    { $match: { targetType, targetId: oid } },
    { $group: { _id: null, avg: { $avg: "$stars" }, count: { $sum: 1 } } },
  ]);

  const avg = agg[0] ? Math.round(agg[0].avg * 10) / 10 : 0;
  const count = agg[0]?.count || 0;

  const Model = MODEL_MAP[targetType];
  if (Model) {
    await Model.findByIdAndUpdate(targetId, { ratingAvg: avg, ratingCount: count });
  }

  return { ratingAvg: avg, ratingCount: count };
}

async function upsertRating({ userId, targetType, targetId, stars }) {
  const Model = MODEL_MAP[targetType];
  if (!Model) throw Object.assign(new Error("نوع الهدف غير مدعوم"), { status: 400 });

  const target = await Model.findById(targetId);
  if (!target) throw Object.assign(new Error("العنصر غير موجود"), { status: 404 });

  const rating = await Rating.findOneAndUpdate(
    { user: userId, targetType, targetId },
    { stars },
    { upsert: true, new: true, setDefaultsOnInsert: true }
  );

  const aggregates = await recalculateAggregates(targetType, targetId);
  return { rating, ...aggregates };
}

async function getUserRating(userId, targetType, targetId) {
  return Rating.findOne({ user: userId, targetType, targetId }).lean();
}

async function getTargetRatingsSummary(targetType, targetId) {
  const Model = MODEL_MAP[targetType];
  if (!Model) return null;
  const doc = await Model.findById(targetId).select("ratingAvg ratingCount").lean();
  return doc ? { ratingAvg: doc.ratingAvg, ratingCount: doc.ratingCount } : null;
}

module.exports = {
  upsertRating,
  getUserRating,
  getTargetRatingsSummary,
  recalculateAggregates,
};
