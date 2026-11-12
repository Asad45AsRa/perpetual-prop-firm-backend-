import { createHmac, timingSafeEqual } from 'crypto';

// Verifies the callback signature (HMAC-SHA1 over the sorted JSON body,
// without verify_hash, keyed with the Plisio API key).
// Check this against the current Plisio docs before going live.
export function verifyPlisioSignature(body: Record<string, unknown>, secret: string): boolean {
  const { verify_hash: received, ...rest } = body;
  if (typeof received !== 'string' || !secret) return false;

  const ordered: Record<string, unknown> = {};
  Object.keys(rest)
    .sort()
    .forEach((key) => (ordered[key] = rest[key]));

  const expected = createHmac('sha1', secret).update(JSON.stringify(ordered)).digest('hex');
  const a = Buffer.from(expected);
  const b = Buffer.from(received);
  return a.length === b.length && timingSafeEqual(a, b);
}
