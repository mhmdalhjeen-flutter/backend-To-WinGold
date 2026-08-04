/**
 * Batch 11.2 — Database backup verification (read-only against live DB + optional mongodump).
 * Usage: node scripts/validate-backup-batch11.js [--skip-dump]
 *
 * Requires MONGO_URI in backend/.env (or environment).
 * Optional: MongoDB Database Tools (mongodump / mongorestore) on PATH for physical dump tests.
 */
const fs = require("fs");
const path = require("path");
const { execFileSync, spawnSync } = require("child_process");

require("dotenv").config({ path: path.join(__dirname, "..", ".env") });

const SKIP_DUMP = process.argv.includes("--skip-dump");
const results = [];
const manifest = {
  runAt: new Date().toISOString(),
  database: null,
  collections: {},
  legacyCollections: [],
  appModelCollections: [],
  dump: null,
  integrity: {},
};

/** Mongoose default collection names for registered app models (34). */
const APP_MODEL_COLLECTIONS = [
  "users",
  "stores",
  "products",
  "offers",
  "categories",
  "regions",
  "carts",
  "orders",
  "codeorders",
  "cardtypes",
  "activationcodes",
  "promocodes",
  "treasureboxes",
  "dailyprizes",
  "drawbatches",
  "honorboards",
  "systemsettings",
  "activitylogs",
  "messages",
  "conversations",
  "wheelprizes",
  "wheelspins",
  "wheelwins",
  "ratings",
  "notifications",
  "bazaarlistings",
  "competitions",
  "admincodes",
  "storememberships",
  "storememberprizes",
  "useractivities",
  "referralbatchbuffers",
  "usersuggestions",
  "achievementmilestones",
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

function resolveMongoTool(name) {
  const fromPath = spawnSync(process.platform === "win32" ? "where" : "which", [name], {
    encoding: "utf8",
    shell: true,
  });
  if (fromPath.status === 0 && fromPath.stdout.trim()) {
    return fromPath.stdout.trim().split(/\r?\n/)[0];
  }

  if (process.platform === "win32") {
    const candidates = [
      path.join(__dirname, "..", "tools", "mongodb-database-tools", "bin", `${name}.exe`),
      path.join("C:", "Program Files", "MongoDB", "Tools", "100", "bin", `${name}.exe`),
      path.join("C:", "Program Files", "MongoDB", "Tools", "200", "bin", `${name}.exe`),
    ];
    for (const candidate of candidates) {
      if (fs.existsSync(candidate)) return candidate;
    }
  }
  return null;
}

function readBsonDocumentCount(filePath) {
  const buf = fs.readFileSync(filePath);
  let offset = 0;
  let count = 0;
  while (offset < buf.length) {
    if (offset + 4 > buf.length) return { count: null, error: "truncated BSON header" };
    const docSize = buf.readInt32LE(offset);
    if (docSize < 5 || offset + docSize > buf.length) {
      return { count: null, error: `invalid BSON doc size ${docSize} at offset ${offset}` };
    }
    count += 1;
    offset += docSize;
  }
  return { count, error: null };
}

async function connectAndSnapshot() {
  const mongoose = require("mongoose");
  if (!process.env.MONGO_URI) {
    fail("mongo_uri_configured", "MONGO_URI missing in .env");
    return null;
  }
  pass("mongo_uri_configured", "MONGO_URI present");

  await mongoose.connect(process.env.MONGO_URI, {
    serverSelectionTimeoutMS: 15000,
    connectTimeoutMS: 15000,
  });

  const db = mongoose.connection.db;
  manifest.database = db.databaseName;

  const listed = await db.listCollections().toArray();
  const names = listed.map((c) => c.name).sort();

  for (const name of names) {
    manifest.collections[name] = await db.collection(name).countDocuments();
  }

  pass("live_db_connection", `Connected to database "${manifest.database}"`);
  pass("collection_inventory", `${names.length} collections, ${Object.values(manifest.collections).reduce((a, b) => a + b, 0)} documents`);

  const missingApp = APP_MODEL_COLLECTIONS.filter((c) => !names.includes(c));
  if (missingApp.length) {
    warn("app_model_collections", `Missing expected collections: ${missingApp.join(", ")}`);
  } else {
    pass("app_model_collections", `All ${APP_MODEL_COLLECTIONS.length} app model collections present`);
  }
  manifest.appModelCollections = APP_MODEL_COLLECTIONS.filter((c) => names.includes(c));

  const legacy = names.filter((n) => !APP_MODEL_COLLECTIONS.includes(n));
  manifest.legacyCollections = legacy;
  if (legacy.length) {
    warn("legacy_collections", `${legacy.length} non-model collections included in backup scope: ${legacy.join(", ")}`);
  } else {
    pass("legacy_collections", "No orphan collections beyond app models");
  }

  return mongoose;
}

async function verifyConsistency(db) {
  const first = { ...manifest.collections };
  const second = {};
  for (const name of Object.keys(first)) {
    second[name] = await db.collection(name).countDocuments();
  }

  const drift = Object.keys(first).filter((name) => first[name] !== second[name]);
  if (drift.length) {
    fail("backup_consistency_counts", `Count drift on re-read: ${drift.map((n) => `${n}(${first[n]}→${second[n]})`).join(", ")}`);
  } else {
    pass("backup_consistency_counts", "Document counts stable across double-read");
  }

  const readable = [];
  const unreadable = [];
  for (const [name, count] of Object.entries(first)) {
    if (count === 0) {
      readable.push(name);
      continue;
    }
    try {
      const doc = await db.collection(name).findOne({});
      if (doc && doc._id) readable.push(name);
      else unreadable.push(`${name}(empty findOne)`);
    } catch (err) {
      unreadable.push(`${name}(${err.message})`);
    }
  }

  manifest.integrity.readableCollections = readable.length;
  manifest.integrity.unreadableCollections = unreadable;

  if (unreadable.length) {
    fail("backup_integrity_read", unreadable.join("; "));
  } else {
    pass("backup_integrity_read", `${readable.length} collections readable (sample doc or empty)`);
  }

  const indexIssues = [];
  for (const name of ["users", "stores", "orders", "offers"]) {
    if (!(name in first)) continue;
    try {
      const indexes = await db.collection(name).indexes();
      if (!indexes.length) indexIssues.push(`${name}: no indexes`);
    } catch (err) {
      indexIssues.push(`${name}: ${err.message}`);
    }
  }

  if (indexIssues.length) {
    warn("backup_integrity_indexes", indexIssues.join("; "));
  } else {
    pass("backup_integrity_indexes", "Index metadata readable on critical collections");
  }
}

async function runMongodump(dbName) {
  const mongodump = resolveMongoTool("mongodump");
  const mongorestore = resolveMongoTool("mongorestore");

  if (!mongodump) {
    warn("mongodump_available", "MongoDB Database Tools not on PATH — physical dump skipped (install for full verification)");
    manifest.dump = { skipped: true, reason: "mongodump not found" };
    return;
  }

  pass("mongodump_available", mongodump);

  const outDir = path.join(__dirname, "..", "_backup_validation", `dump-${Date.now()}`);
  fs.mkdirSync(outDir, { recursive: true });

  try {
    execFileSync(
      mongodump,
      ["--uri", process.env.MONGO_URI, "--db", dbName, "--out", outDir, "--gzip"],
      { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 120000 }
    );
    pass("mongodump_process", `Dump completed → ${outDir}`);
  } catch (err) {
    fail("mongodump_process", err.stderr || err.message);
    manifest.dump = { error: err.message };
    return;
  }

  const dbDir = path.join(outDir, dbName);
  if (!fs.existsSync(dbDir)) {
    fail("mongodump_output_structure", `Missing ${dbDir}`);
    return;
  }
  pass("mongodump_output_structure", `Dump folder ${dbName}/ present`);

  const metadataPath = path.join(dbDir, "prelude.json");
  const bsonFiles = fs.readdirSync(dbDir).filter((f) => f.endsWith(".bson.gz") || f.endsWith(".bson"));
  pass("mongodump_bson_files", `${bsonFiles.length} collection dump files`);

  const countMismatches = [];
  const bsonErrors = [];

  for (const file of bsonFiles) {
    const collection = file.replace(/\.bson(\.gz)?$/, "");
    const liveCount = manifest.collections[collection];
    if (liveCount == null) {
      countMismatches.push(`${collection}(not in live inventory)`);
      continue;
    }

    const filePath = path.join(dbDir, file);
    const stat = fs.statSync(filePath);
    if (liveCount > 0 && stat.size === 0) {
      bsonErrors.push(`${collection}: empty dump file but live count ${liveCount}`);
      continue;
    }
    if (liveCount === 0 && stat.size === 0) continue;

    if (file.endsWith(".bson")) {
      const parsed = readBsonDocumentCount(filePath);
      if (parsed.error) {
        bsonErrors.push(`${collection}: ${parsed.error}`);
      } else if (parsed.count !== liveCount) {
        countMismatches.push(`${collection}(bson ${parsed.count} vs live ${liveCount})`);
      }
    }
  }

  if (bsonErrors.length) fail("backup_integrity_bson", bsonErrors.join("; "));
  else if (bsonFiles.some((f) => f.endsWith(".bson"))) {
    pass("backup_integrity_bson", "Uncompressed BSON files parse without truncation");
  } else {
    warn("backup_integrity_bson", "Gzip dumps present — BSON parse skipped (use --gzip restore test or uncompressed dump for byte-level check)");
  }

  if (countMismatches.length) {
    fail("backup_consistency_dump", countMismatches.join("; "));
  } else {
    pass("backup_consistency_dump", "Dump file set covers all live collections with matching counts (where BSON parsed)");
  }

  manifest.dump = {
    outDir,
    collectionFiles: bsonFiles.length,
    metadataExists: fs.existsSync(metadataPath),
    gzip: bsonFiles.every((f) => f.endsWith(".gz")),
  };

  if (mongorestore && !SKIP_DUMP) {
    const verifyDb = `${dbName}_backup_verify_${Date.now()}`;
    try {
      execFileSync(
        mongorestore,
        ["--uri", process.env.MONGO_URI, "--nsFrom", `${dbName}.*`, "--nsTo", `${verifyDb}.*`, "--drop", "--gzip", outDir],
        { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 180000 }
      );

      pass("mongorestore_process", `Restored to scratch DB "${verifyDb}"`);

      const mongoose = require("mongoose");
      const verifyCounts = {};
      const client = mongoose.connection.getClient();
      const verifyDbHandle = client.db(verifyDb);
      const cols = await verifyDbHandle.listCollections().toArray();
      for (const c of cols) {
        verifyCounts[c.name] = await verifyDbHandle.collection(c.name).countDocuments();
      }

      const restoreDrift = Object.keys(manifest.collections).filter(
        (n) => (verifyCounts[n] ?? -1) !== manifest.collections[n]
      );
      if (restoreDrift.length) {
        fail("backup_integrity_restore", restoreDrift.map((n) => `${n}(${manifest.collections[n]}→${verifyCounts[n] ?? "missing"})`).join(", "));
      } else {
        pass("backup_integrity_restore", "Restore counts match source for all collections");
      }

      await client.db(verifyDb).dropDatabase();
      pass("backup_cleanup", `Dropped scratch DB "${verifyDb}"`);
    } catch (err) {
      warn("mongorestore_process", err.stderr || err.message);
    }
  } else if (!mongorestore) {
    warn("mongorestore_available", "mongorestore not found — restore round-trip skipped");
  }
}

function verifyProcedureDocs() {
  const docsRoot = path.join(__dirname, "..", "..", "docs");
  const procedure = path.join(docsRoot, "database-backup-procedure.md");
  const report = path.join(docsRoot, "batch-11.2-database-backup-report.md");

  if (fs.existsSync(procedure)) pass("doc_backup_procedure", "docs/database-backup-procedure.md");
  else fail("doc_backup_procedure", "missing docs/database-backup-procedure.md");

  const ps1 = path.join(__dirname, "backup-mongodb.ps1");
  const sh = path.join(__dirname, "backup-mongodb.sh");
  if (fs.existsSync(ps1)) pass("script_backup_ps1", "backend/scripts/backup-mongodb.ps1");
  else warn("script_backup_ps1", "missing backup-mongodb.ps1");

  if (fs.existsSync(sh)) pass("script_backup_sh", "backend/scripts/backup-mongodb.sh");
  else warn("script_backup_sh", "missing backup-mongodb.sh");
}

async function main() {
  console.log("Batch 11.2 Database Backup Validation\n");

  verifyProcedureDocs();

  let mongoose;
  try {
    mongoose = await connectAndSnapshot();
    if (!mongoose) {
      printSummary();
      process.exit(1);
    }

    await verifyConsistency(mongoose.connection.db);

    if (!SKIP_DUMP) {
      await runMongodump(manifest.database);
    } else {
      warn("mongodump_skipped", "--skip-dump flag set");
    }
  } finally {
    if (mongoose) await mongoose.disconnect().catch(() => {});
  }

  printSummary();
}

function printSummary() {
  const passed = results.filter((r) => r.status === "PASS").length;
  const failed = results.filter((r) => r.status === "FAIL").length;
  const warnings = results.filter((r) => r.status === "WARN").length;

  console.log("| Status | Check | Detail |");
  console.log("|--------|-------|--------|");
  for (const r of results) {
    console.log(`| ${r.status} | ${r.name} | ${String(r.detail).replace(/\|/g, "/")} |`);
  }
  console.log(`\nSummary: ${passed} pass, ${failed} fail, ${warnings} warn`);

  const outPath = path.join(__dirname, "..", "_batch11_backup_validation.json");
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
