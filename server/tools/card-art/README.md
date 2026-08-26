# Card art

**The generator moved into the game: `server/lib/card-art.js`.**

It used to live here as an offline renderer that produced 83 PNGs to be bulk
uploaded by hand through the Admin tab. That upload never happened, so for
every player the game still showed the old placeholder tile. Worse, the design
guaranteed it would happen again: any improvement to the portraits meant
re-rendering and re-uploading all 83 files.

Now `window.cardPortraitURI(card)` builds the portrait in the browser, from a
hash of the card's own name and id. A card always looks the same, no two look
alike, a brand new card has art the moment it exists, and improving the
generator improves every card at once with a push.

## What still applies

- **The roster is FICTIONAL** ("Cristiano Golden Boot", "Edson Black Pearl").
  Do NOT swap these portraits for photographs of real players -- that is a
  rights problem in a game that takes money, and the faces would not match the
  names anyway.
- **Uploaded art still wins.** `playerCard()` uses `image_url` when a card has
  one and draws no frame over it, on the assumption that uploaded art is a
  finished card carrying its own name and rating. The procedural path is only
  for cards with `image_url` null.
- **The bulk uploader is unaffected** (`bulkUploadCardImages` in
  `lib/admin-api.js`) -- it maps files by POSITION among active cards ordered
  by id, so row N needs a file called `N.png`, not the card's id.

## Changing how portraits look

Edit `server/lib/card-art.js` and reload. Nothing to rebuild, nothing to
upload. `portrait(card, {detail:"thumb"})` is the cheaper variant used for grid
tiles; `"full"` is used where the card is the subject of the screen.
