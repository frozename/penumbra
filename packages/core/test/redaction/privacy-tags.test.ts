import { expect, test } from 'bun:test';
import { stripPrivacyTags } from '../../src/redaction/privacy-tags.js';

test('removes content inside <private>...</private>', () => {
  expect(stripPrivacyTags('keep <private>drop me</private> keep')).toBe('keep  keep');
});

test('handles multiple tags', () => {
  expect(stripPrivacyTags('a <private>x</private> b <private>y</private> c'))
    .toBe('a  b  c');
});

test('leaves text without tags unchanged', () => {
  expect(stripPrivacyTags('no tags here')).toBe('no tags here');
});

test('handles multiline content', () => {
  const src = 'start\n<private>\nsecret line 1\nsecret line 2\n</private>\nend';
  expect(stripPrivacyTags(src)).toBe('start\n\nend');
});
