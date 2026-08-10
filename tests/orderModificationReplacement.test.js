/**
 * Replacement payment rules — run with:
 * node tests/orderModificationReplacement.test.js
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
  console.log("\nOrder Modification Replacement Payment Tests\n");

  await test("parseAdditionalPayment reads flat proof and reference fields", () => {
    const payment = modificationService.parseAdditionalPayment(
      {
        paymentMethod: "bank",
        paymentProof: "https://cdn.example/proof.jpg",
        transferNumber: "REF-42",
        transferName: "أحمد",
        transferPhone: "0599123456",
      },
      "bank",
    );

    assert.equal(payment.proof, "https://cdn.example/proof.jpg");
    assert.equal(payment.transferInformation.referenceNumber, "REF-42");
    assert.equal(payment.method, "bank");
    assert.ok(modificationService.hasDifferencePaymentDetails(payment));
  });

  await test("parseAdditionalPayment reads nested additionalPayment fields", () => {
    const payment = modificationService.parseAdditionalPayment(
      {
        additionalPayment: {
          method: "palpay",
          proof: "https://cdn.example/palpay.jpg",
          transferInformation: {
            referenceNumber: "PP-100",
            senderName: "سارة",
            contactNumber: "0599000000",
          },
        },
      },
      "palpay",
    );

    assert.equal(payment.proof, "https://cdn.example/palpay.jpg");
    assert.equal(payment.transferInformation.referenceNumber, "PP-100");
    assert.ok(modificationService.hasDifferencePaymentDetails(payment));
  });

  await test("hasDifferencePaymentDetails rejects empty payment payload", () => {
    const payment = modificationService.parseAdditionalPayment({}, "bank");
    assert.equal(modificationService.hasDifferencePaymentDetails(payment), false);
  });

  await test("electronic under-budget replacement is blocked", () => {
    assert.throws(
      () => modificationService.assertElectronicReplacementAllowed(
        { paymentMethod: "bank" },
        80,
        100,
      ),
      (err) => err.status === 400 && err.electronicUnderBudgetBlocked === true,
    );
  });

  await test("electronic equal-budget replacement is allowed", () => {
    assert.doesNotThrow(() => modificationService.assertElectronicReplacementAllowed(
      { paymentMethod: "jawwal_pay" },
      100,
      100,
    ));
  });

  await test("cash on delivery under-budget replacement stays allowed", () => {
    assert.doesNotThrow(() => modificationService.assertElectronicReplacementAllowed(
      { paymentMethod: "cash_on_delivery" },
      50,
      100,
    ));
  });

  console.log(`\nResults: ${passed} passed, ${failed} failed\n`);
  process.exit(failed > 0 ? 1 : 0);
})();
