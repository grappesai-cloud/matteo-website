// === TIPUL PRODUSULUI — tricou adult / tricou copil / hanorac / tote bag / termos ===
// O singură regulă, folosită de factura SmartBill (denumirea liniei) și de raportul
// „Bucăți vândute” din admin. Catalogul nu are un câmp de tip, iar comenzile vechi
// păstrează doar slug-ul + numele de la momentul plății, deci tipul se deduce din ele;
// mărimea decide doar între tricou de adult și tricou de copil (ca înainte).
// Fără `process.env` și fără importuri de server: îl importă și scriptul din admin.

import { ADULT_SIZES, ONE_SIZE } from './products';

export type ProductKind = 'adult' | 'copil' | 'hanorac' | 'tote' | 'termos';

/** Ordinea din raport. */
export const PRODUCT_KINDS: ProductKind[] = ['adult', 'copil', 'hanorac', 'tote', 'termos'];

export const KIND_LABEL: Record<ProductKind, string> = {
  adult: 'Tricouri adulți',
  copil: 'Tricouri copii',
  hanorac: 'Hanorace',
  tote: 'Tote Bag',
  termos: 'Termosuri',
};

const norm = (s: unknown) =>
  String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

/** Tipul unei linii din coș / comandă, după slug + nume, apoi după mărime. */
export function productKind(item: { slug?: string; name?: string; size?: string }): ProductKind {
  const text = `${norm(item.slug)} ${norm(item.name)}`;
  // Ordinea contează: „tote-bag-nunta” conține și „nunta” (un tricou).
  if (/\btote\b|sacos|\bpunga\b/.test(text)) return 'tote';
  if (/hoodie|hanorac/.test(text)) return 'hanorac';
  if (/termos/.test(text)) return 'termos';
  const s = String(item.size || '').trim();
  const isKid = !!s && s !== ONE_SIZE && !(ADULT_SIZES as readonly string[]).includes(s);
  return isKid ? 'copil' : 'adult';
}
