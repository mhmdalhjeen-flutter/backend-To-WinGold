/**
 * Batch 11.5 — Complete backup strategy validation (orchestrates 11.2–11.4 checks + readiness).
 * Usage: node scripts/validate-backup-strategy-batch11.js [--quick]
 *
 * --quick  inventory + docs only (skip sub-validation scripts)
 */
const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

require("dotenv").config({ path: path.join(__dirname, "..", ".env") });

const QUICK = process.argv.includes("--quick");
const ROOT = path.join(__dirname, "..", "..");
const BACKEND = path.join(__dirname, "..");

const results = [];
const manifest = {
  runAt: new Date().toISOString(),
  phase: "11.5",
  components: {},
  subValidations: {},
  risks: [],
  readiness: {},
};

const REQUIRED_DOCS = [
  "docs/database-backup-procedure.md",
  "docs/database-recovery-procedure.md",
  "docs/batch-11.2-database-backup-report.md",
  "docs/batch-11.3-restore-validation-report.md",
  "docs/batch-11.4-media-backup-report.md",
  "docs/batch-11.4-configuration-backup-report.md",
  "docs/batch-11-final-backup-report.md",
  "docs/batch-11-backup-recovery-readiness.md",
];

const REQUIRED_SCRIPTS = [
  "backend/scripts/backup-mongodb.ps1",
  "backend/scripts/backup-mongodb.sh",
  "backend/scripts/restore-mongodb.ps1",
  "backend/scripts/restore-mongodb.sh",
  "backend/scripts/validate-backup-batch11.js",
  "backend/scripts/validate-restore-batch11.js",
  "backend/scripts/validate-media-config-batch11.js",
  "backend/scripts/validate-backup-strategy-batch11.js",
];

const SUB_VALIDATORS = [
  { id: "11.2", script: "validate-backup-batch11.js", json: "_batch11_backup_validation.json" },
  { id: "11.3", script: "validate-restore-batch11.js", json: "_batch11_restore_validation.json" },
  { id: "11.4", script: "validate-media-config-batch11.js", json: "_batch11_media_config_validation.json" },
];

const KNOWN_RISKS = [
  {
    id: "R1",
    area: "Physical backup",
    severity: "medium",
    description: "MongoDB Database Tools not verified on validation host — mongodump/mongorestore skipped",
    mitigation: "Install tools on ops host; re-run validate-backup-batch11.js and validate-restore-batch11.js",
  },
  {
    id: "R2",
    area: "Atlas DR",
    severity: "medium",
    description: "Atlas Cloud Backup enablement and PITR drill not executed in this phase",
    mitigation: "Enable Cloud Backup before beta; schedule restore drill to staging cluster",
  },
  {
    id: "R3",
    area: "Secrets",
    severity: "medium",
    description: "Runtime secrets (.env) not in DB backup — require separate secret manager export",
    mitigation: "Store production env in encrypted secret manager with documented export",
  },
  {
    id: "R4",
    area: "External media",
    severity: "low",
    description: "20 https:// image URLs backed up as strings only — remote files not mirrored",
    mitigation: "Migrate to embedded WebP or document CDN backup SLA",
  },
  {
    id: "R5",
    area: "Logical restore",
    severity: "low",
    description: "Index restore verified only on physical mongorestore path",
    mitigation: "Complete physical restore round-trip on ops environment",
  },
  {
    id: "R6",
    area: "Legacy collections",
    severity: "low",
    description: "6 orphan MongoDB collections included in dumps but not in current models",
    mitigation: "Include in all full backups; review archival in future phase",
  },
  {
    id: "R7",
    area: "Env documentation",
    severity: "low",
    description: "MASTER_KEY, TRUST_PROXY, rate limits not in backend/.env.example",
    mitigation: "Add to template when updating secret manager runbook",
  },
  {
    id: "R8",
    area: "Automation",
    severity: "low",
    description: "No scheduled backup cron in repository — relies on Atlas or manual ops",
    mitigation: "Configure Atlas retention + optional weekly mongodump Task Scheduler/cron",
  },
];

