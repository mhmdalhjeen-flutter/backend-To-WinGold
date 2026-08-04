const AchievementMilestone = require("../models/achievementMilestone");
const User = require("../models/user");
const { sanitizeStoredImageUrl } = require("../utils/blockedImageUrl.util");

function sanitizeMilestone(doc) {
  const obj = doc?.toObject ? doc.toObject() : { ...doc };
  if (obj.image) {
    const safe = sanitizeStoredImageUrl(obj.image);
    if (!safe) obj.image = "";
  }
  return obj;
}

async function syncUnlocks(user) {
  const milestones = await AchievementMilestone.find({ isActive: true }).sort({ pointsRequired: 1 });
  const unlockedIds = new Set((user.achievementUnlocks || []).map((u) => String(u.milestone)));
  let changed = false;
  const newlyUnlocked = [];

  for (const m of milestones) {
    if (user.points >= m.pointsRequired && !unlockedIds.has(String(m._id))) {
      user.achievementUnlocks.push({ milestone: m._id, unlockedAt: new Date(), animationSeen: false });
      newlyUnlocked.push(m);
      changed = true;
    }
  }

  if (changed) await user.save();
  return newlyUnlocked;
}

/** عدد الجوائز/الإنجازات المفتوحة حسب النقاط الحالية فقط */
async function countActiveAchievements(userPoints) {
  return AchievementMilestone.countDocuments({
    isActive: true,
    pointsRequired: { $lte: userPoints },
  });
}

exports.listPublic = async (_req, res) => {
  try {
    const milestones = await AchievementMilestone.find({ isActive: true })
      .sort({ sortOrder: 1, pointsRequired: 1 });
    res.json({ milestones: milestones.map(sanitizeMilestone) });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

exports.myProgress = async (req, res) => {
  try {
    const user = await User.findById(req.user.id);
    if (!user) return res.status(404).json({ message: "المستخدم غير موجود" });

    const newlyUnlocked = await syncUnlocks(user);
    const milestones = await AchievementMilestone.find({ isActive: true })
      .sort({ sortOrder: 1, pointsRequired: 1 });

    const unlockMap = new Map(
      (user.achievementUnlocks || []).map((u) => [String(u.milestone), u])
    );

    const road = milestones.map((m) => {
      const unlock = unlockMap.get(String(m._id));
      const unlocked = user.points >= m.pointsRequired;
      return {
        ...sanitizeMilestone(m),
        unlocked,
        animationSeen: unlock?.animationSeen ?? false,
        unlockedAt: unlocked ? unlock?.unlockedAt || null : null,
      };
    });

    res.json({
      points: user.points,
      road,
      newlyUnlocked: newlyUnlocked.map(sanitizeMilestone),
    });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

exports.markSeen = async (req, res) => {
  try {
    const user = await User.findById(req.user.id);
    if (!user) return res.status(404).json({ message: "المستخدم غير موجود" });

    const entry = user.achievementUnlocks.find(
      (u) => String(u.milestone) === String(req.params.id)
    );
    if (entry) {
      entry.animationSeen = true;
      await user.save();
    }
    res.json({ message: "تم" });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

module.exports.syncUnlocks = syncUnlocks;
module.exports.countActiveAchievements = countActiveAchievements;
