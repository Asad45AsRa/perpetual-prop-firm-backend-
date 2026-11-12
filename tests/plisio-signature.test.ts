import { createHmac } from 'crypto';
import { describe, expect, it } from 'vitest';
import { verifyPlisioSignature } from '../src/modules/payments/plisio.signature';

const secret = 'test-secret';

function sign(body: Record<string, unknown>) {
  const ordered: Record<string, unknown> = {};
  Object.keys(body).sort().forEach((k) => (ordered[k] = body[k]));
  return createHmac('sha1', secret).update(JSON.stringify(ordered)).digest('hex');
}

describe('verifyPlisioSignature', () => {
  const body = { order_number: 'abc', status: 'completed', txn_id: '123' };

  it('accepts a correct signature', () => {
    expect(verifyPlisioSignature({ ...body, verify_hash: sign(body) }, secret)).toBe(true);
  });

  it('rejects a changed body', () => {
    expect(verifyPlisioSignature({ ...body, status: 'new', verify_hash: sign(body) }, secret)).toBe(false);
  });

  it('rejects a missing signature or secret', () => {
    expect(verifyPlisioSignature(body, secret)).toBe(false);
    expect(verifyPlisioSignature({ ...body, verify_hash: sign(body) }, '')).toBe(false);
  });
});
