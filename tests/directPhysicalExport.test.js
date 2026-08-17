/**
 * Direct physical export mapping — run with: node tests/directPhysicalExport.test.js
 */
const test = require("node:test");
const assert = require("node:assert/strict");
const { CARD_SOURCES } = require("../src/constants/storeSubscription.constants");

function mapDirectExportCodes(inputCodes, promoDocs) {
  const promoByCode = new Map(promoDocs.map((row) => [row.code, row]));
  return inputCodes.map((row) => {
    const dbRow = promoByCode.get(row.code);
    return {
      code: row.code,
      source: row.cardSource || dbRow?.cardSource || CARD_SOURCES.INDEPENDENT,
      rewardPoints: row.rewardPoints ?? dbRow?.rewardPoints,
    };
  });
}

test("fills rewardPoints from DB when frontend payload omits them", () => {
  const rows = mapDirectExportCodes(
    [{ code: "WG-001" }, { code: "WG-002", rewardPoints: 15 }],
    [
      { code: "WG-001", rewardPoints: 20, cardSource: CARD_SOURCES.INDEPENDENT },
      { code: "WG-002", rewardPoints: 20, cardSource: CARD_SOURCES.INDEPENDENT },
    ],
  );
  assert.deepEqual(rows, [
    { code: "WG-001", source: CARD_SOURCES.INDEPENDENT, rewardPoints: 20 },
    { code: "WG-002", source: CARD_SOURCES.INDEPENDENT, rewardPoints: 15 },
  ]);
});

test("prefers frontend rewardPoints over DB when both exist", () => {
  const rows = mapDirectExportCodes(
    [{ code: "WG-001", rewardPoints: 30 }],
    [{ code: "WG-001", rewardPoints: 20, cardSource: CARD_SOURCES.INDEPENDENT }],
  );
  assert.equal(rows[0].rewardPoints, 30);
});
