// @ts-ignore - node:test types are not installed
import test from 'node:test';
// @ts-ignore - node:assert types are not installed
import assert from 'node:assert';
import { extractJsonLoose } from '../lib/extractJsonLoose.js';

test('extracts JSON from fenced code block', () => {
  const text = 'Here is data:\n```json\n{"a":1}\n```';
  assert.deepStrictEqual(extractJsonLoose(text), { a: 1 });
});

test('extracts JSON from plain text', () => {
  const text = 'prefix {"b":2} suffix';
  assert.deepStrictEqual(extractJsonLoose(text), { b: 2 });
});

test('fixes trailing commas', () => {
  const text = '```json\n{"a":1, "arr":[1,2,],}\n```';
  assert.deepStrictEqual(extractJsonLoose(text), { a: 1, arr: [1, 2] });
});
