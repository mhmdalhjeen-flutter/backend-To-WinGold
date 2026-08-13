/**
 * Code order export mapping — run with: node tests/codeOrderExport.test.js
 */
const test = require("node:test");
const assert = require("node:assert/strict");
const mongoose = require("mongoose");
const { CARD_SOURCES } = require("../src/constants/storeSubscription.constants");

function mapOrderCodesForExport(orderCodes, promoCodes) {
  const promoById = new Map(promoCodes.map((row) => [String(row._id), row]));
  return orderCodes
    .map((codeId) => promoById.get(String(codeId)))
    .filter(Boolean)
    .map((promoCode) => ({
      code: promoCode.code,
      source: promoCode.cardSource || CARD_SOURCES.INDEPENDENT,
    }))
    .filter((row) => row.code);
}

test("ignores missing promo codes instead of throwing", () => {
  const id1 = new mongoose.Types.ObjectId();
  const idMissing = new mongoose.Types.ObjectId();
  const rows = mapOrderCodesForExport(
    [id1, idMissing],
    [{ _id: id1, code: "WG-001", cardSource: CARD_SOURCES.INDEPENDENT }],
  );
  assert.deepEqual(rows, [{ code: "WG-001", source: CARD_SOURCES.INDEPENDENT }]);
});

test("skips null populate results safely", () => {
  const id1 = new mongoose.Types.ObjectId();
  const rows = mapOrderCodesForExport(
    [id1],
    [],
  );
  assert.deepEqual(rows, []);
});
