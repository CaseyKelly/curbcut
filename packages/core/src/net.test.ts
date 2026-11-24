import { describe, expect, it } from 'vitest';
import { isPrivateAddress } from './net';

describe('isPrivateAddress', () => {
  it.each([
    '127.0.0.1',
    '10.1.2.3',
    '172.16.0.1',
    '172.31.255.255',
    '192.168.1.1',
    '169.254.169.254',
    '100.64.0.1',
    '0.0.0.0',
    '198.18.0.1',
    '224.0.0.1',
    '255.255.255.255',
    '::1',
    '::',
    'fd00::1',
    'fe80::1',
    'fec0::1',
    'ff02::1',
    '::ffff:127.0.0.1',
    '::ffff:10.0.0.1',
    '64:ff9b::7f00:1',
    '64:ff9b::a00:1',
    // IPv4-translated (SIIT): blocked whole, like IPv4-compatible below.
    '::ffff:0:7f00:1',
    '::ffff:0:a00:1',
    '::ffff:0:808:808',
    '0:0:0:0:ffff:0:7f00:1',
    '::ffff:0:127.0.0.1',
    // Documentation and SRv6 ranges.
    '3fff::1',
    '5f00::1',
    // IPv4-compatible: never public, whatever a stack would do with them.
    '::7f00:1',
    '::a00:1',
    'not-an-ip',
  ])('blocks %s', (address) => {
    expect(isPrivateAddress(address)).toBe(true);
  });

  it.each([
    '93.184.215.14',
    '8.8.8.8',
    '172.32.0.1',
    '2606:4700::6810:84e5',
    '::ffff:8.8.8.8',
    '::ffff:808:808',
  ])('allows %s', (address) => {
    expect(isPrivateAddress(address)).toBe(false);
  });
});
