// TCG Manager -- procedural card portraits, drawn in the browser.
//
// Every card without uploaded art gets a portrait derived from a hash of its
// own name and id: the same trick the club crests already use. A card always
// looks the same, no two look alike, and nothing has to be drawn by hand.
//
// This runs in the CLIENT, not in a build step. The previous version rendered
// 83 PNGs offline and needed all of them bulk-uploaded by hand before a single
// player saw one -- which never happened, so most of the game was still a wall
// of identical foil tiles. Generating in the browser means a new card has art
// the moment it exists, improving the generator improves every card at once,
// and nothing has to be stored anywhere.
//
// Deliberately a flat vector portrait rather than an attempt at realism --
// stylised reads as a design choice, near-realism reads as a bad photo.
"use strict";
(function(global){

var RARITY_TINT = {
  Common:"#9AA5B1", Uncommon:"#4ADE80", Rare:"#2FD180", Epic:"#2FB6D9",
  Elite:"#3B82F6", Ultra:"#8B7FE8", Legendary:"#FFB020", Mythic:"#F97316",
  Icon:"#E14F8A", GOAT:"#FFD700"
};
var BG = "#080F1A";

var SKIN = ["#F2C9A0","#E8BC8E","#D9A276","#C68A5E","#A2673F","#7A4A2A","#5A3520","#42261A"];
var HAIR = ["#1B1410","#241A12","#2E2018","#4A3120","#6E4B2A","#A9773F","#D9C39A","#B0B4B8","#5C2E1B","#0E0C0B"];
var KIT  = ["#E23B3B","#2A66D8","#F0F3F7","#14A85C","#F2B01E","#7B3FE4","#111820","#E1622A","#19A9B8","#C51F5D"];

function hash(str){ var h=2166136261; for(var i=0;i<str.length;i++){ h^=str.charCodeAt(i); h=Math.imul(h,16777619);} return h>>>0; }
// Independent streams from one seed, so changing hair doesn't shuffle the kit.
function pick(seed, salt, arr){ return arr[(hash(salt+"|"+seed))%arr.length]; }
function num(seed, salt, lo, hi){ return lo + (hash(salt+"|"+seed) % (hi-lo+1)); }

function shade(hex, amt){
  var n=parseInt(hex.slice(1),16);
  var r=Math.max(0,Math.min(255,(n>>16)+amt)), g=Math.max(0,Math.min(255,((n>>8)&255)+amt)), b=Math.max(0,Math.min(255,(n&255)+amt));
  return "#"+((1<<24)+(r<<16)+(g<<8)+b).toString(16).slice(1);
}
// Perceived lightness, so hair is never allowed to disappear into the skin.
function lum(hex){
  var n=parseInt(hex.slice(1),16);
  return (0.299*(n>>16) + 0.587*((n>>8)&255) + 0.114*(n&255))/255;
}

function bokeh(seed, count){
  var out="";
  for(var i=0;i<count;i++){
    var x=num(seed,"bx"+i,20,822), y=num(seed,"by"+i,20,470);
    var r=num(seed,"br"+i,6,26), o=num(seed,"bo"+i,4,13)/100;
    out+='<circle cx="'+x+'" cy="'+y+'" r="'+r+'" fill="#ffffff" opacity="'+o+'"/>';
  }
  return out;
}

// ---------------------------------------------------------------------------
// Hair, sized from the head so it fits every face shape. It has to read at
// 90px wide in a grid, so silhouette does all the work: a cap that pokes above
// the skull by a few pixels is indistinguishable from bald once the card is
// thumbnail-sized, which is exactly what went wrong the first time round.
//
// Returns { back, front }. Volume that is WIDER than the skull -- an afro, a
// long cut, curls -- has to be drawn before the face or it covers it, which is
// how the first afro came out as a featureless grey egg.
function hairShape(style, cx, cy, hw, hh, col){
  var top = cy - hh;                    // crown of the skull
  var brow = cy - hh*0.30;              // hairline, above the brow
  var dark = shade(col,-26), light = shade(col,22);
  var cap = "M"+(cx-hw*1.03)+" "+(brow+hh*0.16)+
            " q"+(-hw*0.06)+" "+(-hh*1.22)+" "+(hw*1.03)+" "+(-hh*1.22)+
            " q"+(hw*1.09)+" 0 "+(hw*1.03)+" "+(hh*1.22)+
            " q"+(-hw*0.24)+" "+(-hh*0.60)+" "+(-hw*1.03)+" "+(-hh*0.58)+
            " q"+(-hw*0.79)+" "+(-hh*0.02)+" "+(-hw*1.03)+" "+(hh*0.58)+" z";
  var capPath = '<path d="'+cap+'" fill="'+col+'"/>';
  var out, i, t;
  switch(style){
    case "buzz":
      return { back:"", front:'<path d="'+cap+'" fill="'+col+'" opacity="0.86"/>' };
    case "crop":
      return { back:"", front: capPath +
        '<path d="M'+(cx-hw*0.72)+' '+(top+hh*0.06)+' q'+(hw*0.72)+' '+(-hh*0.26)+' '+(hw*1.44)+' 0" stroke="'+light+'" stroke-width="'+(hw*0.07)+'" fill="none" opacity="0.30" stroke-linecap="round"/>' };
    case "afro":
      return {
        back: '<circle cx="'+cx+'" cy="'+(cy-hh*0.44)+'" r="'+(hw*1.32)+'" fill="'+col+'"/>'+
              '<circle cx="'+(cx-hw*0.46)+'" cy="'+(cy-hh*0.92)+'" r="'+(hw*0.40)+'" fill="'+light+'" opacity="0.20"/>',
        front: '<path d="'+cap+'" fill="'+col+'" opacity="0.96"/>'
      };
    case "curls":
      out = "";
      for(i=0;i<7;i++){
        t=(i/6)*Math.PI;
        out += '<circle cx="'+(cx-Math.cos(t)*hw*1.00)+'" cy="'+(cy-hh*0.72-Math.sin(t)*hh*0.36)+'" r="'+(hw*0.29)+'" fill="'+col+'"/>';
      }
      return { back: out, front: capPath +
        '<circle cx="'+(cx-hw*0.32)+'" cy="'+(cy-hh*0.96)+'" r="'+(hw*0.22)+'" fill="'+light+'" opacity="0.18"/>' };
    case "long":
      return {
        back: '<path d="M'+(cx-hw*1.16)+' '+(cy+hh*0.66)+
          ' q'+(-hw*0.22)+' '+(-hh*1.90)+' '+(hw*1.16)+' '+(-hh*1.90)+
          ' q'+(hw*1.38)+' 0 '+(hw*1.16)+' '+(hh*1.90)+
          ' q'+(-hw*0.20)+' '+(-hh*0.32)+' '+(-hw*0.28)+' '+(-hh*0.88)+
          ' q'+(-hw*0.24)+' '+(-hh*0.54)+' '+(-hw*0.88)+' '+(-hh*0.54)+
          ' q'+(-hw*0.64)+' 0 '+(-hw*0.88)+' '+(hh*0.54)+
          ' q'+(-hw*0.08)+' '+(hh*0.56)+' '+(-hw*0.28)+' '+(hh*0.88)+' z" fill="'+col+'"/>',
        front: capPath +
          '<path d="M'+(cx-hw*0.86)+' '+(brow-hh*0.28)+' q'+(hw*0.86)+' '+(-hh*0.32)+' '+(hw*1.72)+' 0" stroke="'+dark+'" stroke-width="'+(hw*0.06)+'" fill="none" opacity="0.45"/>'
      };
    case "bun":
      return {
        back: '<circle cx="'+cx+'" cy="'+(top-hh*0.16)+'" r="'+(hw*0.34)+'" fill="'+col+'"/>',
        front: capPath +
          '<path d="M'+(cx-hw*0.60)+' '+(top+hh*0.10)+' q'+(hw*0.60)+' '+(-hh*0.24)+' '+(hw*1.20)+' 0" stroke="'+dark+'" stroke-width="'+(hw*0.05)+'" fill="none" opacity="0.40"/>'
      };
    case "band":
      return { back:"", front: capPath +
        '<path d="M'+(cx-hw*1.04)+' '+(brow-hh*0.04)+' q'+(hw*1.04)+' '+(-hh*0.30)+' '+(hw*2.08)+' 0'+
        ' l0 '+(hh*0.19)+' q'+(-hw*1.04)+' '+(-hh*0.30)+' '+(-hw*2.08)+' 0 z" fill="#F3F6FA" opacity="0.94"/>' };
    case "receding":
      return { back:"", front:'<path d="M'+(cx-hw*1.00)+' '+(brow+hh*0.24)+
        ' q'+(-hw*0.02)+' '+(-hh*0.84)+' '+(hw*0.46)+' '+(-hh*0.92)+
        ' q'+(hw*0.10)+' '+(hh*0.26)+' '+(hw*0.02)+' '+(hh*0.40)+
        ' q'+(hw*0.44)+' '+(-hh*0.22)+' '+(hw*1.06)+' '+(hh*0.02)+
        ' q'+(-hw*0.06)+' '+(-hh*0.20)+' '+(hw*0.04)+' '+(-hh*0.40)+
        ' q'+(hw*0.46)+' '+(hh*0.12)+' '+(hw*0.44)+' '+(hh*0.90)+
        ' q'+(-hw*0.24)+' '+(-hh*0.56)+' '+(-hw*1.00)+' '+(-hh*0.54)+
        ' q'+(-hw*0.76)+' '+(-hh*0.02)+' '+(-hw*1.00)+' '+(hh*0.54)+' z" fill="'+col+'"/>' };
    default: // bald -- side hair only, so the skull still has an edge
      return { back:"", front:
        '<path d="M'+(cx-hw*1.02)+' '+(cy+hh*0.12)+' q'+(-hw*0.06)+' '+(-hh*0.70)+' '+(hw*0.26)+' '+(-hh*0.86)+'" stroke="'+col+'" stroke-width="'+(hw*0.16)+'" fill="none" stroke-linecap="round" opacity="0.85"/>'+
        '<path d="M'+(cx+hw*1.02)+' '+(cy+hh*0.12)+' q'+(hw*0.06)+' '+(-hh*0.70)+' '+(-hw*0.26)+' '+(-hh*0.86)+'" stroke="'+col+'" stroke-width="'+(hw*0.16)+'" fill="none" stroke-linecap="round" opacity="0.85"/>' };
  }
}

// Facial hair is the single biggest differentiator at thumbnail size -- it
// changes the outline of the jaw, which survives being 90px wide when eye and
// nose detail does not.
function beardShape(style, cx, cy, hw, hh, col){
  var mouthY = cy + hh*0.56;
  var tache = "M"+(cx-hw*0.34)+" "+(mouthY-hh*0.13)+
              " q"+(hw*0.34)+" "+(-hh*0.10)+" "+(hw*0.68)+" 0"+
              " q"+(-hw*0.10)+" "+(hh*0.15)+" "+(-hw*0.34)+" "+(hh*0.13)+
              " q"+(-hw*0.24)+" "+(hh*0.02)+" "+(-hw*0.34)+" "+(-hh*0.13)+" z";
  switch(style){
    case "stubble":
      return '<path d="M'+(cx-hw*0.98)+' '+(cy+hh*0.12)+' q'+(hw*0.10)+' '+(hh*0.90)+' '+(hw*0.98)+' '+(hh*0.92)+
        ' q'+(hw*0.88)+' '+(-hh*0.02)+' '+(hw*0.98)+' '+(-hh*0.92)+
        ' q'+(-hw*0.20)+' '+(hh*0.56)+' '+(-hw*0.98)+' '+(hh*0.56)+
        ' q'+(-hw*0.78)+' 0 '+(-hw*0.98)+' '+(-hh*0.56)+' z" fill="'+shade(col,-14)+'" opacity="0.32"/>';
    case "moustache":
      return '<path d="'+tache+'" fill="'+col+'"/>';
    case "goatee":
      return '<path d="'+tache+'" fill="'+col+'"/>'+
        '<path d="M'+(cx-hw*0.28)+' '+(mouthY+hh*0.14)+' q'+(hw*0.28)+' '+(hh*0.06)+' '+(hw*0.56)+' 0'+
        ' q'+(-hw*0.06)+' '+(hh*0.34)+' '+(-hw*0.28)+' '+(hh*0.34)+
        ' q'+(-hw*0.22)+' 0 '+(-hw*0.28)+' '+(-hh*0.34)+' z" fill="'+col+'"/>';
    case "full":
      return '<path d="M'+(cx-hw*1.00)+' '+(cy+hh*0.04)+' q'+(hw*0.06)+' '+(hh*1.02)+' '+(hw*1.00)+' '+(hh*1.04)+
        ' q'+(hw*0.94)+' '+(-hh*0.02)+' '+(hw*1.00)+' '+(-hh*1.04)+
        ' q'+(-hw*0.24)+' '+(hh*0.48)+' '+(-hw*0.52)+' '+(hh*0.48)+
        ' q'+(-hw*0.48)+' 0 '+(-hw*0.48)+' '+(-hh*0.16)+
        ' q0 '+(hh*0.16)+' '+(-hw*0.48)+' '+(hh*0.16)+
        ' q'+(-hw*0.28)+' 0 '+(-hw*0.52)+' '+(-hh*0.48)+' z" fill="'+col+'"/>'+
        '<path d="'+tache+'" fill="'+shade(col,10)+'"/>';
    default:
      return "";
  }
}

// Shirt patterns, clipped to the shoulders. A wall of solid colours reads as
// one team in ten dye-lots; stripes and sashes read as different clubs.
function kitPattern(style, kit){
  var alt = lum(kit) > 0.55 ? shade(kit,-92) : shade(kit,64);
  var out = "", i;
  switch(style){
    case "stripes":
      for(i=0;i<5;i++) out += '<rect x="'+(150+i*118)+'" y="820" width="56" height="380" fill="'+alt+'" opacity="0.85"/>';
      return out;
    case "sash":
      return '<path d="M180 1191 L470 830 L580 830 L300 1191 z" fill="'+alt+'" opacity="0.9"/>';
    case "hoops":
      for(i=0;i<3;i++) out += '<rect x="100" y="'+(900+i*104)+'" width="642" height="46" fill="'+alt+'" opacity="0.85"/>';
      return out;
    case "halves":
      return '<rect x="421" y="820" width="421" height="380" fill="'+alt+'" opacity="0.85"/>';
    default:
      return "";
  }
}

// `detail:"thumb"` trades fidelity for cost: a 90px grid tile cannot show 26
// bokeh circles or an eye highlight, so it doesn't pay for them.
function portrait(card, opts){
  opts = opts || {};
  var thumb = opts.detail === "thumb";
  var seed = (card.name||"?") + "#" + (card.id!=null ? card.id : 0);
  var accent = RARITY_TINT[card.rarity] || "#9AA5B1";
  var uid = "p" + hash(seed).toString(36);

  var skin = pick(seed,"skin",SKIN);
  var hair = pick(seed,"hair",HAIR);
  // Grey hair on a young face is fine; hair that vanishes into the skin is not.
  // Re-pick from the tones that contrast with this skin rather than shading
  // the chosen one: lightening a dark brown just produces grey, and doing that
  // for every dark-skinned player turned a third of the squad silver.
  if(Math.abs(lum(hair)-lum(skin)) < 0.12){
    hair = lum(skin) > 0.42
      ? pick(seed,"hair2",["#1B1410","#241A12","#2E2018","#0E0C0B"])
      : pick(seed,"hair2",["#6E4B2A","#A9773F","#D9C39A","#5C2E1B"]);
  }
  var hairStyle = pick(seed,"style",["crop","crop","curls","buzz","afro","long","bald","band","bun","receding"]);
  var beard = pick(seed,"beard",["none","none","none","stubble","stubble","moustache","goatee","full"]);
  var kit = pick(seed,"kit",KIT);
  var kitStyle = pick(seed,"kitstyle",["solid","solid","stripes","sash","hoops","halves"]);
  var tilt = num(seed,"tilt",0,8) - 4;

  // Face proportions. Three numbers is enough: a wide short face and a narrow
  // long one read as different people long before the eyes do.
  var hw = num(seed,"hw",134,166);      // half-width
  var hh = num(seed,"hh",168,200);      // half-height
  var jaw = num(seed,"jaw",0,100)/100;  // 0 = tapered, 1 = square

  var cx = 421, cy = 550;
  var isGK = card.position === "GK";
  // Keepers wear a kit nobody else on the pitch wears -- the one piece of real
  // football grammar worth encoding, because it makes a GK card identifiable
  // in a list without reading the label. Three of them, or every keeper in the
  // game is the same man in the same shirt.
  var gkKit = pick(seed,"gk",["#1C2B1E","#2B1F3A","#3A2A16"]);
  var jersey  = isGK ? gkKit : kit;
  var jersey2 = isGK ? shade(gkKit,-24) : shade(kit,-40);
  var eyeY = cy + hh*0.09, browY = cy - hh*0.14, mouthY = cy + hh*0.56;

  var hairLayers = hairShape(hairStyle, cx, cy, hw, hh, hair);

  var head = "M"+(cx-hw)+" "+(cy-hh*0.16)+
    " q0 "+(-hh*0.98)+" "+hw+" "+(-hh*0.98)+
    " q"+hw+" 0 "+hw+" "+(hh*0.98)+
    " q0 "+(hh*0.70)+" "+(-hw*(0.30+jaw*0.22))+" "+(hh*0.94)+
    " q"+(-hw*(0.70-jaw*0.22))+" "+(hh*0.30)+" "+(-hw*(1.40-jaw*0.44))+" 0"+
    " q"+(-hw*(0.30+jaw*0.22))+" "+(-hh*0.24)+" "+(-hw*(0.30+jaw*0.22))+" "+(-hh*0.94)+" z";

  var svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="60 92 722 1021" width="722" height="1021" preserveAspectRatio="xMidYMid slice">'+
  '<defs>'+
    '<radialGradient id="bg-'+uid+'" cx="50%" cy="34%" r="76%">'+
      '<stop offset="0%" stop-color="'+accent+'" stop-opacity="0.40"/>'+
      '<stop offset="52%" stop-color="'+accent+'" stop-opacity="0.10"/>'+
      '<stop offset="100%" stop-color="'+BG+'" stop-opacity="1"/>'+
    '</radialGradient>'+
    '<linearGradient id="jers-'+uid+'" x1="0" y1="0" x2="0" y2="1">'+
      '<stop offset="0%" stop-color="'+jersey+'"/><stop offset="100%" stop-color="'+jersey2+'"/>'+
    '</linearGradient>'+
    '<linearGradient id="floor-'+uid+'" x1="0" y1="0" x2="0" y2="1">'+
      '<stop offset="0%" stop-color="'+accent+'" stop-opacity="0.30"/>'+
      '<stop offset="100%" stop-color="'+accent+'" stop-opacity="0"/>'+
    '</linearGradient>'+
    '<clipPath id="shirt-'+uid+'"><path d="M110 1191 q24-366 311-396 q287 30 311 396 z"/></clipPath>'+
  '</defs>'+
  '<rect width="842" height="1191" fill="'+BG+'"/>'+
  '<rect width="842" height="1191" fill="url(#bg-'+uid+')"/>'+
  bokeh(seed, thumb ? 12 : 26)+
  '<ellipse cx="421" cy="1120" rx="430" ry="150" fill="url(#floor-'+uid+')"/>'+
  '<g transform="rotate('+tilt+' 421 620)">'+
    // Neck first, so the shirt covers where it ends -- a neck drawn over the
    // shirt shows its own bottom edge as a tan tongue, and a collar drawn as a
    // filled shape over the neck just reads as a hole in the chest. Both were
    // tried. The collar is a ring around the neck at the shirt line instead.
    '<path d="M'+(cx-74)+' '+(cy+120)+' h148 v210 q-74 40-148 0 z" fill="'+shade(skin,-34)+'"/>'+
    '<path d="M110 1191 q24-366 311-396 q287 30 311 396 z" fill="url(#jers-'+uid+')"/>'+
    (isGK ? "" : '<g clip-path="url(#shirt-'+uid+')">'+kitPattern(kitStyle, kit)+'</g>')+
    '<path d="M110 1191 q24-366 311-396 l0 396 z" fill="#000000" opacity="0.10"/>'+
    // No collar geometry: a drawn collar at this scale reads as a hoop hanging
    // round the player's neck. What sells it instead is the shadow the head
    // casts onto the shirt.
    '<g clip-path="url(#shirt-'+uid+')"><ellipse cx="'+cx+'" cy="'+(cy+236)+'" rx="176" ry="66" fill="#000000" opacity="0.20"/></g>'+
    hairLayers.back+
    '<path d="'+head+'" fill="'+skin+'"/>'+
    '<ellipse cx="'+(cx-hw)+'" cy="'+(cy+hh*0.10)+'" rx="'+(hw*0.135)+'" ry="'+(hh*0.165)+'" fill="'+shade(skin,-22)+'"/>'+
    '<ellipse cx="'+(cx+hw)+'" cy="'+(cy+hh*0.10)+'" rx="'+(hw*0.135)+'" ry="'+(hh*0.165)+'" fill="'+shade(skin,-22)+'"/>'+
    '<path d="M'+(cx-hw*0.88)+' '+(cy-hh*0.34)+' q'+(hw*0.88)+' '+(-hh*0.38)+' '+(hw*1.76)+' 0 q'+(-hw*0.10)+' '+(hh*0.26)+' '+(-hw*0.88)+' '+(hh*0.26)+' q'+(-hw*0.78)+' 0 '+(-hw*0.88)+' '+(-hh*0.26)+' z" fill="#000000" opacity="0.10"/>'+
    beardShape(beard, cx, cy, hw, hh, shade(hair,-6))+
    '<ellipse cx="'+(cx-hw*0.41)+'" cy="'+eyeY+'" rx="'+(hw*0.125)+'" ry="'+(hh*0.070)+'" fill="#14202C"/>'+
    '<ellipse cx="'+(cx+hw*0.41)+'" cy="'+eyeY+'" rx="'+(hw*0.125)+'" ry="'+(hh*0.070)+'" fill="#14202C"/>'+
    // Catchlights survive being shrunk -- two dark ovals without them read as
    // a doll. 130 bytes, drawn at every size.
    '<circle cx="'+(cx-hw*0.38)+'" cy="'+(eyeY-hh*0.018)+'" r="'+(hw*0.035)+'" fill="#ffffff" opacity="0.75"/>'+
    '<circle cx="'+(cx+hw*0.44)+'" cy="'+(eyeY-hh*0.018)+'" r="'+(hw*0.035)+'" fill="#ffffff" opacity="0.75"/>'+
    '<path d="M'+(cx-hw*0.60)+' '+(browY+hh*0.04)+' q'+(hw*0.20)+' '+(-hh*0.10)+' '+(hw*0.40)+' '+(-hh*0.02)+'" stroke="'+shade(hair,-20)+'" stroke-width="'+(hw*0.085)+'" fill="none" stroke-linecap="round"/>'+
    '<path d="M'+(cx+hw*0.20)+' '+(browY+hh*0.02)+' q'+(hw*0.20)+' '+(-hh*0.08)+' '+(hw*0.40)+' '+(hh*0.02)+'" stroke="'+shade(hair,-20)+'" stroke-width="'+(hw*0.085)+'" fill="none" stroke-linecap="round"/>'+
    '<path d="M'+cx+' '+(cy+hh*0.15)+' q'+(-hw*0.08)+' '+(hh*0.28)+' '+(hw*0.09)+' '+(hh*0.32)+'" stroke="'+shade(skin,-52)+'" stroke-width="'+(hw*0.058)+'" fill="none" stroke-linecap="round"/>'+
    '<path d="M'+(cx-hw*0.28)+' '+mouthY+' q'+(hw*0.28)+' '+(hh*0.16)+' '+(hw*0.56)+' 0" stroke="'+shade(skin,-78)+'" stroke-width="'+(hw*0.072)+'" fill="none" stroke-linecap="round"/>'+
    hairLayers.front+
  '</g>'+
  '</svg>';

  // Float arithmetic produces coordinates like -158.51999999999998, and there
  // are hundreds of them per card. At a 842-unit viewBox nobody can see a
  // tenth of a unit, and this alone takes about a third off the markup that
  // every grid tile carries as a data URI.
  return svg.replace(/(\d+\.\d)\d+/g, "$1");
}

// One SVG per card is cheap to build but not free to serialise on every
// render(), and render() replaces #stage wholesale whenever anything at all
// changes -- a notification arriving would otherwise rebuild 90 portraits.
var uriCache = Object.create(null);
function portraitURI(card, opts){
  var detail = (opts && opts.detail) || "full";
  var key = (card.id!=null?card.id:0)+"|"+(card.name||"")+"|"+card.rarity+"|"+card.position+"|"+detail;
  var hit = uriCache[key];
  if(!hit){
    // Not encodeURIComponent: it escapes every space, quote and angle bracket
    // and adds ~40% to a string that 100 grid tiles each carry inline. Only
    // these five characters actually have to go -- with single quotes inside
    // the SVG, the whole thing sits in a double-quoted src attribute as is.
    var svg = portrait(card, opts).replace(/"/g, "'")
      .replace(/%/g,"%25").replace(/#/g,"%23")
      .replace(/</g,"%3C").replace(/>/g,"%3E");
    hit = uriCache[key] = "data:image/svg+xml;charset=utf-8," + svg;
  }
  return hit;
}

global.cardPortraitSVG = portrait;
global.cardPortraitURI = portraitURI;
if(typeof module !== "undefined" && module.exports) module.exports = { portrait: portrait, portraitURI: portraitURI };

})(typeof window !== "undefined" ? window : globalThis);
