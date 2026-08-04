/**
 * Batch 11.3 — Restore validation (scratch DB restore + post-restore consistency checks).
 * Usage: node scripts/validate-restore-batch11.js [--physical-only] [--logical-only]
 *
 * Requires MONGO_URI in backend/.env.
 * Physical path: MongoDB Database Tools (mongodump + mongorestore).
 * Logical path: driver copy to scratch DB when tools unavailable (data only, indexes not copied).
 */
const fs = require("fs");
const path = require("path");
const { execFileSync, spawnSync } = require("child_process");

require("dotenv").config({ path: path.join(__dirname, "..", ".env") });

const PHYSICAL_ONLY = process.argv.includes("--physical-only");
const LOGICAL_ONLY = process.argv.includes("--logical-only");

const CRITICAL_COLLECTIONS = ["users", "stores", "orders", "offers", "products"];
const results = [];
const manifest = {
  runAt: new Date().toISOString(),
  sourceDatabase: null,
  scratchDatabase: null,
  sourceCollections: {},
  restoreMethod: null,
  fingerprints: { source: {}, restored: {} },
  postRestore: {},
};

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

async function snapshotCounts(db) {
  const counts = {};
  const listed = await db.listCollections().toArray();
  for (const { name } of listed.sort((a, b) => a.name.localeCompare(b.name))) {
    counts[name] = await db.collection(name).countDocuments();
  }
  return counts;
}

async function collectionFingerprint(db, name) {
  const coll = db.collection(name);
  const count = await coll.countDocuments();
  if (count === 0) {
    return { count: 0, firstId: null, lastId: null, aggSum: null };
  }

  const [firstDoc, lastDoc] = await Promise.all([
    coll.find({}).sort({ _id: 1 }).limit(1).project({ _id: 1 }).toArray(),
    coll.find({}).sort({ _id: -1 }).limit(1).project({ _id: 1 }).toArray(),
  ]);

  let aggSum = null;
  if (name === "orders") {
    const agg = await coll.aggregate([{ $group: { _id: null, s: { $sum: "$total" } } }]).toArray();
    aggSum = agg[0]?.s ?? 0;
  }
  if (name === "users") {
    aggSum = await coll.countDocuments({ email: { $exists: true, $ne: null } });
  }

  return {
    count,
    firstId: String(firstDoc[0]._id),
    lastId: String(lastDoc[0]._id),
    aggSum,
  };
}

function fingerprintsMatch(a, b) {
  return a.count === b.count && a.firstId === b.firstId && a.lastId === b.lastId && a.aggSum === b.aggSum;
}

async function dropScratchDb(client, dbName) {
  if (!dbName) return;
  try {
    await client.db(dbName).dropDatabase();
    pass("restore_cleanup", `Dropped scratch DB "${dbName}"`);
  } catch (err) {
    warn("restore_cleanup", err.message);
  }
}

