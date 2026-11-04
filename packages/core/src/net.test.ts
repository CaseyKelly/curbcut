import { describe, expect, it } from 'vitest';
import { isPrivateAddress } from './net';

describe('isPrivateAddress', () => {
  it.each([
    '127.0.0.1',
    '10.1.2.3',
    '169.254.169.254',
    '224.0.0.1',
    '255.255.255.255',
    '::1',
    '::',
    'fd00::1',
    '::ffff:127.0.0.1',
    '64:ff9b::7f00:1',
    // IPv4-compatible: never public, whatever a stack would do with them.
    '::7f00:1',
    '::a00:1',
    'not-an-ip',
  ])('blocks %s', (address) => {
    expect(isPrivateAddress(address)).toBe(true);
  });

  it.each(['93.184.215.14', '8.8.8.8', '172.32.0.1', '2606:4700::6810:84e5', '::ffff:8.8.8.8'])(
    'allows %s',
    (address) => {
      expect(isPrivateAddress(address)).toBe(false);
    },
  );
});
