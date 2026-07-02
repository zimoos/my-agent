const test = require('node:test');
const assert = require('node:assert/strict');
const { calculateInvoice, applyPayment } = require('../src/invoice');

test('calculateInvoice applies discount before tax', () => {
  const invoice = calculateInvoice(
    [
      { unitCents: 10000, quantity: 1 },
      { unitCents: 5000, quantity: 1 },
    ],
    { discountPercent: 10, taxRate: 0.08 },
  );

  assert.equal(invoice.subtotalCents, 15000);
  assert.equal(invoice.discountCents, 1500);
  assert.equal(invoice.taxCents, 1080);
  assert.equal(invoice.totalCents, 14580);
});

test('applyPayment accumulates partial payments and marks paid at zero balance', () => {
  const invoice = calculateInvoice([{ unitCents: 10000, quantity: 1 }]);
  applyPayment(invoice, 4000);
  applyPayment(invoice, 6000);

  assert.equal(invoice.paidCents, 10000);
  assert.equal(invoice.balanceCents, 0);
  assert.equal(invoice.status, 'paid');
});

test('applyPayment rejects overpayment without mutating invoice', () => {
  const invoice = calculateInvoice([{ unitCents: 5000, quantity: 1 }]);
  applyPayment(invoice, 3000);

  assert.throws(() => applyPayment(invoice, 3000), /overpay/i);
  assert.equal(invoice.paidCents, 3000);
  assert.equal(invoice.balanceCents, 2000);
});
