function createCatalog() {
  return {
    products: new Map([
      ['pro-plan', { sku: 'pro-plan', name: 'Pro Plan', priceCents: 10000, stock: 5 }],
      ['addon-seat', { sku: 'addon-seat', name: 'Addon Seat', priceCents: 2500, stock: 10 }],
    ]),
  };
}

function getProduct(catalog, sku) {
  return catalog.products.get(sku) || null;
}

function adjustStock(catalog, sku, delta) {
  const product = getProduct(catalog, sku);
  if (!product) throw new Error(`unknown sku: ${sku}`);
  product.stock += delta;
  return product.stock;
}

module.exports = { createCatalog, getProduct, adjustStock };
