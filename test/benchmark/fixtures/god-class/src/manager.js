const fs = require('fs');
const path = require('path');

class Manager {
  constructor(options = {}) {
    this.dataDir = options.dataDir || path.join(__dirname, '..', 'data');
    this.taxRate = options.taxRate != null ? options.taxRate : 0.1;
    this.currency = options.currency || 'USD';
    this.items = [];
    this.history = [];
  }

  loadItems(fileName) {
    const fullPath = path.join(this.dataDir, fileName);
    if (!fs.existsSync(fullPath)) {
      this.items = [];
      return this.items;
    }
    const raw = fs.readFileSync(fullPath, 'utf8');
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      throw new Error('Expected an array of items');
    }
    this.items = parsed.map((it) => ({
      id: String(it.id),
      name: String(it.name || ''),
      price: Number(it.price) || 0,
      quantity: Number(it.quantity) || 0,
    }));
    return this.items;
  }

  saveItems(fileName) {
    if (!fs.existsSync(this.dataDir)) {
      fs.mkdirSync(this.dataDir, { recursive: true });
    }
    const fullPath = path.join(this.dataDir, fileName);
    fs.writeFileSync(fullPath, JSON.stringify(this.items, null, 2), 'utf8');
    return fullPath;
  }

  addItem(item) {
    if (!item || typeof item !== 'object') {
      throw new Error('item must be an object');
    }
    if (!item.id) {
      throw new Error('item.id is required');
    }
    const normalized = {
      id: String(item.id),
      name: String(item.name || ''),
      price: Number(item.price) || 0,
      quantity: Number(item.quantity) || 0,
    };
    this.items.push(normalized);
    this.history.push({ action: 'add', id: normalized.id, at: Date.now() });
    return normalized;
  }

  removeItem(id) {
    const before = this.items.length;
    this.items = this.items.filter((it) => it.id !== String(id));
    const removed = before - this.items.length;
    if (removed > 0) {
      this.history.push({ action: 'remove', id: String(id), at: Date.now() });
    }
    return removed;
  }

  findItem(id) {
    return this.items.find((it) => it.id === String(id)) || null;
  }

  subtotal() {
    return this.items.reduce((sum, it) => sum + it.price * it.quantity, 0);
  }

  tax() {
    return this.subtotal() * this.taxRate;
  }

  total() {
    return this.subtotal() + this.tax();
  }

  applyDiscount(percent) {
    if (typeof percent !== 'number' || percent < 0 || percent > 100) {
      throw new Error('percent must be between 0 and 100');
    }
    const factor = 1 - percent / 100;
    this.items = this.items.map((it) => ({
      ...it,
      price: Number((it.price * factor).toFixed(2)),
    }));
    this.history.push({ action: 'discount', percent, at: Date.now() });
    return this.total();
  }

  formatMoney(amount) {
    const value = Math.round(amount * 100) / 100;
    return `${this.currency} ${value.toFixed(2)}`;
  }

  renderReceipt() {
    const lines = [];
    lines.push('=== Receipt ===');
    for (const it of this.items) {
      const line = `${it.name.padEnd(20, ' ')} x${it.quantity}  ${this.formatMoney(
        it.price * it.quantity
      )}`;
      lines.push(line);
    }
    lines.push(`Subtotal: ${this.formatMoney(this.subtotal())}`);
    lines.push(`Tax (${(this.taxRate * 100).toFixed(1)}%): ${this.formatMoney(this.tax())}`);
    lines.push(`Total: ${this.formatMoney(this.total())}`);
    return lines.join('\n');
  }

  exportCsv() {
    const header = 'id,name,price,quantity';
    const rows = this.items.map(
      (it) => `${it.id},${it.name.replace(/,/g, ' ')},${it.price},${it.quantity}`
    );
    return [header, ...rows].join('\n');
  }
}

module.exports = Manager;
module.exports.Manager = Manager;