async function compareRestored(sourceDb, restoredDb, includeIndexes) {
  const sourceCounts = await snapshotCounts(sourceDb);
  const restoredCounts = await snapshotCounts(restoredDb);

  const countDrift = Object.keys(sourceCounts).filter((n) => {
    const src = sourceCounts[n];
    const res = restoredCounts[n] ?? 0;
    return src !== res;
  });
  if (countDrift.length) {
    fail(
      "restore_consistency_counts",
      countDrift.map((n) => `${n}(${sourceCounts[n]}→${restoredCounts[n] ?? "missing"})`).join(", ")
    );
  } else {
    pass(
      "restore_consistency_counts",
      `${Object.keys(sourceCounts).length} collections — counts match source`
    );
  }

  const fpDrift = [];
  for (const name of CRITICAL_COLLECTIONS) {
    if (!(name in sourceCounts)) continue;
    manifest.fingerprints.source[name] = await collectionFingerprint(sourceDb, name);
    manifest.fingerprints.restored[name] = await collectionFingerprint(restoredDb, name);
    if (!fingerprintsMatch(manifest.fingerprints.source[name], manifest.fingerprints.restored[name])) {
      fpDrift.push(name);
    }
  }

  if (fpDrift.length) {
    fail("restore_consistency_fingerprints", `Critical collection drift: ${fpDrift.join(", ")}`);
  } else {
    pass("restore_consistency_fingerprints", `Fingerprints match on ${CRITICAL_COLLECTIONS.join(", ")}`);
  }

  const orderSample = await sourceDb.collection("orders").findOne({});
  if (orderSample?.customer) {
    const customerId = orderSample.customer;
    const inSource = await sourceDb.collection("users").countDocuments({ _id: customerId });
    const inRestored = await restoredDb.collection("users").countDocuments({ _id: customerId });
    if (inSource === 1 && inRestored === 1) {
      pass("restore_consistency_references", "Order→user reference intact after restore");
    } else {
      fail("restore_consistency_references", `customer ${customerId} source=${inSource} restored=${inRestored}`);
    }
  } else {
    warn("restore_consistency_references", "No orders with customer ref to spot-check");
  }

  if (includeIndexes) {
    const indexIssues = [];
    for (const name of CRITICAL_COLLECTIONS) {
      if (!(name in sourceCounts)) continue;
      const srcIdx = (await sourceDb.collection(name).indexes()).map((i) => i.name).sort();
      const resIdx = (await restoredDb.collection(name).indexes()).map((i) => i.name).sort();
      if (srcIdx.join(",") !== resIdx.join(",")) {
        indexIssues.push(`${name}(source:${srcIdx.length} restored:${resIdx.length})`);
      }
    }
    if (indexIssues.length) {
      fail("restore_integrity_indexes", indexIssues.join("; "));
    } else {
      pass("restore_integrity_indexes", "Index definitions match on critical collections");
    }
  } else {
    warn("restore_integrity_indexes", "Logical restore — indexes not copied (physical mongorestore required for index verification)");
  }

  manifest.postRestore = {
    collectionsCompared: Object.keys(sourceCounts).length,
    countDrift: countDrift.length,
    fingerprintDrift: fpDrift.length,
  };
}

async function logicalRestore(sourceDb, client, sourceDbName) {
  const scratchName = `${sourceDbName}_restore_verify_${Date.now()}`;
  manifest.scratchDatabase = scratchName;
  manifest.restoreMethod = "logical";

  const restoredDb = client.db(scratchName);
  const collections = Object.keys(manifest.sourceCollections);

  pass("restore_process_logical", `Copying ${collections.length} collections → "${scratchName}"`);

  for (const name of collections) {
    const count = manifest.sourceCollections[name];
    if (count === 0) continue;

    const docs = await sourceDb.collection(name).find({}).toArray();
    if (docs.length) {
      await restoredDb.collection(name).insertMany(docs, { ordered: false });
    }
  }

  pass("restore_backup_restoration", `Logical copy complete — ${collections.length} collections processed`);
  await compareRestored(sourceDb, restoredDb, false);
  return scratchName;
}

async function physicalRestore(sourceDb, client, sourceDbName) {
  const mongodump = resolveMongoTool("mongodump");
  const mongorestore = resolveMongoTool("mongorestore");

  if (!mongodump || !mongorestore) {
    return null;
  }

  pass("mongorestore_available", mongorestore);
  pass("mongodump_available", mongodump);

  const outDir = path.join(__dirname, "..", "_restore_validation", `dump-${Date.now()}`);
  fs.mkdirSync(outDir, { recursive: true });

  execFileSync(
    mongodump,
    ["--uri", process.env.MONGO_URI, "--db", sourceDbName, "--out", outDir, "--gzip"],
    { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 120000 }
  );
  pass("restore_prerequisite_dump", `mongodump completed → ${outDir}`);

  const scratchName = `${sourceDbName}_restore_verify_${Date.now()}`;
  manifest.scratchDatabase = scratchName;
  manifest.restoreMethod = "physical";

  execFileSync(
    mongorestore,
    [
      "--uri",
      process.env.MONGO_URI,
      "--nsFrom",
      `${sourceDbName}.*`,
      "--nsTo",
      `${scratchName}.*`,
      "--drop",
      "--gzip",
      outDir,
    ],
    { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 180000 }
  );

  pass("restore_process_physical", `mongorestore completed → "${scratchName}"`);
  pass("restore_backup_restoration", "Physical backup restored to scratch database");

  const restoredDb = client.db(scratchName);
  await compareRestored(sourceDb, restoredDb, true);
  manifest.dumpDir = outDir;
  return scratchName;
}

