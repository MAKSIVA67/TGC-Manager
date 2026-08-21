# Card art generator

83 of the 103 cards had no picture. This fills every one of them without an
upload, the same way the club crests already work: everything about a portrait
is derived from a hash of that card's own name, so a card always looks the
same, no two look alike, and nothing has to be drawn by hand.

Deliberately a flat vector portrait rather than an attempt at realism —
stylised reads as a design choice, near-realism reads as a bad photo. Kit
colour, skin tone, hair style and colour, and a slight head tilt all vary;
goalkeepers get a dark strip so they are identifiable at a glance; the
background is tinted by rarity, so a wall of cards shows the tiers as a colour
progression.

**These are a floor, not a ceiling.** Real illustration or generated portraits
would look better. This exists so the game never ships with blank cards, and so
any card can be replaced individually later without touching the rest.

## Regenerating

```
cd server/tools/card-art
npm install puppeteer-core        # if not already available
node render.js
```

Output lands in `out/`, named by FILE NUMBER — which is the card's position in
the list of active cards ordered by id, because that is what the bulk uploader
in the Admin tab matches on. It is NOT the card id.

`cards.tsv` is the list that needed art at the time of writing. To rebuild it:

```sql
select * from (
  select row_number() over (order by id) as file_number,
         id, name, position, rarity, image_url
  from public.cards
  where active is not false
) s
where image_url is null
order by file_number;
```

## Uploading

Admin tab → bulk upload → select every PNG at once. It uploads them one at a
time and makes the thumbnails itself.

## Watch out

The names in this game are riffs on real footballers ("Cristiano Golden Boot",
"Edson Black Pearl"). The names are legally distinct, but do NOT swap these for
photographs of the real players — that is a rights problem in a game that takes
money, and the faces would not match the names anyway.
