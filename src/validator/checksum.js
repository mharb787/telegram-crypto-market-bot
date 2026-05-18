import { createHash } from 'node:crypto';

const BASE58_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

/**
 * Decodes a Base58 string to a Buffer.
 * Returns null if any character is outside the Base58 alphabet.
 */
export function base58Decode(str) {
  let num = 0n;
  for (const char of str) {
    const idx = BASE58_ALPHABET.indexOf(char);
    if (idx === -1) return null;
    num = num * 58n + BigInt(idx);
  }

  // Convert BigInt to bytes
  const bytes = [];
  while (num > 0n) {
    bytes.unshift(Number(num & 0xffn));
    num >>= 8n;
  }

  // Add leading zero-bytes for every leading '1' in the input
  for (const char of str) {
    if (char !== '1') break;
    bytes.unshift(0);
  }

  return Buffer.from(bytes);
}

/**
 * Verifies the Base58Check checksum of a decoded address buffer.
 * The last 4 bytes are the checksum of the first (len-4) bytes double-SHA256'd.
 */
export function verifyChecksum(buf) {
  if (!buf || buf.length < 5) return false;
  const payload  = buf.subarray(0, buf.length - 4);
  const checksum = buf.subarray(buf.length - 4);
  const hash = createHash('sha256')
    .update(createHash('sha256').update(payload).digest())
    .digest();
  return hash.subarray(0, 4).equals(checksum);
}