function verifyProcedureDocs() {
  const docsRoot = path.join(__dirname, "..", "..", "docs");
  const recovery = path.join(docsRoot, "database-recovery-procedure.md");
  const backup = path.join(docsRoot, "database-backup-procedure.md");

  if (fs.existsSync(recovery)) pass("doc_recovery_procedure", "docs/database-recovery-procedure.md");
  else fail("doc_recovery_procedure", "missing docs/database-recovery-procedure.md");

  if (fs.existsSync(backup)) pass("doc_backup_procedure_linked", "docs/database-backup-procedure.md");
  else warn("doc_backup_procedure_linked", "backup procedure doc missing");

  const ps1 = path.join(__dirname, "restore-mongodb.ps1");
  const sh = path.join(__dirname, "restore-mongodb.sh");
  if (fs.existsSync(ps1)) pass("script_restore_ps1", "backend/scripts/restore-mongodb.ps1");
  else fail("script_restore_ps1", "missing restore-mongodb.ps1");
  if (fs.existsSync(sh)) pass("script_restore_sh", "backend/scripts/restore-mongodb.sh");
  else fail("script_restore_sh", "missing restore-mongodb.sh");
}

async function main() {
  console.log("Batch 11.3 Restore Validation\n");

  verifyProcedureDocs();

  if (!process.env.MONGO_URI) {
    fail("mongo_uri_configured", "MONGO_URI missing in .env");
    printSummary();
    process.exit(1);
  }
  pass("mongo_uri_configured", "MONGO_URI present");

  const mongoose = require("mongoose");
  let scratchName = null;

  try {
    await mongoose.connect(process.env.MONGO_URI, {
      serverSelectionTimeoutMS: 15000,
      connectTimeoutMS: 15000,
    });

    const sourceDb = mongoose.connection.db;
    const client = mongoose.connection.getClient();
    manifest.sourceDatabase = sourceDb.databaseName;
    manifest.sourceCollections = await snapshotCounts(sourceDb);

    const totalDocs = Object.values(manifest.sourceCollections).reduce((a, b) => a + b, 0);
    pass("source_db_connection", `Connected to "${manifest.sourceDatabase}"`);
    pass("source_collection_inventory", `${Object.keys(manifest.sourceCollections).length} collections, ${totalDocs} documents`);

    if (!LOGICAL_ONLY) {
      scratchName = await physicalRestore(sourceDb, client, manifest.sourceDatabase);
    }

    if (!scratchName && !PHYSICAL_ONLY) {
      warn("physical_restore_skipped", "mongodump/mongorestore unavailable — using logical scratch restore");
      scratchName = await logicalRestore(sourceDb, client, manifest.sourceDatabase);
    } else if (!scratchName && PHYSICAL_ONLY) {
      fail("restore_process_physical", "Physical restore required but MongoDB Database Tools not found");
    }
  } finally {
    if (mongoose.connection.readyState === 1) {
      const client = mongoose.connection.getClient();
      await dropScratchDb(client, scratchName || manifest.scratchDatabase);
      await mongoose.disconnect().catch(() => {});
    }
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
  console.log(`Restore method: ${manifest.restoreMethod || "none"}`);

  const outPath = path.join(__dirname, "..", "_batch11_restore_validation.json");
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
