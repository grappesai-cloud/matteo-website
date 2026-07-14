// Single source of truth for legal / company data used across the legal pages
// (/retur, /termeni, /confidentialitate, /cookies) and site footers.
//
// TODO: completează cele 4 câmpuri marcate `TODO` cu datele reale ale firmei
// din certificatul de înregistrare ONRC. Restul e definitiv.

export const COMPANY = {
  brand: 'Mattman Music',
  legalName: 'S.C. Mattman Music S.R.L.',
  cif: 'RO34231360',
  onrc: 'J2015003109409',
  address: 'Calea Victoriei nr. 155, bl. D1, sc. 3, et. 1, ap. 75, sector 1, București, cod poștal 010073',

  email: 'shop@mattman.ro',
  phone: '+40 741 225 425',

  iban: 'RO49 INGB 0000 9999 0486 5743',
  bank: 'ING Bank N.V. Amsterdam',

  site: 'https://mattman.ro',
} as const;

// Termeni de retur (alegeri de business confirmate 2026-07-14):
export const RETURN = {
  windowDays: 14, // termenul legal minim de retragere
  whoPaysReturn: 'client' as const, // clientul suportă costul returnării

  // Adresa unde clienții trimit produsele returnate. Apare in emailul automat de
  // instrucțiuni. Default = sediul social; schimb-o dacă retururile merg altundeva.
  returnRecipient: 'S.C. Mattman Music S.R.L.',
  returnAddress: 'Calea Victoriei nr. 155, bl. D1, sc. 3, et. 1, ap. 75, sector 1, București, cod poștal 010073',

  // Comenzi mai vechi de atâtea zile nu mai pot cere retur automat (trimit la email).
  maxRequestAgeDays: 60,
} as const;

// Autorități / soluționare litigii (obligatoriu de afișat pentru comerț online RO/UE):
export const AUTHORITIES = {
  anpc: 'https://anpc.ro',
  sal: 'https://anpc.ro/ce-este-sal/', // Soluționarea Alternativă a Litigiilor
  sol: 'https://ec.europa.eu/consumers/odr', // Platforma SOL / ODR a UE
} as const;

export const LEGAL_PAGES = [
  { href: '/retur', label: 'Politica de retur' },
  { href: '/termeni', label: 'Termeni și condiții' },
  { href: '/confidentialitate', label: 'Confidențialitate' },
  { href: '/cookies', label: 'Cookies' },
] as const;

export const LEGAL_UPDATED = '14 iulie 2026';
