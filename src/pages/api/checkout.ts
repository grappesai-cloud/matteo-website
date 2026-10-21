import type { APIRoute } from 'astro';
import Stripe from 'stripe';
import { randomUUID } from 'node:crypto';
import { CURRENCY, SIZES, effectivePrice, isVariantAvailable, type SizeKey } from '../../lib/products';
import { readCatalog, mutateCatalog } from '../../lib/catalog-store';
import { quoteShipping } from './shipping-quote';
import { savePendingCheckout, type PendingCart } from '../../lib/checkout-store';
import { bucharestSector, judetFromPostalCode, canonicalCounty, type OrderAddress } from '../../lib/orders';
import { lookupPromo, normalizeCode, type PromoInfo } from '../../lib/promo';
import { activateDueCodes } from '../../lib/promo-codes';
import { releaseStock, reserveStock, sweepHolds } from '../../lib/stock-ledger';
import { createCheckoutCustomer } from '../../lib/stripe-report';

/** Cât stă deschisă pagina Stripe. Minimul Stripe e 30 min; după, bucățile rezervate revin în stoc. */
const SESSION_MINUTES = 35;

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

  let payload: { items?: IncomingItem[]; address?: IncomingAddress; promoCode?: string };
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

  // Codul poștal e tastabil manual — dacă prefixul lui indică alt județ decât cel
  // selectat, oprim aici. Altfel AWB-ul ar pleca în județul din cod (ex. „40xxx" →
  // Cluj) deși clientul a ales altceva. Verificăm doar când putem deduce județul.
  const zipJudet = judetFromPostalCode(addr.zip);
  if (zipJudet && canonicalCounty(zipJudet) !== canonicalCounty(addr.county)) {
    return json(
      { error: `Codul poștal ${addr.zip} pare din județul ${zipJudet}, dar ai ales ${addr.county}. Verifică codul poștal sau județul selectat.` },
      400,
    );
  }
  // București: FAN are o singură localitate, iar sectorul cerut de ANAF pe factură
  // se citește din codul poștal (0N xxxx = sectorul N). Fără el, e-Factura e respinsă.
  if (canonicalCounty(addr.county) === 'București' && !bucharestSector({ line1: addr.street, postalCode: addr.zip })) {
    return json(
      { error: `Verifică codul poștal ${addr.zip}. În București codul are 6 cifre și începe cu 0 urmat de sector (ex. 030167 pentru sectorul 3).` },
      400,
    );
  }

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

  // Codul de reducere scris pe site: îl verificăm în Stripe ACUM, ca sesiunea să
  // pornească cu reducerea aplicată (clientul a văzut deja totalul redus).
  const stripe = new Stripe(SECRET);
  let promo: PromoInfo | null = null;
  if (normalizeCode(payload?.promoCode)) {
    try {
      const found = await lookupPromo(stripe, payload?.promoCode);
      if (!found.ok) return json({ error: found.error, promoInvalid: true }, 422);
      if (found.promo.minSubtotal && subtotal < found.promo.minSubtotal) {
        return json({ error: `Codul se aplică de la ${found.promo.minSubtotal} RON.`, promoInvalid: true }, 422);
      }
      promo = found.promo;
    } catch (err: any) {
      console.error('[checkout] verificare cod:', err?.message);
      return json({ error: 'Nu am putut verifica codul de reducere. Încearcă din nou.', promoInvalid: true }, 500);
    }
  }

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

  // REZERVARE: bucățile cu stoc urmărit se scad ACUM, atomic (scriere condiționată
  // pe catalog), cât timp clientul e pe pagina Stripe. Așa „ultima bucată” nu mai
  // poate fi plătită de doi clienți. La plată rezervarea devine definitivă; la
  // expirarea sesiunii (sau după 50 min) bucățile revin în stoc.
  try {
    const reserved = await mutateCatalog((products) => {
      sweepHolds(products);
      return reserveStock(products, token, cart);
    });
    if (!reserved.ok) return json({ error: reserved.error }, 409);
  } catch (err: any) {
    console.error('[checkout] rezervare stoc:', err?.message);
    return json({ error: 'Nu am putut rezerva produsele. Încearcă din nou.' }, 500);
  }

  // Clientul Stripe al comenzii: numele lui ajunge pe plată și în raportul lunar
  // pentru contabilitate (lib/stripe-report.ts). Dacă Stripe refuză crearea,
  // plata merge ca înainte, doar cu emailul.
  let customerId = '';
  try {
    customerId = await createCheckoutCustomer(stripe, addr, shippingAddress, token);
  } catch (err: any) {
    console.error('[checkout] client Stripe:', err?.message);
  }

  try {
    // Fără cod de pe site: pornește codurile programate a căror oră a venit
    // (lib/promo-codes.ts), ca să fie valide în câmpul de cod de pe pagina Stripe.
    if (!promo) { try { await activateDueCodes(stripe); } catch (err: any) { console.error('[checkout] activare coduri programate:', err?.message); } }
    const session = await stripe.checkout.sessions.create({
      mode: 'payment',
      locale: 'ro',
      line_items: lineItems,
      // Stripe nu acceptă `discounts` și `allow_promotion_codes` în aceeași sesiune:
      // cu cod de pe site îl aplicăm noi, fără cod lăsăm câmpul Stripe.
      ...(promo ? { discounts: [{ promotion_code: promo.id }] } : { allow_promotion_codes: true }),
      expires_at: Math.floor(Date.now() / 1000) + SESSION_MINUTES * 60,
      // Address is collected on our side — don't re-collect on Stripe (that's what
      // let the county/postal drift and the shipping under-charge happen).
      shipping_options: [shippingOption],
      billing_address_collection: 'auto',
      // Stripe nu acceptă `customer` și `customer_email` împreună; emailul e deja pe client.
      ...(customerId ? { customer: customerId } : addr.email ? { customer_email: addr.email } : {}),
      payment_intent_data: {
        description: `Comanda mattman.ro · ${addr.name}`,
        metadata: { client: addr.name, telefon: addr.phone, pc: token },
      },
      success_url: `${origin}/merch/success?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${origin}/merch/checkout`,
      metadata: {
        pc: token,
        cart: JSON.stringify(cart.map((i) => ({ s: i.slug, c: i.color, z: i.size, q: i.qty }))).slice(0, 480),
        ...(promo ? { promo: promo.code } : {}),
        ...(customerId ? { cust: '1' } : {}),
      },
    });

    return json({ url: session.url });
  } catch (err: any) {
    console.error('[checkout] Stripe error:', err?.message || err);
    // Sesiunea nu s-a deschis: eliberăm rezervarea imediat, nu peste 50 de minute.
    try { await mutateCatalog((products) => releaseStock(products, token)); } catch (e: any) { console.error('[checkout] eliberare rezervare:', e?.message); }
    if (customerId) { try { await stripe.customers.del(customerId); } catch {} }
    const promoProblem = promo && /promotion|coupon|discount/i.test(String(err?.message || ''));
    return json(
      promoProblem
        ? { error: 'Codul de reducere nu a putut fi aplicat. Scoate-l și încearcă din nou.', promoInvalid: true }
        : { error: 'Nu am putut iniția plata. Încearcă din nou.' },
      promoProblem ? 422 : 500,
    );
  }
};
