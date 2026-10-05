'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const core = require('../senko-billmgr-totals.user.js');

const date = (y, m, d) => new Date(y, m - 1, d);
const TODAY = date(2026, 10, 5);

test('parseMoney understands the usual number formats', () => {
  assert.deepEqual(core.parseMoney('7.35 €'), { cents: 735, currency: '€' });
  assert.deepEqual(core.parseMoney(' 1.25 € '), { cents: 125, currency: '€' });
  assert.deepEqual(core.parseMoney('1 234,50 ₽'), { cents: 123450, currency: '₽' });
  assert.deepEqual(core.parseMoney('1,234.50 $'), { cents: 123450, currency: '$' });
  assert.deepEqual(core.parseMoney('1.234,50 EUR'), { cents: 123450, currency: '€' });
  assert.deepEqual(core.parseMoney('−3.10 €'), { cents: -310, currency: '€' });
  assert.equal(core.parseMoney('—'), null);
  assert.equal(core.parseMoney(''), null);
});

test('parsePeriod reads Russian billing periods', () => {
  assert.deepEqual(core.parsePeriod('Месяц'), { months: 1, days: 0 });
  assert.deepEqual(core.parsePeriod('3 месяца'), { months: 3, days: 0 });
  assert.deepEqual(core.parsePeriod('Год'), { months: 12, days: 0 });
  assert.deepEqual(core.parsePeriod('Квартал'), { months: 3, days: 0 });
  assert.deepEqual(core.parsePeriod('Неделя'), { months: 0, days: 7 });
  assert.deepEqual(core.parsePeriod('Сутки'), { months: 0, days: 1 });
  assert.equal(core.parsePeriod('что-то странное'), null);
  assert.equal(core.parsePeriod(''), null);
});

test('parseCost splits price and period', () => {
  const cost = core.parseCost('7.35 € / Месяц');
  assert.equal(cost.cents, 735);
  assert.equal(cost.currency, '€');
  assert.deepEqual(cost.period, { months: 1, days: 0 });
  assert.equal(cost.periodGuessed, false);

  assert.equal(core.parseCost('7.35 € / непонятно').periodGuessed, true);
  assert.equal(core.parseCost('7.35 €').periodGuessed, false);
  assert.equal(core.parseCost('нет цены'), null);
});

test('addMonths clamps to the last day of a shorter month', () => {
  assert.deepEqual(core.addMonths(date(2026, 1, 31), 1), date(2026, 2, 28));
  assert.deepEqual(core.addMonths(date(2028, 1, 31), 1), date(2028, 2, 29));
  assert.deepEqual(core.addMonths(date(2026, 10, 5), 1), date(2026, 11, 5));
  assert.deepEqual(core.addMonths(date(2026, 11, 30), 3), date(2027, 2, 28));
});

test('parseDate accepts ISO and dotted dates', () => {
  assert.deepEqual(core.parseDate('2026-10-20'), date(2026, 10, 20));
  assert.deepEqual(core.parseDate('20.10.2026'), date(2026, 10, 20));
  assert.equal(core.parseDate(''), null);
});

const row = (name, expire, cost, status = 'Активен') => ({ name, note: '', status, expire, cost });

test('analyze: only services expiring before the horizon need a payment', () => {
  const rows = [
    row('a', '2026-10-20', '4.00 € / Месяц'),
    row('b', '2026-10-22', '8.50 € / Месяц'),
    row('c', '2026-12-01', '10.00 € / Месяц'),
  ];
  const result = core.analyze(rows, { today: TODAY, months: 1, balance: { cents: 100, currency: '€' } });

  assert.deepEqual(result.monthly, { '€': 2250 });
  assert.deepEqual(result.due, { '€': 1250 });
  assert.deepEqual(result.topUp, { '€': 1150 });
  assert.equal(result.dueCount, 2);
  assert.deepEqual(result.nextExpiry, date(2026, 10, 20));
  assert.deepEqual(result.horizon, date(2026, 11, 5));
});