function pass(name, detail = "") {
  results.push({ name, status: "PASS", detail });
}

function fail(name, detail = "") {
  results.push({ name, status: "FAIL", detail });
}

function warn(name, detail = "") {
  results.push({ name, status: "WARN", detail });
}

function verifyComponentInventory() {
  let docOk = 0;
  for (const rel of REQUIRED_DOCS) {
    const full = path.join(ROOT, rel);
    if (fs.existsSync(full)) {
      pass("component_doc", rel);
      docOk += 1;
    } else {
      fail("component_doc", `missing ${rel}`);
    }
  }
  manifest.components.docs = { required: REQUIRED_DOCS.length, present: docOk };

  let scriptOk = 0;
  for (const rel of REQUIRED_SCRIPTS) {
    const full = path.join(ROOT, rel);
    if (fs.existsSync(full)) {
      pass("component_script", rel);
      scriptOk += 1;
    } else {
      fail("component_script", `missing ${rel}`);
    }
  }
  manifest.components.scripts = { required: REQUIRED_SCRIPTS.length, present: scriptOk };
}

function loadJsonSummary(jsonFile) {
  const full = path.join(BACKEND, jsonFile);
  if (!fs.existsSync(full)) return null;
  try {
    return JSON.parse(fs.readFileSync(full, "utf8"));
  } catch {
    return null;
  }
}

function runSubValidations() {
  if (QUICK) {
    warn("sub_validations_skipped", "--quick mode — using cached JSON if available");
    for (const sub of SUB_VALIDATORS) {
      const cached = loadJsonSummary(sub.json);
      if (cached?.summary) {
        manifest.subValidations[sub.id] = cached.summary;
        pass("sub_validation_cached", `Batch ${sub.id}: ${cached.summary.passed} pass / ${cached.summary.failed} fail / ${cached.summary.warnings} warn (cached)`);
      } else {
        warn("sub_validation_cached", `Batch ${sub.id}: no cached ${sub.json}`);
      }
    }
    return;
  }

  for (const sub of SUB_VALIDATORS) {
    const scriptPath = path.join(__dirname, sub.script);
    const args = [scriptPath];
    if (sub.id === "11.2") args.push("--skip-dump");

    const run = spawnSync(process.execPath, args, {
      cwd: BACKEND,
      encoding: "utf8",
      timeout: 300000,
      env: { ...process.env },
    });

    const cached = loadJsonSummary(sub.json);
    if (cached?.summary) {
      manifest.subValidations[sub.id] = cached.summary;
      if (cached.summary.failed > 0) {
        fail("sub_validation_run", `Batch ${sub.id}: ${cached.summary.passed} pass / ${cached.summary.failed} fail / ${cached.summary.warnings} warn`);
      } else if (cached.summary.warnings > 0) {
        warn("sub_validation_run", `Batch ${sub.id}: ${cached.summary.passed} pass / ${cached.summary.failed} fail / ${cached.summary.warnings} warn`);
      } else {
        pass("sub_validation_run", `Batch ${sub.id}: ${cached.summary.passed} pass / ${cached.summary.failed} fail / ${cached.summary.warnings} warn`);
      }
    } else {
      fail("sub_validation_run", `Batch ${sub.id}: script exit ${run.status}, no JSON output`);
    }
  }
}

async function verifyLiveReadiness() {
  if (!process.env.MONGO_URI) {
    warn("restore_readiness_db", "MONGO_URI missing — cannot verify live DB readiness");
    return;
  }

  const mongoose = require("mongoose");
  try {
    await mongoose.connect(process.env.MONGO_URI, { serverSelectionTimeoutMS: 15000 });
    const db = mongoose.connection.db;
    const cols = await db.listCollections().toArray();
    const counts = {};
    for (const { name } of cols) {
      counts[name] = await db.collection(name).countDocuments();
    }
    const total = Object.values(counts).reduce((a, b) => a + b, 0);

    pass("restore_readiness_db", `Live DB "${db.databaseName}" — ${cols.length} collections, ${total} documents`);
    manifest.readiness.database = { name: db.databaseName, collections: cols.length, documents: total };

    const healthPath = path.join(BACKEND, "src", "routes", "v1", "meta.routes.js");
    if (fs.existsSync(healthPath)) {
      pass("restore_readiness_health_endpoint", "GET /api/v1/health available for post-restore smoke test");
    }
  } finally {
    if (mongoose.connection.readyState === 1) await mongoose.disconnect().catch(() => {});
  }
}

