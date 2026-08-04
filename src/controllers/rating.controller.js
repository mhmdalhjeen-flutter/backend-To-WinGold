const ratingService = require("../services/rating.service");

exports.rate = async (req, res) => {
  try {
    const { targetType, targetId, stars } = req.body;
    const s = Number(stars);
    if (!targetType || !targetId || !s || s < 1 || s > 5) {
      return res.status(400).json({ message: "بيانات التقييم غير صالحة (1–5 نجوم)" });
    }
    if (!["store", "offer", "product"].includes(targetType)) {
      return res.status(400).json({ message: "نوع الهدف غير مدعوم" });
    }

    const result = await ratingService.upsertRating({
      userId: req.user.id,
      targetType,
      targetId,
      stars: s,
    });

    res.json({
      message: "تم حفظ تقييمك",
      stars: result.rating.stars,
      ratingAvg: result.ratingAvg,
      ratingCount: result.ratingCount,
    });
  } catch (err) {
    res.status(err.status || 500).json({ message: err.message });
  }
};

exports.getMine = async (req, res) => {
  try {
    const { targetType, targetId } = req.query;
    if (!targetType || !targetId) {
      return res.status(400).json({ message: "targetType و targetId مطلوبان" });
    }
    const rating = await ratingService.getUserRating(req.user.id, targetType, targetId);
    const summary = await ratingService.getTargetRatingsSummary(targetType, targetId);
    res.json({ myStars: rating?.stars ?? null, ...summary });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

exports.getSummary = async (req, res) => {
  try {
    const { targetType, targetId } = req.params;
    const summary = await ratingService.getTargetRatingsSummary(targetType, targetId);
    if (!summary) return res.status(404).json({ message: "العنصر غير موجود" });
    res.json(summary);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};
