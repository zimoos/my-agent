const Manager = require('../src/manager');

describe('Manager core behavior', () => {
  test('addItem and findItem round-trip', () => {
    const m = new Manager();
    m.addItem({ id: 'a1', name: 'Apple', price: 1.5, quantity: 4 });
    const found = m.findItem('a1');
    expect(found).not.toBeNull();
    expect(found.name).toBe('Apple');
    expect(found.quantity).toBe(4);
  });

  test('subtotal / tax / total compute correctly', () => {
    const m = new Manager({ taxRate: 0.1 });
    m.addItem({ id: 'a', name: 'A', price: 10, quantity: 2 });
    m.addItem({ id: 'b', name: 'B', price: 5, quantity: 1 });
    expect(m.subtotal()).toBeCloseTo(25, 5);
    expect(m.tax()).toBeCloseTo(2.5, 5);
    expect(m.total()).toBeCloseTo(27.5, 5);
  });

  test('removeItem returns number removed', () => {
    const m = new Manager();
    m.addItem({ id: '1', name: 'X', price: 1, quantity: 1 });
    expect(m.removeItem('1')).toBe(1);
    expect(m.removeItem('1')).toBe(0);
  });

  test('applyDiscount reduces prices and returns new total', () => {
    const m = new Manager({ taxRate: 0 });
    m.addItem({ id: '1', name: 'X', price: 10, quantity: 1 });
    const total = m.applyDiscount(50);
    expect(total).toBeCloseTo(5, 5);
  });

  test('renderReceipt contains Total line', () => {
    const m = new Manager();
    m.addItem({ id: '1', name: 'X', price: 10, quantity: 1 });
    const text = m.renderReceipt();
    expect(text).toMatch(/Total:/);
  });

  test('exportCsv contains header and rows', () => {
    const m = new Manager();
    m.addItem({ id: '1', name: 'X', price: 10, quantity: 1 });
    const csv = m.exportCsv();
    expect(csv.split('\n')[0]).toBe('id,name,price,quantity');
    expect(csv).toMatch(/^1,X,10,1$/m);
  });
});
