// Procedural card portraits. Same idea as the club crests already in the app:
// everything is derived from a hash of the card's own name, so a card always
// looks the same, no two look alike, and nothing needs uploading.
//
// Deliberately a flat vector portrait rather than an attempt at realism --
// stylised reads as a design choice, near-realism reads as a bad photo.

const RARITY = {
  Common:"#9AA5B1", Uncommon:"#4ADE80", Rare:"#2FD180", Epic:"#2FB6D9",
  Elite:"#3B82F6", Ultra:"#8B7FE8", Legendary:"#FFB020", Mythic:"#F97316",
  Icon:"#E14F8A", GOAT:"#FFD700",
};
const BG = "#080F1A";

const SKIN   = ["#F2C9A0","#E0AC7E","#C68A5E","#A2673F","#7A4A2A","#5A3520"];
const HAIR   = ["#1B1410","#2E2018","#4A3120","#6E4B2A","#A9773F","#D9C39A","#8A8A8A","#141414"];
const KIT    = ["#E23B3B","#2A66D8","#F0F3F7","#14A85C","#F2B01E","#7B3FE4","#111820","#E1622A","#19A9B8","#C51F5D"];

function hash(str){ let h=2166136261; for(let i=0;i<str.length;i++){ h^=str.charCodeAt(i); h=Math.imul(h,16777619);} return h>>>0; }
// Independent streams from one seed, so changing hair doesn't shuffle the kit.
function pick(seed, salt, arr){ return arr[(hash(salt+"|"+seed))%arr.length]; }
function num(seed, salt, lo, hi){ return lo + (hash(salt+"|"+seed) % (hi-lo+1)); }

function shade(hex, amt){
  const n=parseInt(hex.slice(1),16);
  const r=Math.max(0,Math.min(255,(n>>16)+amt)), g=Math.max(0,Math.min(255,((n>>8)&255)+amt)), b=Math.max(0,Math.min(255,(n&255)+amt));
  return "#"+((1<<24)+(r<<16)+(g<<8)+b).toString(16).slice(1);
}

function bokeh(seed){
  let out="";
  for(let i=0;i<26;i++){
    const x=num(seed,"bx"+i,20,822), y=num(seed,"by"+i,20,470);
    const r=num(seed,"br"+i,6,26), o=num(seed,"bo"+i,4,13)/100;
    out+=`<circle cx="${x}" cy="${y}" r="${r}" fill="#ffffff" opacity="${o}"/>`;
  }
  return out;
}

// Hair is drawn as a shape over the skull. Six silhouettes cover enough range
// that a wall of 83 cards doesn't read as the same man repeated.
function hairShape(style, cx, cy, col){
  const d = {
    crop:  `<path d="M${cx-118} ${cy-18} q0-150 118-150 q118 0 118 150 q-30-74-118-74 q-88 0-118 74 z" fill="${col}"/>`,
    curls: `<path d="M${cx-126} ${cy-24} q-6-160 126-160 q132 0 126 160 q-24-40-46-16 q-20-46-58-30 q-24-44-64-24 q-40-16-58 32 q-18-22-26 38 z" fill="${col}"/>`,
    buzz:  `<path d="M${cx-112} ${cy-30} q0-132 112-132 q112 0 112 132 q-34-56-112-56 q-78 0-112 56 z" fill="${col}" opacity="0.92"/>`,
    long:  `<path d="M${cx-124} ${cy+80} q-16-208 124-208 q140 0 124 208 q-26-30-34-96 q-26-56-90-56 q-64 0-90 56 q-8 66-34 96 z" fill="${col}"/>`,
    bald:  `<path d="M${cx-104} ${cy-52} q22-70 104-70 q82 0 104 70 q-40-34-104-34 q-64 0-104 34 z" fill="${col}" opacity="0.35"/>`,
    band:  `<path d="M${cx-118} ${cy-18} q0-150 118-150 q118 0 118 150 q-30-74-118-74 q-88 0-118 74 z" fill="${col}"/>
            <rect x="${cx-118}" y="${cy-116}" width="236" height="28" rx="13" fill="#F3F6FA" opacity="0.92"/>`,
  };
  return d[style] || d.crop;
}

