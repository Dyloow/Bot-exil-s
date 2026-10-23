import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseRange } from '../src/modules/summary/range.js';

const now = new Date('2026-10-23T12:00:00Z');
const opts = { defaultCount: 100, maxCount: 1000, maxHours: 48, now };

test('parseRange with no args returns the default count', () => {
  assert.deepEqual(parseRange([], opts), { mode: 'count', count: 100 });
});

test('parseRange parses a plain message count', () => {
  assert.deepEqual(parseRange(['150'], opts), { mode: 'count', count: 150 });
});

test('parseRange clamps a count below 10 up to 10', () => {
  assert.deepEqual(parseRange(['3'], opts), { mode: 'count', count: 10 });
});

test('parseRange clamps a count above maxCount down to maxCount', () => {
  assert.deepEqual(parseRange(['5000'], opts), { mode: 'count', count: 1000 });
});

test('parseRange parses hours into a since date', () => {
  const result = parseRange(['2h'], opts);
  assert.equal(result.mode, 'since');
  assert.equal(result.since.toISOString(), new Date(now.getTime() - 2 * 3600 * 1000).toISOString());
  assert.equal(result.label, '2h');
});

test('parseRange parses minutes into a since date', () => {
  const result = parseRange(['30m'], opts);
  assert.equal(result.since.toISOString(), new Date(now.getTime() - 30 * 60 * 1000).toISOString());
  assert.equal(result.label, '30m');
});

test('parseRange parses days (j or d) into a since date', () => {
  const resultJ = parseRange(['1j'], opts);
  assert.equal(resultJ.since.toISOString(), new Date(now.getTime() - 24 * 3600 * 1000).toISOString());
  assert.equal(resultJ.label, '1j');

  const resultD = parseRange(['1d'], opts);
  assert.equal(resultD.since.toISOString(), resultJ.since.toISOString());
});

test('parseRange clamps a duration above maxHours down to the window', () => {
  const result = parseRange(['3j'], opts);
  assert.equal(result.mode, 'since');
  assert.equal(result.since.toISOString(), new Date(now.getTime() - 48 * 3600 * 1000).toISOString());
  assert.equal(result.label, '2j');
});

test('parseRange returns a usage error for invalid input', () => {
  const result = parseRange(['abc'], opts);
  assert.ok(result.error);
  assert.match(result.error, /Utilisation/);
});