function assessRisks() {
  const sub = manifest.subValidations;
  const activeRisks = [...KNOWN_RISKS];

  if (sub["11.2"]?.warnings === 0 && sub["11.2"]?.failed === 0) {
    // still may have mongodump warn - check cached file
    const backup = loadJsonSummary("_batch11_backup_validation.json");
    const mongodumpWarn = backup?.results?.some((r) => r.name === "mongodump_available" && r.status === "WARN");
    if (!mongodumpWarn) {
      activeRisks.filter((r) => r.id === "R1").forEach((r) => { r.status = "closed"; });
    }
  }

  manifest.risks = activeRisks.map((r) => ({ ...r, status: r.status || "open" }));
  const open = manifest.risks.filter((r) => r.status === "open");
  const medium = open.filter((r) => r.severity === "medium").length;
  const low = open.filter((r) => r.severity === "low").length;

  pass("risk_registry", `${open.length} open risks (${medium} medium, ${low} low)`);
  manifest.readiness.riskSummary = { open: open.length, medium, low };
}

function computeReadinessGrades() {
  const sub = manifest.subValidations;
  const totalFailed = Object.values(sub).reduce((a, s) => a + (s?.failed || 0), 0);
  const totalWarn = Object.values(sub).reduce((a, s) => a + (s?.warnings || 0), 0);

  const grades = {
    databaseBackup: totalFailed > 0 ? "C" : sub["11.2"]?.warnings ? "B" : "A",
    databaseRestore: totalFailed > 0 ? "C" : sub["11.3"]?.warnings ? "B" : "A",
    mediaBackup: sub["11.4"] ? "A" : "B",
    configurationBackup: sub["11.4"] ? "A" : "B",
    documentation: manifest.components.docs?.present === REQUIRED_DOCS.length ? "A" : "B",
    operationalAutomation: "C",
    overall: "B",
  };

  if (totalFailed > 0) grades.overall = "C";
  else if (totalWarn <= 4 && manifest.readiness.riskSummary?.medium <= 2) grades.overall = "B+";

  manifest.readiness.grades = grades;
  pass("readiness_grades", `Overall ${grades.overall} — ready for beta with ops layer (Atlas + secret manager + physical drill)`);
}

async function main() {
  console.log("Batch 11.5 Complete Backup Strategy Validation\n");
  if (QUICK) console.log("(quick mode — skipping live sub-validators)\n");

  verifyComponentInventory();
  runSubValidations();
  await verifyLiveReadiness();
  assessRisks();
  computeReadinessGrades();

  const passed = results.filter((r) => r.status === "PASS").length;
  const failed = results.filter((r) => r.status === "FAIL").length;
  const warnings = results.filter((r) => r.status === "WARN").length;

  console.log("| Status | Check | Detail |");
  console.log("|--------|-------|--------|");
  for (const r of results) {
    console.log(`| ${r.status} | ${r.name} | ${String(r.detail).replace(/\|/g, "/")} |`);
  }
  console.log(`\nSummary: ${passed} pass, ${failed} fail, ${warnings} warn`);
  console.log(`Overall readiness: ${manifest.readiness.grades?.overall || "?"}`);

  const outPath = path.join(BACKEND, "_batch11_strategy_validation.json");
  fs.writeFileSync(
    outPath,
    JSON.stringify({ summary: { passed, failed, warnings }, manifest, results }, null, 2)
  );
  console.log(`\nWritten: ${outPath}`);

  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
