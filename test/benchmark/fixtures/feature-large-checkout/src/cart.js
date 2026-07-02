function createCart() {
  return [];
}

function addItem(cart, sku, quantity) {
  cart.push({ sku, quantity });
  return cart;
}

module.exports = { createCart, addItem };
