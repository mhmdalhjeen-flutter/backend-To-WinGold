const BazaarListing = require("../../models/bazaarListing");
const User = require("../../models/user");
const notificationService = require("../../services/notification.service");
const { assertNoMongoOperators, cleanString, requireObjectId } = require("../../utils/inputSecurity.util");

const POINTS_COST = BazaarListing.POINTS_COST;
const LISTING_DAYS = BazaarListing.LISTING_DAYS;

const POPULATE = [
  { path: "seller", select: "name email phone avatar" },
  { path: "regionId", select: "name" },
  { path: "subRegionId", select: "name" },
  { path: "adminReview.reviewedBy", select: "name email" },
];

const refundPoints = async (userId) => {
  await User.findByIdAndUpdate(userId, { $inc: { points: POINTS_COST } });
};

exports.list = async (req, res) => {
  try {
    const status = cleanString(req.query.status || "pending", { field: "status", max: 20 });
    if (!["all", "pending", "approved", "rejected", "expired"].includes(status)) {
      return res.status(400).json({ message: "status غير صالح" });
    }
    const filter = {};
    if (status !== "all") filter.status = status;

    const listings = await BazaarListing.find(filter)
      .populate(POPULATE)
      .sort({ createdAt: -1 })
      .limit(200);

    res.json({ listings, counts: { pending: await BazaarListing.countDocuments({ status: "pending" }) } });
  } catch (err) {
    res.status(err.status || 500).json({ message: err.message });
  }
};

exports.getOne = async (req, res) => {
  try {
    const id = requireObjectId(req.params.id, "id");
    const listing = await BazaarListing.findById(id).populate(POPULATE);
    if (!listing) return res.status(404).json({ message: "الإعلان غير موجود" });
    res.json({ listing });
  } catch (err) {
    res.status(err.status || 500).json({ message: err.message });
  }
};

exports.approve = async (req, res) => {
  try {
    assertNoMongoOperators(req.body || {}, "review");
    const id = requireObjectId(req.params.id, "id");
    const listing = await BazaarListing.findById(id);
    if (!listing) return res.status(404).json({ message: "الإعلان غير موجود" });
    if (listing.status !== "pending") {
      return res.status(400).json({ message: "الإعلان ليس بانتظار الموافقة" });
    }

    const now = new Date();
    listing.status = "approved";
    listing.isVisible = true;
    listing.expiresAt = new Date(now.getTime() + LISTING_DAYS * 24 * 60 * 60 * 1000);
    listing.renewalWarningSent = false;
    listing.adminReview = {
      reviewedBy: req.user.id,
      reviewedAt: now,
      note: cleanString(req.body?.note, { field: "note", max: 1000 }),
    };
    await listing.save();

    await notificationService.create({
      user: listing.seller,
      type: "bazaar_listing_approved",
      title: "تمت الموافقة على إعلانك",
      body: `إعلان "${listing.title}" أصبح مرئياً في اعرض غراضك لمدة ${LISTING_DAYS} أيام.`,
      data: { listingId: listing._id },
    });

    const populated = await BazaarListing.findById(listing._id).populate(POPULATE);
    res.json({ message: "تم قبول الإعلان", listing: populated });
  } catch (err) {
    res.status(err.status || 500).json({ message: err.message });
  }
};

exports.reject = async (req, res) => {
  try {
    assertNoMongoOperators(req.body || {}, "review");
    const id = requireObjectId(req.params.id, "id");
    const listing = await BazaarListing.findById(id);
    if (!listing) return res.status(404).json({ message: "الإعلان غير موجود" });
    if (listing.status !== "pending") {
      return res.status(400).json({ message: "الإعلان ليس بانتظار الموافقة" });
    }

    listing.status = "rejected";
    listing.isVisible = false;
    listing.adminReview = {
      reviewedBy: req.user.id,
      reviewedAt: new Date(),
      note: cleanString(req.body?.note || "مرفوض من الإدارة", { field: "note", max: 1000 }),
    };
    await listing.save();

    await refundPoints(listing.seller);

    await notificationService.create({
      user: listing.seller,
      type: "bazaar_listing_rejected",
      title: "تم رفض إعلانك في BazaarX",
      body: listing.adminReview.note || `تم رفض إعلان "${listing.title}" واسترداد ${POINTS_COST} نقاط.`,
      data: { listingId: listing._id },
    });

    const populated = await BazaarListing.findById(listing._id).populate(POPULATE);
    res.json({ message: "تم رفض الإعلان واسترداد النقاط", listing: populated });
  } catch (err) {
    res.status(err.status || 500).json({ message: err.message });
  }
};

exports.remove = async (req, res) => {
  try {
    const id = requireObjectId(req.params.id, "id");
    const listing = await BazaarListing.findByIdAndDelete(id);
    if (!listing) return res.status(404).json({ message: "الإعلان غير موجود" });
    res.json({ message: "تم حذف الإعلان" });
  } catch (err) {
    res.status(err.status || 500).json({ message: err.message });
  }
};
