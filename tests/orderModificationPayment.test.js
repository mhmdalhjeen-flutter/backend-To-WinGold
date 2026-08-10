/**
 * Payment modification flows — run with:
 * node tests/orderModificationPayment.test.js
 */
const assert = require("assert");

const modificationService = require("../src/services/orderModification.service");

let passed = 0;
let failed = 0;

async function test(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`  ✓ ${name}`);
  } catch (err) {
    failed += 1;
    console.error(`  ✗ ${name}`);
    console.error(`    ${err.message}`);
  }
}

(async () => {
  console.log("\nOrder Modification Payment Tests\n");

  await test("manual transfer details satisfy difference payment validation", () => {
    const payment = modificationService.parseAdditionalPayment(
      {
        transferName: "محمد",
        transferPhone: "0592090288",
      },
      "bank",
    );
    assert.ok(modificationService.hasDifferencePaymentDetails(payment));
  });

  await test("reference number alone satisfies difference payment validation", () => {
    const payment = modificationService.parseAdditionalPayment(
      { transferNumber: "REF-123" },
      "palpay",
    );
    assert.ok(modificationService.hasDifferencePaymentDetails(payment));
  });

  await test("proof alone satisfies difference payment validation", () => {
    const payment = modificationService.parseAdditionalPayment(
      { paymentProof: "https://cdn.example/proof.jpg" },
      "jawwal_pay",
    );
    assert.ok(modificationService.hasDifferencePaymentDetails(payment));
  });

  await test("payment method change reason is registered", () => {
    assert.equal(
      modificationService.MODIFICATION_REASONS.PAYMENT_METHOD_CHANGE_SUGGESTED,
      "payment_method_change_suggested",
    );
    assert.equal(
      modificationService.MODIFICATION_REASONS.PAYMENT_DATA_REVIEW,
      "payment_data_review",
    );
  });

  console.log(`\nResults: ${passed} passed, ${failed} failed\n`);
  process.exit(failed > 0 ? 1 : 0);
})();
