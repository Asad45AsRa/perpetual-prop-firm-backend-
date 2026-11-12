import { env } from '../../config/env';
import { ApiError } from '../../utils/api-error';

// ---------------------------------------------------------------------
// Plisio API client. Credentials stay on the server, never in frontend.
// Docs: https://plisio.net/documentation
// ---------------------------------------------------------------------

export interface PlisioInvoice {
  txnId: string;
  invoiceUrl: string;
}

export async function createInvoice(input: {
  orderNumber: string;
  orderName: string;
  amountUsd: string;
  email: string;
}): Promise<PlisioInvoice> {
  const url = new URL(`${env.PLISIO_BASE_URL}/invoices/new`);
  url.search = new URLSearchParams({
    api_key: env.PLISIO_API_KEY,
    source_currency: 'USD',
    source_amount: input.amountUsd,
    order_number: input.orderNumber,
    order_name: input.orderName,
    email: input.email,
    // json=true makes Plisio send the callback as JSON
    callback_url: `${env.PUBLIC_API_URL}/api/v1/payments/plisio/callback?json=true`,
    success_callback_url: `${env.FRONTEND_URL}/dashboard`,
    fail_callback_url: `${env.FRONTEND_URL}/challenges`,
  }).toString();

  const res = await fetch(url);
  const json = (await res.json()) as { status: string; data?: { txn_id: string; invoice_url: string } };
  if (!res.ok || json.status !== 'success' || !json.data) {
    throw new ApiError(502, 'PAYMENT_PROVIDER_ERROR', 'Could not create the payment invoice');
  }
  return { txnId: json.data.txn_id, invoiceUrl: json.data.invoice_url };
}

// Asks Plisio directly for the real invoice status. We never trust only
// the callback body: the status is confirmed with a server-to-server call.
export async function fetchInvoiceStatus(txnId: string): Promise<string> {
  const url = `${env.PLISIO_BASE_URL}/operations/${encodeURIComponent(txnId)}?api_key=${env.PLISIO_API_KEY}`;
  const res = await fetch(url);
  const json = (await res.json()) as { status: string; data?: { status: string } };
  if (!res.ok || json.status !== 'success' || !json.data) {
    throw new ApiError(502, 'PAYMENT_PROVIDER_ERROR', 'Could not read the payment status');
  }
  return json.data.status;
}

export { verifyPlisioSignature } from './plisio.signature';
