import type { APIRoute } from 'astro';
import Stripe from 'stripe';
import { shippingFor, CURRENCY, SIZES, effectivePrice, isVariantAvailable, type SizeKey } from '../../lib/products';
import { readCatalog } from '../../lib/catalog-store';

// On-demand (serverless) route — the rest of the site stays static.
export const prerender = false;

const SECRET =
  import.meta.env.STRIPE_SECRET_KEY || process.env.STRIPE_SECRET_KEY || '';

// Countries we ship to (RO + EU + UK + neighbours). Stripe ISO-3166-1 alpha-2.
const ALLOWED_COUNTRIES: Stripe.Checkout.SessionCreateParams.ShippingAddressCollection.AllowedCountry[] =
  ['RO', 'MD', 'BG', 'HU', 'AT', 'DE', 'FR', 'IT', 'ES', 'NL', 'BE', 'GR',
   'PL', 'CZ', 'SK', 'HR', 'SI', 'IE', 'PT', 'SE', 'DK', 'FI', 'GB'];

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });

interface IncomingItem { slug?: string; color?: string; size?: string; qty?: number }

export const POST: APIRoute = async ({ request }) => {
  if (!SECRET || SECRET.startsWith('sk_test_xxx')) {
    return json(
      { error: 'Plata nu este încă activată. Adaugă STRIPE_SECRET_KEY în setări.' },
      503
    );
  }

  let payload: { items?: IncomingItem[] };
  try {
    payload = await request.json();
  } catch {
    return json({ error: 'Cerere invalidă.' }, 400);
  }

  const incoming = Array.isArray(payload?.items) ? payload.items : [];
  if (incoming.length === 0) return json({ error: 'Coșul este gol.' }, 400);

  const origin = new URL(request.url).origin;
  const catalog = await readCatalog();

  const lineItems: Stripe.Checkout.SessionCreateParams.LineItem[] = [];
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

  const shipping = shippingFor(subtotal); // RON
  const shippingOption: Stripe.Checkout.SessionCreateParams.ShippingOption = {
    shipping_rate_data: {
      type: 'fixed_amount',
      fixed_amount: { amount: shipping * 100, currency: CURRENCY },
      display_name: shipping === 0 ? 'Transport gratuit' : 'Transport standard',
      delivery_estimate: {
        minimum: { unit: 'business_day', value: 2 },
        maximum: { unit: 'business_day', value: 5 },
      },
    },
  };

  try {
    const stripe = new Stripe(SECRET);
    const session = await stripe.checkout.sessions.create({
      mode: 'payment',
      locale: 'ro',
      line_items: lineItems,
      allow_promotion_codes: true,
      shipping_address_collection: { allowed_countries: ALLOWED_COUNTRIES },
      shipping_options: [shippingOption],
      phone_number_collection: { enabled: true },
      billing_address_collection: 'auto',
      success_url: `${origin}/merch/success?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${origin}/merch`,
      metadata: {
        cart: JSON.stringify(
          incoming.map((i) => ({ s: i.slug, c: i.color, z: i.size, q: i.qty }))
        ).slice(0, 480),
      },
    });

    return json({ url: session.url });
  } catch (err: any) {
    console.error('[checkout] Stripe error:', err?.message || err);
    return json({ error: 'Nu am putut iniția plata. Încearcă din nou.' }, 500);
  }
};
