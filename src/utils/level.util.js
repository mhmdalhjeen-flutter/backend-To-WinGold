const STAGES = [
  { id: "bronze", label: "برونزي", min: 0, max: 99, stars: 1, color: "#cd7f32" },
  { id: "silver", label: "فضّي", min: 100, max: 299, stars: 2, color: "#94a3b8" },
  { id: "gold", label: "ذهبي", min: 300, max: 599, stars: 3, color: "#eab308" },
  { id: "platinum", label: "بلاتيني", min: 600, max: Infinity, stars: 4, color: "#a78bfa" },
];

function getStage(points = 0) {
  return STAGES.find((s) => points >= s.min && points <= s.max) || STAGES[0];
}

function getProgress(points = 0) {
  const stage = getStage(points);
  const next = STAGES[STAGES.indexOf(stage) + 1];
  if (!next) return { stage, next: null, progress: 100, pointsToNext: 0 };
  const progress = Math.min(100, ((points - stage.min) / (next.min - stage.min)) * 100);
  return { stage, next, progress, pointsToNext: next.min - points };
}

module.exports = { STAGES, getStage, getProgress };
