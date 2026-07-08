import type { APIRoute } from 'astro';
import Stripe from 'stripe';
import { randomUUID } from 'node:crypto';
import { CURRENCY, SIZES, effectivePrice, isVariantAvailable, type SizeKey } from '../../lib/products';
import { readCatalog } from '../../lib/catalog-store';
import { quoteShipping } from './shipping-quote';
import { savePendingCheckout, type PendingCart } from '../../lib/checkout-store';
import type { OrderAddress } from '../../lib/orders';

// On-demand (serverless) route — the rest of the site stays static.
export const prerender = false;

const SECRET =
  import.meta.env.STRIPE_SECRET_KEY || process.env.STRIPE_SECRET_KEY || '';

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });

interface IncomingItem { slug?: string; color?: string; size?: string; qty?: number }
interface IncomingAddress {
  name?: string; phone?: string; email?: string;
  county?: string; locality?: string; street?: string; streetNo?: string;
  zip?: string; building?: string; entrance?: string; floor?: string; apartment?: string;
}

const s = (v: unknown, max = 120) => String(v ?? '').trim().slice(0, max);

export const POST: APIRoute = async ({ request }) => {
  if (!SECRET || SECRET.startsWith('sk_test_xxx')) {
    return json(
      { error: 'Plata nu este încă activată. Adaugă STRIPE_SECRET_KEY în setări.' },
      503
    );
  }

  let payload: { items?: IncomingItem[]; address?: IncomingAddress };
  try {
    payload = await request.json();
  } catch {
    return json({ error: 'Cerere invalidă.' }, 400);
  }

  const incoming = Array.isArray(payload?.items) ? payload.items : [];
  if (incoming.length === 0) return json({ error: 'Coșul este gol.' }, 400);

  // Shipping address collected on OUR side (before Stripe) so we can charge the
  // real FAN tariff and store an authoritative county + postal code.
  const a = payload?.address || {};
  const addr = {
    name: s(a.name, 80), phone: s(a.phone, 30), email: s(a.email, 120),
    county: s(a.county, 50), locality: s(a.locality, 80),
    street: s(a.street, 120), streetNo: s(a.streetNo, 20), zip: s(a.zip, 12),
    building: s(a.building, 30), entrance: s(a.entrance, 20), floor: s(a.floor, 20), apartment: s(a.apartment, 20),
  };
  const missing = (['name', 'phone', 'county', 'locality', 'street', 'zip'] as const).filter((k) => !addr[k]);
  if (missing.length) return json({ error: 'Completează adresa de livrare (nume, telefon, județ, localitate, stradă, cod poștal).' }, 400);

  const origin = new URL(request.url).origin;
  const catalog = await readCatalog();

  const lineItems: Stripe.Checkout.SessionCreateParams.LineItem[] = [];
  const cart: PendingCart[] = [];
  let subtotal = 0;

  for (const raw of incoming) {
    const product = catalog.find((p) => p.slug === String(raw?.slug ?? '') && p.active !== false);
    if (!product) return json({ error: `Produs indisponibil: ${raw?.slug}` }, 400);

    const color = product.colors.find((c) => c.key === raw?.color) ?? product.colors[0];
    const size = String(raw?.size ?? '') as SizeKey;
    if (!SIZES.includes(size) || !product.sizes.includes(size)) {
      return json({ error: `Mărime invalidă pentru ${product.name}.` }, 400);
    }
    const qty = Math.min(10, Math.max(1, Math.floor(Number(raw?.qty) || 1)));

    if (!isVariantAvailable(product, color.key, size, qty)) {
      return json({ error: `Stoc insuficient: ${product.name} (${size}).` }, 409);
    }

    const unitPrice = effectivePrice(product);
    subtotal += unitPrice * qty;
    cart.push({ slug: product.slug, color: color.key, size, qty });

    const variant =
      (product.colors.length > 1 ? `${color.label} · ` : '') + `Mărime ${size}`;

    const imgUrl = color.front.startsWith('http') ? color.front : `${origin}${color.front}`;
    const includeImg = imgUrl.startsWith('https://');

    lineItems.push({
      quantity: qty,
      price_data: {
        currency: CURRENCY,
        unit_amount: unitPrice * 100, // RON → bani
        product_data: {
          name: product.name,
          description: variant,
          ...(includeImg ? { images: [imgUrl] } : {}),
          metadata: { slug: product.slug, color: color.key, size },
        },
      },
    });
  }

  // Real FAN tariff for this destination (falls back to the flat rate internally).
  const quote = await quoteShipping(cart, addr.county, addr.locality);
  const shipping = quote.shipping; // RON, VAT-included, already ceil-rounded

  const shippingOption: Stripe.Checkout.SessionCreateParams.ShippingOption = {
    shipping_rate_data: {
      type: 'fixed_amount',
      fixed_amount: { amount: shipping * 100, currency: CURRENCY },
      display_name:
        shipping === 0 ? 'Transport gratuit'
        : quote.source === 'fan' ? 'Transport FAN Courier'
        : 'Transport standard',
      delivery_estimate: {
        minimum: { unit: 'business_day', value: 2 },
        maximum: { unit: 'business_day', value: 5 },
      },
    },
  };

  // Stash the authoritative address + quoted shipping under a token; only the token
  // rides in Stripe metadata. The webhook rebuilds the order from this (correct
  // county + postal code), not from Stripe's hosted-form address.
  const token = randomUUID();
  const shippingAddress: OrderAddress = {
    name: addr.name,
    line1: [addr.street, addr.streetNo].filter(Boolean).join(' '),
    line2: [
      addr.building && `Bl. ${addr.building}`,
      addr.entrance && `Sc. ${addr.entrance}`,
      addr.floor && `Et. ${addr.floor}`,
      addr.apartment && `Ap. ${addr.apartment}`,
    ].filter(Boolean).join(', ') || undefined,
    city: addr.locality,
    postalCode: addr.zip,
    state: addr.county,
    country: 'RO',
  };
  try {
    await savePendingCheckout({
      token,
      createdAt: Date.now(),
      items: cart,
      address: shippingAddress,
      customer: { name: addr.name, phone: addr.phone, email: addr.email || undefined },
      shippingAmount: shipping,
      shippingSource: quote.source,
    });
  } catch (err: any) {
    console.error('[checkout] pending save failed:', err?.message);
    return json({ error: 'Nu am putut salva comanda. Încearcă din nou.' }, 500);
  }

  try {
    const stripe = new Stripe(SECRET);
    const session = await stripe.checkout.sessions.create({
      mode: 'payment',
      locale: 'ro',
      line_items: lineItems,
      allow_promotion_codes: true,
      // Address is collected on our side — don't re-collect on Stripe (that's what
      // let the county/postal drift and the shipping under-charge happen).
      shipping_options: [shippingOption],
      billing_address_collection: 'auto',
      ...(addr.email ? { customer_email: addr.email } : {}),
      success_url: `${origin}/merch/success?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${origin}/merch/checkout`,
      metadata: {
        pc: token,
        cart: JSON.stringify(cart.map((i) => ({ s: i.slug, c: i.color, z: i.size, q: i.qty }))).slice(0, 480),
      },
    });

    return json({ url: session.url });
  } catch (err: any) {
    console.error('[checkout] Stripe error:', err?.message || err);
    return json({ error: 'Nu am putut iniția plata. Încearcă din nou.' }, 500);
  }
};
