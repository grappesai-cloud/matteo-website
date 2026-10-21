// === STRIPE PENTRU CONTABILITATE: cine a plătit, ce comandă, ce factură ===
// Contabila scoate lunar din Stripe raportul „Payout reconciliation” și vrea pe
// fiecare plată numele clientului (coloana customer_name). Stripe îl ia din
// Customer-ul legat de plată, deci la checkout creăm un Customer cu numele,
// telefonul și adresa din formularul nostru (unul per comandă, cu numele de atunci).
// Numărul comenzii și factura SmartBill apar abia după plată: le scriem pe plată
// ulterior, în metadata (coloanele payment_metadata[comanda] / [factura]).
// Plățile vechi rămân neatinse.

import type Stripe from 'stripe';
import type { Order, OrderAddress } from './orders';

/** „SHOP0106” — cum apare factura în SmartBill. */
export function invoiceLabel(o: Pick<Order, 'invoiceSeries' | 'invoiceNumber'>): string {
  return o.invoiceNumber ? `${o.invoiceSeries || ''}${o.invoiceNumber}` : '';
}

/** Metadata de pus pe plată: ce se știe deja despre comanda asta. */
export function paymentStamp(o: Pick<Order, 'number' | 'invoiceSeries' | 'invoiceNumber'>): Record<string, string> {
  const m: Record<string, string> = {};
  if (o.number) m.comanda = String(o.number);
  const f = invoiceLabel(o);
  if (f) m.factura = f;
  return m;
}

/** Customer-ul Stripe al comenzii, din datele scrise de client pe site. Întoarce id-ul. */
export async function createCheckoutCustomer(
  stripe: Stripe,
  c: { name: string; phone?: string; email?: string },
  address: OrderAddress,
  token: string,
): Promise<string> {
  const addr: Stripe.AddressParam = {
    line1: address.line1 || '',
    line2: address.line2 || '',
    city: address.city || '',
    postal_code: address.postalCode || '',
    state: address.state || '',
    country: address.country || 'RO',
  };
  const customer = await stripe.customers.create({
    name: c.name,
    description: c.name,
    ...(c.phone ? { phone: c.phone } : {}),
    ...(c.email ? { email: c.email } : {}),
    address: addr,
    shipping: { name: c.name, ...(c.phone ? { phone: c.phone } : {}), address: addr },
    preferred_locales: ['ro'],
    metadata: { pc: token, sursa: 'mattman.ro' },
  });
  return customer.id;
}

/**
 * Scrie pe plata Stripe numărul comenzii (și factura, dacă s-a emis). Primește
 * sesiunea de checkout sau doar id-ul ei (= id-ul comenzii). Se poate apela de
 * mai multe ori: Stripe adaugă cheile la metadata existentă.
 */
export async function stampPayment(
  stripe: Stripe,
  session: Pick<Stripe.Checkout.Session, 'id' | 'payment_intent'> | string,
  order: Pick<Order, 'number' | 'invoiceSeries' | 'invoiceNumber' | 'customer'>,
): Promise<void> {
  const metadata = paymentStamp(order);
  if (!metadata.comanda) return;
  const s = typeof session === 'string' ? await stripe.checkout.sessions.retrieve(session) : session;
  const pi = typeof s.payment_intent === 'string' ? s.payment_intent : s.payment_intent?.id;
  if (!pi) return;
  const description = [`Comanda #${order.number}`, metadata.factura && `factura ${metadata.factura}`, order.customer?.name]
    .filter(Boolean).join(' · ');
  await stripe.paymentIntents.update(pi, { metadata, description });
}
