// === LANDING CONTENT — types & seed ===
// The live landing content is stored in Vercel Blob (see landing-store.ts).
// This file holds the shape + the SEED used to initialise the store and as a
// graceful fallback when Blob isn't configured. The homepage renders identically
// to this seed when the store is empty.

export type SocialKind = 'instagram' | 'youtube' | 'spotify' | 'tiktok';
export type Social = { kind: SocialKind; href: string };
export type Track = { id: string; title: string; year?: string };
export type Download = { label: string; href: string; size?: string; external?: boolean };

export type Artist = {
  slug: string;
  name: string;
  tagline: string;
  photo: string;
  bio: string[];
  tracks: Track[];
  downloads: Download[];
  socials: Social[];
};

export type Tile = {
  slug: string;
  label: string;
  sub: string;
  href: string;
  disabled?: boolean;
};

export interface LandingContent {
  headerSub: string;
  footerEmail: string;
  roster: Artist[];
  tiles: Tile[];
}

export const SOCIAL_KINDS: SocialKind[] = ['instagram', 'youtube', 'spotify', 'tiktok'];

export const seedLanding: LandingContent = {
  headerSub: 'Independent label',
  footerEmail: '',
  roster: [
    {
      slug: 'matteo',
      name: 'Matteo',
      tagline: 'Two decades. Hit after hit.',
      photo: '/images/matteo/portrait-md.jpg',
      bio: [
        'With a career spanning almost two decades, Matteo has been putting out hit after hit — debut single "Departare" (2006) with Romania\'s pop diva Loredana set the tone for an ascending path, each new release leading national radio charts.',
        'His most viral single — "Panama" — has been making waves for over nine years, amassing 225M+ views across platforms, with fans in China, Vietnam, India, Cambodia, Indonesia, Thailand, Japan and Laos picking it up for TikTok trends, dance routines and flash mobs.',
        'His latest venture is a self-coined fusion — Gypsy Reggae — an EP boasting collaborations with King Kong, Anthony B, Loyal Flames and Johny Romano.',
      ],
      tracks: [
        { id: 'brHe7-uPTd0', title: 'Panama', year: '2013' },
        { id: 'sXu9QLRb_sI', title: 'Allegro Ventigo (w/ Dan Bălan)', year: '2018' },
      ],
      downloads: [
        { label: 'Full Press Kit (Drive)', href: 'https://drive.google.com/file/d/1wUJ7_hLcPGTITnWJgysT6cwd8fK2lTOv/view?usp=share_link', external: true },
        { label: 'Logo (PNG)', href: '/downloads/matteo/matteo-logo-black.png' },
        { label: 'Press Photo', href: '/downloads/matteo/matteo-press-1.jpg' },
      ],
      socials: [
        { kind: 'instagram', href: 'https://www.instagram.com/yesiammatteo' },
        { kind: 'youtube', href: 'https://www.youtube.com/results?search_query=matteo+mattman+music' },
        { kind: 'spotify', href: 'https://open.spotify.com/search/Matteo%20Panama' },
      ],
    },
    {
      slug: 'andrei',
      name: 'Andrei Bănuță',
      tagline: 'An artist of contrasts.',
      photo: '/images/roster/andrei.jpg',
      bio: [
        'Andrei Bănuță has solidified his status as one of the most in-demand artists one song at a time. His voice conveys emotion that instantly impacts his listeners — he doesn\'t shy away from alternating between deep, meaningful lyrics and vibrant, playful songs.',
        'His best-known song "Suflet de Bagabont" feat. Nelu Vlad & Azur was incredibly well-received — over 90M views and a popular phenomenon. More recently his collaboration with Vescan "Old Friend" spent over 10 weeks atop the Media Forest Chart.',
        'He has also become the most sought-after singer for weddings — "Jur, te voi iubi", "De la Cer la Pământ" and "Inima mea e locul tău" chosen by countless couples as the soundtrack of their first married moments.',
      ],
      tracks: [
        { id: '3MSR0pMoJdY', title: 'Suflet de Bagabont (w/ Nelu Vlad & Azur)', year: '2024' },
        { id: 'Q2D3dcmoTNs', title: 'Old Friend (w/ Vescan)', year: '2024' },
      ],
      downloads: [
        { label: 'Full Press Kit (Dropbox)', href: 'https://www.dropbox.com/scl/fo/t5d7wvkqlltyy5gpevpkn/AAm6XdxmE0FNweU41RYTteA?rlkey=55r9rs8rjr6yrp3x6txrqgmaq&dl=0', external: true },
        { label: 'Logo Black (EPS)', href: '/downloads/andrei/andrei-banuta-logo-black.eps' },
        { label: 'Logo White (EPS)', href: '/downloads/andrei/andrei-banuta-logo-white.eps' },
        { label: 'Press Photo 1', href: '/downloads/andrei/andrei-banuta-press-1.jpg' },
        { label: 'Press Photo 2', href: '/downloads/andrei/andrei-banuta-press-2.jpg' },
      ],
      socials: [
        { kind: 'instagram', href: 'https://www.instagram.com/andrei_banuta' },
        { kind: 'youtube', href: 'https://www.youtube.com/@AndreiBanuta.' },
        { kind: 'spotify', href: 'https://open.spotify.com/search/Andrei%20Banuta' },
      ],
    },
    {
      slug: 'georgiana',
      name: 'Georgiana Neagu',
      tagline: 'The new wave of balkan pop.',
      photo: '/images/roster/georgiana.jpg',
      bio: [
        'Georgiana Neagu represents the new wave of Romanian balkan pop. With her contemporary sound and relatable lyrics, she has quickly connected with a young audience across the country.',
        'Her distinctive voice and stage presence have already garnered attention from music industry professionals — she\'s poised to make a significant impact on the Romanian music scene in the coming years.',
        'Her second single "M-am Îndrăgostit de Tine (Vreau să facem o fetiță)" went viral on TikTok, gathering 2.2M+ views on YouTube and earning her a significant audience.',
      ],
      tracks: [
        { id: 'kAUB54Pxrpo', title: 'M-am Îndrăgostit de Tine', year: '2024' },
      ],
      downloads: [
        { label: 'Full Press Kit (Dropbox)', href: 'https://www.dropbox.com/scl/fo/054qowaq9gf39eadmy2wr/AG5NhRAj-jWK1ufGR74aSts?rlkey=hq7i21v2mpm6giyav6auzcntj&dl=0', external: true },
        { label: 'Logo Black (PNG)', href: '/downloads/georgiana/georgiana-neagu-logo-black.png' },
        { label: 'Logo White (PNG)', href: '/downloads/georgiana/georgiana-neagu-logo-white.png' },
        { label: 'Press Photo 1', href: '/downloads/georgiana/georgiana-neagu-press-1.jpg' },
        { label: 'Press Photo 2', href: '/downloads/georgiana/georgiana-neagu-press-2.jpg' },
      ],
      socials: [
        { kind: 'instagram', href: 'https://www.instagram.com/georgianaaneagu' },
        { kind: 'youtube', href: 'https://www.youtube.com/channel/UCTtVgerbXn3t_mWJnKGXB2w' },
        { kind: 'spotify', href: 'https://open.spotify.com/search/Georgiana%20Neagu' },
      ],
    },
    {
      slug: 'emily',
      name: 'Emily Istrate',
      tagline: 'Beautiful, talented, charismatic.',
      photo: '/images/roster/emily.jpg',
      bio: [
        'Not only beautiful but also talented and charismatic, Emily Istrate represents a fresh presence in the music industry. The singer, songwriter and actress from the Republic of Moldova promises to conquer the world with her powerful talent.',
        'Emily made remarkable appearances on TV shows like The Voice Kids Ukraine (2016) and Next Star (2017), proving her talent from a very young age. Her first international releases "If You Want To" and "Panic" reached #4 and #5 in the UK Pop Club Charts.',
        '2023 saw her climb to the top of all major Romanian music charts with "Bye Bye Boy" and "În Mintea Mea" — the latter an absolute summer jam.',
      ],
      tracks: [
        { id: 'anukrx6oDvg', title: 'În Mintea Mea', year: '2023' },
        { id: 'ev7LLbkKsHA', title: 'Bye Bye Boy', year: '2023' },
      ],
      downloads: [
        { label: 'Full Press Kit (Dropbox)', href: 'https://www.dropbox.com/scl/fo/3o0bgbudpacnhwkvinogu/AI1kNIk-DV7qiayggh-61m8?rlkey=6n31l37ebr9n42knnuhltnuz8&dl=0', external: true },
        { label: 'Logo (PNG)', href: '/downloads/emily/emily-istrate-logo.png' },
        { label: 'Press Photo 1', href: '/downloads/emily/emily-istrate-press-1.jpg' },
        { label: 'Press Photo 2', href: '/downloads/emily/emily-istrate-press-2.jpg' },
      ],
      socials: [
        { kind: 'instagram', href: 'https://www.instagram.com/emilyistrate' },
        { kind: 'youtube', href: 'https://www.youtube.com/@EmilyIstrate.' },
        { kind: 'spotify', href: 'https://open.spotify.com/search/Emily%20Istrate' },
      ],
    },
  ],
  tiles: [
    { slug: 'shop', label: 'Shop', sub: 'Merch', href: '/merch' },
    { slug: 'demos', label: 'Demos', sub: 'Submit your track', href: 'mailto:demo@mattman.ro?subject=Demo%20submission' },
  ],
};
