const test = require('node:test');
const assert = require('node:assert/strict');
const {
  addMonths,
  nextBillingDate,
  generateRenewalInvoices,
  proratePlanChange,
} = require('../src/subscription');

test('addMonths clamps month-end anchors for leap and non-leap years', () => {
  assert.equal(addMonths('2024-01-31', 1), '2024-02-29');
  assert.equal(addMonths('2023-01-31', 1), '2023-02-28');
  assert.equal(addMonths('2024-01-31', 2), '2024-03-31');
});

test('generateRenewalInvoices catches up every due monthly invoice', () => {
  const subscription = {
    anchorDate: '2024-01-31',
    monthlyCents: 3000,
    invoicesGenerated: 0,
  };

  const invoices = generateRenewalInvoices(subscription, '2024-04-01');
  assert.deepEqual(invoices.map((invoice) => invoice.periodStart), [
    '2024-02-29',
    '2024-03-31',
  ]);
  assert.deepEqual(invoices.map((invoice) => invoice.amountCents), [3000, 3000]);
  assert.equal(subscription.invoicesGenerated, 2);
  assert.deepEqual(generateRenewalInvoices(subscription, '2024-04-01'), []);
});

test('nextBillingDate uses the original anchor rather than prior rollover drift', () => {
  const subscription = { anchorDate: '2024-01-31', invoicesGenerated: 1 };
  assert.equal(nextBillingDate(subscription, 2), '2024-03-31');
});

test('proratePlanChange charges only remaining days in the period', () => {
  const amount = proratePlanChange({
    currentMonthlyCents: 3000,
    newMonthlyCents: 6000,
    periodStart: '2024-03-01',
    periodEnd: '2024-04-01',
    changeDate: '2024-03-16',
  });

  assert.equal(amount, 1548);
});
