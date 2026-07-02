function roundCents(value) {
  return Math.round(value);
}

function calculateInvoice(items, options = {}) {
  const discountPercent = options.discountPercent || 0;
  const taxRate = options.taxRate || 0;
  const subtotalCents = items.reduce((sum, item) => sum + item.unitCents * item.quantity, 0);
  const taxCents = roundCents(subtotalCents * taxRate);
  const discountCents = roundCents((subtotalCents + taxCents) * (discountPercent / 100));
  const totalCents = subtotalCents + taxCents - discountCents;
  return {
    subtotalCents,
    discountCents,
    taxCents,
    totalCents,
    paidCents: 0,
    balanceCents: totalCents,
    status: 'open',
  };
}

function applyPayment(invoice, amountCents) {
  invoice.paidCents = amountCents;
  invoice.balanceCents = invoice.totalCents - amountCents;
  invoice.status = invoice.balanceCents === 0 ? 'paid' : 'open';
  return invoice;
}

module.exports = { calculateInvoice, applyPayment };