function portrait(card){
  const seed = card.name + "#" + card.id;
  const accent = RARITY[card.rarity] || "#9AA5B1";
  const skin  = pick(seed,"skin",SKIN);
  const hair  = pick(seed,"hair",HAIR);
  const style = pick(seed,"style",["crop","curls","buzz","long","bald","band"]);
  const kit   = pick(seed,"kit",KIT);
  const kit2  = shade(kit,-40);
  const tilt  = (num(seed,"tilt",0,8)-4);
  const cx=421, cy=470;

  // Keepers wear a different kit from outfield players, which is the one piece
  // of real football grammar worth encoding here -- it makes the GK cards
  // instantly identifiable in a list.
  const uid = "c"+card.id;
  const isGK = card.position === "GK";
  const jersey = isGK ? "#1C2B1E" : kit;
  const jersey2 = isGK ? "#0E1A10" : kit2;

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 842 1191" width="842" height="1191">
  <defs>
    <radialGradient id="bg-${uid}" cx="50%" cy="34%" r="76%">
      <stop offset="0%" stop-color="${accent}" stop-opacity="0.40"/>
      <stop offset="52%" stop-color="${accent}" stop-opacity="0.10"/>
      <stop offset="100%" stop-color="${BG}" stop-opacity="1"/>
    </radialGradient>
    <linearGradient id="jers-${uid}" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="${jersey}"/><stop offset="100%" stop-color="${jersey2}"/>
    </linearGradient>
    <linearGradient id="floor-${uid}" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="${accent}" stop-opacity="0.30"/>
      <stop offset="100%" stop-color="${accent}" stop-opacity="0"/>
    </linearGradient>
    <clipPath id="frame-${uid}"><rect x="0" y="0" width="842" height="1191" rx="0"/></clipPath>
  </defs>

  <g clip-path="url(#frame-${uid})">
    <rect width="842" height="1191" fill="${BG}"/>
    <rect width="842" height="1191" fill="url(#bg-${uid})"/>
    ${bokeh(seed)}
    <ellipse cx="421" cy="1120" rx="430" ry="150" fill="url(#floor-${uid})"/>

    <g transform="rotate(${tilt} 421 620)">
      <!-- shoulders -->
      <path d="M120 1191 q22-300 301-330 q279 30 301 330 z" fill="url(#jers-${uid})"/>
      <path d="M120 1191 q22-300 301-330 l0 330 z" fill="#000000" opacity="0.10"/>
      <!-- collar -->
      <path d="M${cx-92} ${cy+352} q92 96 184 0 q-40 118-92 118 q-52 0-92-118 z" fill="${shade(jersey,-70)}"/>
      <!-- neck -->
      <path d="M${cx-58} ${cy+250} h116 v120 q-58 44-116 0 z" fill="${shade(skin,-38)}"/>
      <!-- head -->
      <ellipse cx="${cx}" cy="${cy+80}" rx="152" ry="186" fill="${skin}"/>
      <!-- ears -->
      <ellipse cx="${cx-152}" cy="${cy+96}" rx="24" ry="38" fill="${shade(skin,-22)}"/>
      <ellipse cx="${cx+152}" cy="${cy+96}" rx="24" ry="38" fill="${shade(skin,-22)}"/>
      <!-- brow shadow keeps the face from reading flat -->
      <path d="M${cx-134} ${cy+18} q134-70 268 0 q-16 46-134 46 q-118 0-134-46 z" fill="#000000" opacity="0.10"/>
      <!-- eyes -->
      <ellipse cx="${cx-62}" cy="${cy+66}" rx="19" ry="13" fill="#14202C"/>
      <ellipse cx="${cx+62}" cy="${cy+66}" rx="19" ry="13" fill="#14202C"/>
      <!-- brows -->
      <path d="M${cx-92} ${cy+30} q30-18 60-4" stroke="${shade(hair,-20)}" stroke-width="13" fill="none" stroke-linecap="round"/>
      <path d="M${cx+32} ${cy+26} q30-14 60 4" stroke="${shade(hair,-20)}" stroke-width="13" fill="none" stroke-linecap="round"/>
      <!-- nose + mouth, deliberately minimal -->
      <path d="M${cx} ${cy+78} q-12 52 14 60" stroke="${shade(skin,-52)}" stroke-width="9" fill="none" stroke-linecap="round"/>
      <path d="M${cx-42} ${cy+186} q42 30 84 0" stroke="${shade(skin,-72)}" stroke-width="11" fill="none" stroke-linecap="round"/>
      ${hairShape(style, cx, cy+80, hair)}
    </g>

    <!-- squad number, bottom corner, out of the way of the app's own overlays -->
    <text x="762" y="1136" text-anchor="end" font-family="Arial Black, Arial, sans-serif"
          font-size="104" font-weight="900" fill="#F3F6FA" opacity="0.16">${card.id}</text>
    <rect x="0" y="1179" width="842" height="12" fill="${accent}" opacity="0.85"/>
  </g>
</svg>`;
}

module.exports = { portrait };