test('analyze: a longer horizon needs several renewals per service', () => {
  const rows = [
    row('a', '2026-10-20', '4.00 € / Месяц'),
    row('b', '2026-12-01', '10.00 € / Месяц'),
  ];
  // horizon = 2027-01-05: a renews Nov 20, Dec 20, Jan 20 (3x); b renews Jan 1, Feb 1 (2x)
  const result = core.analyze(rows, { today: TODAY, months: 3, balance: null });
  assert.deepEqual(result.items.map((i) => i.renewals), [3, 2]);
  assert.deepEqual(result.due, { '€': 1200 + 2000 });
});

test('analyze: an expired service restarts from today', () => {
  const rows = [row('a', '2026-09-01', '5.00 € / Месяц')];
  const result = core.analyze(rows, { today: TODAY, months: 1, balance: null });
  assert.equal(result.items[0].renewals, 1);
  assert.deepEqual(result.due, { '€': 500 });
});

test('analyze: balance that covers everything leaves nothing to top up', () => {
  const rows = [row('a', '2026-10-20', '4.00 € / Месяц')];
  const result = core.analyze(rows, { today: TODAY, months: 1, balance: { cents: 1000, currency: '€' } });
  assert.deepEqual(result.topUp, { '€': -600 });
});

test('analyze: balance in another currency is not subtracted', () => {
  const rows = [row('a', '2026-10-20', '4.00 € / Месяц')];
  const result = core.analyze(rows, { today: TODAY, months: 1, balance: { cents: 1000, currency: '₽' } });
  assert.deepEqual(result.topUp, { '€': 400 });
});

test('analyze: yearly prices are normalised to a month, renewal uses the full period', () => {
  const rows = [row('a', '2026-10-20', '120.00 € / Год')];
  const result = core.analyze(rows, { today: TODAY, months: 1, balance: null });
  assert.deepEqual(result.monthly, { '€': 1000 });
  assert.deepEqual(result.due, { '€': 12000 });
});

test('analyze: deleted services and unparsable prices are skipped and reported', () => {
  const rows = [
    row('a', '2026-10-20', '4.00 € / Месяц'),
    row('gone', '2026-10-20', '9.00 € / Месяц', 'Удалён'),
    row('free', '2026-10-20', 'бесплатно'),
  ];
  const result = core.analyze(rows, { today: TODAY, months: 1, balance: null });
  assert.equal(result.items.length, 1);
  assert.equal(result.issues.noPrice, 1);
});

test('analyze: a service without an expiry date counts in the total but never needs a payment', () => {
  const rows = [row('a', '', '4.00 € / Месяц')];
  const result = core.analyze(rows, { today: TODAY, months: 1, balance: null });
  assert.deepEqual(result.monthly, { '€': 400 });
  assert.deepEqual(result.due, {});
});

test('formatting helpers', () => {
  assert.equal(core.formatMoney(8765, '€'), '87.65 €');
  assert.equal(core.formatMoney(123456789, '€'), '1 234 567.89 €');
  assert.equal(core.formatMoney(-125, '€'), '−1.25 €');
  assert.equal(core.formatMoneyMap({}, '€'), '0.00 €');
  assert.equal(core.formatDate(date(2026, 11, 5)), '05.11.2026');
  assert.equal(core.plural(1, 'услуга', 'услуги', 'услуг'), 'услуга');
  assert.equal(core.plural(7, 'услуга', 'услуги', 'услуг'), 'услуг');
  assert.equal(core.plural(22, 'услуга', 'услуги', 'услуг'), 'услуги');
  assert.equal(core.plural(11, 'услуга', 'услуги', 'услуг'), 'услуг');
  assert.equal(core.daysUntil(date(2026, 10, 20), TODAY), 'через 15 дн.');
  assert.equal(core.daysUntil(TODAY, TODAY), 'сегодня');
  assert.equal(core.daysUntil(date(2026, 10, 3), TODAY), 'просрочено на 2 дн.');
});
