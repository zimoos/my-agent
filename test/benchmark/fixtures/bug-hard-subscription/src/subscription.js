const DAY_MS = 24 * 60 * 60 * 1000;

function iso(date) {
  return date.toISOString().slice(0, 10);
}

function addMonths(dateText, months) {
  const date = new Date(`${dateText}T00:00:00Z`);
  date.setUTCMonth(date.getUTCMonth() + months);
  return iso(date);
}

function nextBillingDate(subscription, cycles = 1) {
  return addMonths(subscription.anchorDate, cycles);
}

function generateRenewalInvoices(subscription, asOfDate) {
  const next = nextBillingDate(subscription, subscription.invoicesGenerated + 1);
  if (next > asOfDate) return [];
  subscription.invoicesGenerated += 1;
  return [
    {
      periodStart: next,
      amountCents: subscription.monthlyCents,
    },
  ];
}

function proratePlanChange({ currentMonthlyCents, newMonthlyCents, periodStart, periodEnd, changeDate }) {
  const start = new Date(`${periodStart}T00:00:00Z`);
  const end = new Date(`${periodEnd}T00:00:00Z`);
  const change = new Date(`${changeDate}T00:00:00Z`);
  const totalDays = (end.getUTCDate() - start.getUTCDate()) || 1;
  const remainingDays = end.getUTCDate() - change.getUTCDate();
  const delta = newMonthlyCents - currentMonthlyCents;
  return Math.round((delta * remainingDays) / totalDays);
}

module.exports = {
  addMonths,
  nextBillingDate,
  generateRenewalInvoices,
  proratePlanChange,
};
