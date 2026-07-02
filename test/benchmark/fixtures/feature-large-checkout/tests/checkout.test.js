const test = require('node:test');
const assert = require('node:assert/strict');
const { createCatalog, getProduct } = require('../src/catalog');
const { createCart, addItem } = require('../src/cart');
const { checkout } = require('../src/checkout');

test('checkout builds an order, applies SAVE10, tax, and deducts stock', () => {
  const catalog = createCatalog();
  const cart = createCart();
  addItem(cart, 'pro-plan', 2);
  addItem(cart, 'addon-seat', 2);

  const order = checkout({
    catalog,
    cart,
    couponCode: 'SAVE10',
    taxRate: 0.08,
    idempotencyKey: 'order-1',
  });

  assert.equal(order.subtotalCents, 25000);
  assert.equal(order.discountCents, 2500);
  assert.equal(order.taxCents, 1800);
  assert.equal(order.totalCents, 24300);
  assert.deepEqual(order.lines.map((line) => [line.sku, line.quantity, line.lineTotalCents]), [
    ['pro-plan', 2, 20000],
    ['addon-seat', 2, 5000],
  ]);
  assert.equal(getProduct(catalog, 'pro-plan').stock, 3);
  assert.equal(getProduct(catalog, 'addon-seat').stock, 8);
});

test('checkout validates all stock before mutating inventory', () => {
  const catalog = createCatalog();
  const cart = createCart();
  addItem(cart, 'pro-plan', 99);

  assert.throws(() => checkout({ catalog, cart, taxRate: 0.08 }), /insufficient stock/i);
  assert.equal(getProduct(catalog, 'pro-plan').stock, 5);
});

test('checkout is idempotent for the same idempotency key', () => {
  const catalog = createCatalog();
  const cart = createCart();
  addItem(cart, 'pro-plan', 1);

  const first = checkout({ catalog, cart, idempotencyKey: 'same-key' });
  const second = checkout({ catalog, cart, idempotencyKey: 'same-key' });

  assert.equal(first.id, second.id);
  assert.equal(second.totalCents, first.totalCents);
  assert.equal(getProduct(catalog, 'pro-plan').stock, 4);
});
