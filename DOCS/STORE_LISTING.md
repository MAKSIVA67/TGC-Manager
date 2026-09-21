# Store listing checklist: Google Play and Apple App Store

**Status: documentation only. Nothing here has been submitted, uploaded or
deployed.** This is a checklist to work through before the first submission.

Two warnings before you start:

- **Store rules change often.** Every rule below was correct when this was
  written (September 2026), but check each one on the official page before you
  rely on it. The main ones are linked at the bottom.
- **This is not legal advice.** For the football-rights questions (section 4)
  and the loot-box questions (section 3), a one-hour chat with a lawyer who
  knows games is worth the money before you take payments from real players.

---

## 1. Gaps found in THIS app: fix these before submitting

These came out of checking the actual code. Each one is a likely rejection or a
legal risk.

- [ ] **No Terms of Service.** The app has `privacy.html` and
  `delete-account.html`, but no terms page. You need one: gems have no real-money
  value, no refunds except where the law requires them, cheating and bans, rules
  for chat and trading. Apple can use its standard licence agreement, but Google
  Play and your web version still need your own terms.
- [ ] **No way to report or block another player.** The game has chat, friend
  requests, challenges and trading between players. Both stores require a way to
  **report** a player or message, a way to **block** a player, and you acting on
  reports. Apple checks this under guideline 1.2 ("user-generated content"), and
  it is one of the most common rejection reasons for social games.
- [ ] **The privacy policy has no GDPR section.** `privacy.html` explains what is
  collected and how to delete it, which is good. It never names who is
  responsible for the data (the "controller") or gives the legal basis for each
  use. It doesn't say the data may leave the EU (Stripe is a US company;
  check which region your Supabase project runs in). It doesn't list the user's
  rights, or say they can complain to a data protection authority. Add all of
  those.
- [ ] **Jackpot odds show as "0.00%".** The shop rounds odds to 2 decimal places,
  so the Bronze Pack's GOAT chance (0.002%) is displayed as 0.00%. Both stores
  require the odds of random paid items to be disclosed before purchase. A prize
  shown as "0.00%" that can actually drop reads as misleading. The rounding lives
  in the two `fmt` helpers in `server/index.html` that do `n.toFixed(2)`.
- [ ] **No Apple in-app purchase yet.** On Android, gems go through Google Play
  Billing (`server/lib/iap.js`). On iOS the code uses Stripe, which is fine for
  the website but **not allowed inside an App Store app** for digital items like
  gems. A native iOS app needs Apple In-App Purchase before submission.
- [ ] **Real player names.** Several card names are built on real footballers:
  "Isco Maestrito" uses Isco's real name, and "Edson Black Pearl" is Pelé's
  real first name plus his famous nickname. See section 4.
- [ ] **No 1024 × 1024 icon.** `server/icon-512.png` works for Google Play, but
  Apple needs a 1024 × 1024 version.
- [ ] **A test account for the reviewers.** The app needs a login, so both stores
  need a working email and password for a test account with some cards and gems.
  Without one, the review stops.

## 2. What already exists and counts toward the checklist

- [x] Privacy policy page: `server/privacy.html`. It still needs the GDPR additions
  above.
- [x] Account deletion, both inside the app (Profile) and on the web
  (`delete-account.html`). Both stores require both.
- [x] Pack odds shown before buying (the shop's rarity table). Fix the rounding.
- [x] Google Play Billing for gems on Android.
- [x] A signed Android build. The GitHub Action `android.yml` produces the
  `.aab` file Google Play needs.
- [x] An iOS project (`capacitor-app/ios`) and a Codemagic cloud build
  (`codemagic.yaml`), so you don't need your own Mac to build for iPhone.
- [x] A 512 × 512 icon (`server/icon-512.png`).

---

## 3. Things that apply to BOTH stores

### 3.1 Decide who is publishing

- [ ] **You as a person, or a company.** Organisations need a free D-U-N-S number
  for both stores, which can take a couple of weeks. A person does not.
- [ ] **EU "trader" status (Digital Services Act).** Both stores make you declare
  whether you are a trader. If you sell gems, you almost certainly are. **Your
  name, address, phone number and email will then be shown publicly on the store
  page.** Consider a business address or a small company before you declare.
- [ ] **Legal notice ("Impressum").** If you are based in Germany or Austria, a
  commercial website and app page usually need one. Check your own country's
  rule.

### 3.2 Privacy and GDPR

- [ ] Privacy policy at a public web address, for example
  `https://maksiva67.github.io/TGC-Manager/privacy.html`. Both stores ask for
  the link.
- [ ] Name the data controller: your name or company, address and email.
- [ ] For each thing you collect, say why and on what legal basis. Account and
  game data are needed to run the game ("contract"). Purchases are needed to
  deliver gems and for tax records ("contract" and "legal obligation").
- [ ] List the services that process data for you: Supabase (database and
  login), Stripe (web payments), Google Play and Apple (store payments). Sign or
  accept each one's data processing agreement (DPA). Supabase and Stripe both
  offer one.
- [ ] Say where data is stored, and how it is protected if it leaves the EU.
- [ ] List the user's rights: access, correction, deletion, export ("data
  portability"), objection, and complaining to a data protection authority.
- [ ] Say how long you keep data, for example until the account is deleted,
  with payment records kept as long as tax law requires.
- [ ] **Age.** The policy says "not for under 13". In Germany a child can only
  agree to data use on their own from **16**. Decide your minimum age, ask for it
  at sign-up if needed, and make the store age rating and the policy match.

### 3.3 Paid random items ("loot boxes")

Your packs are random items bought with gems, and gems are bought with money.
Stores and some countries treat that as a loot box.

- [ ] Odds shown before purchase, for every pack and every rarity. You have this;
  fix the "0.00%" rounding.
- [ ] **Belgium** treats paid loot boxes as illegal gambling. Most games switch
  off real-money packs there or leave Belgium out of distribution. Both stores
  let you choose countries.
- [ ] **Germany** requires age ratings to consider random paid items, which can
  raise the rating.
- [ ] Answer the loot-box questions in both age-rating questionnaires honestly.
  The stores then label the app "In-app purchases (includes random items)".

### 3.4 Chat and trading between players

- [ ] **Report** a player, a chat message or a trade offer. Reports must reach
  you, and you must act on them.
- [ ] **Block** a player, so they can no longer message, challenge or trade with
  the blocker.
- [ ] Filter obviously abusive words in chat.
- [ ] Publish a contact address for complaints (support email in the store
  listing and inside the app).

---

## 4. Rights for a football card game

The biggest legal risk for this kind of game is **using real people, clubs or
competitions without a licence**, not the code.

- [ ] **Player names.** Rights to a real footballer's name and face ("personality
  rights") belong to the player, usually licensed through the players' union
  (FIFPRO) or the clubs. A name like "Isco Maestrito" or "Edson Black Pearl"
  points clearly at a real player. **Recommended: make every name fully
  fictional.** It costs nothing now and a lot after launch.
- [ ] **Faces.** Check the card art doesn't look like any specific real player.
  AI image tools can produce a real person's likeness without being asked to.
- [ ] **Clubs, leagues and competitions.** Don't use real club names, crests,
  kits or colours combined with a city, or names like "Premier League", "LaLiga",
  "Champions League", "UEFA" or "FIFA". Check every value in the card
  database's league and region fields.
- [ ] **Other games.** Never mention "FIFA", "EA Sports FC", "Ultimate Team" or
  similar in the app, the store text or the search keywords. They are trademarks,
  and stores reject keyword stuffing with other brands.
- [ ] **AI-generated art.** Keep a record of which tool made the card art, and
  check its terms allow commercial use in a paid game.
- [ ] **The name "TCG Manager".** Search the EU trademark database (EUIPO), the
  US one (USPTO) and both stores for existing games with the same or a very
  similar name.
- [ ] **Fonts and music.** The fonts come from Google Fonts, which are free for
  commercial use. Check the licence of any sound or music you add.

---

## 5. Google Play Console, step by step

1. [ ] **Create the developer account** at https://play.google.com/console.
   One-time fee of US$25. Google checks your identity with an official ID.
   Choose "personal" or "organisation".
2. [ ] **New personal accounts must test first.** Before you can publish to
   everyone, run a **closed test with at least 12 testers for at least 14 days
   in a row**. Plan for it: find 12 friends with Android phones before you
   start. Search the Play Console Help for "testing requirements for new
   personal developer accounts" to confirm the current numbers.
3. [ ] **Create the app.** Pick the name (max 30 characters) and default
   language. Choose **Game** and **Free**. A free app can never become a paid
   one later, and you sell gems inside it instead.
4. [ ] **Set up payments.** Create a payments profile so you can sell. Then
   create each gem product under **Monetize → Products → In-app products**. The
   product IDs must match the app exactly (see the checklist at the top of
   `server/lib/iap.js`).
5. [ ] **Fill in "App content"** (left sidebar, near the bottom):
   - [ ] Privacy policy link.
   - [ ] App access: give the reviewers the test login from section 1.
   - [ ] Ads: say whether the app shows ads.
   - [ ] Content rating: answer the IARC questionnaire (chat between players,
     in-app purchases, random paid items).
   - [ ] Target audience: pick the age groups. If you include children, stricter
     rules apply ("Families policy").
   - [ ] **Data safety form:** declare email, user ID, purchase history, chat
     messages and game activity. Say they are encrypted in transit and users can
     ask for deletion, and add the deletion link.
   - [ ] Account deletion: the link to `delete-account.html`.
6. [ ] **Store listing:**
   - [ ] App name (max 30 characters), short description (max 80), full
     description (max 4,000).
   - [ ] Icon 512 × 512 PNG, max 1 MB (`server/icon-512.png`).
   - [ ] Feature graphic 1024 × 500, JPEG or PNG without transparency.
   - [ ] 2 to 8 phone screenshots, JPEG or PNG. Each side 320 to 3,840 pixels, and
     the long side at most twice the short side.
   - [ ] Support email and, if you are a trader, your trader details.
7. [ ] **Upload the build.** Download the `.aab` from the latest run of the
   "Build signed Android app" GitHub Action. Upload it to **Testing → Closed
   testing** first, then to Production once the 14 days are done.
8. [ ] **Review.** Usually a few hours to a few days; the first one can take a
   week or more. Rejections arrive by email with the policy they broke.

## 6. Apple App Store Connect, step by step

1. [ ] **Join the Apple Developer Program** at https://developer.apple.com/programs/.
   US$99 per year. You need an Apple ID with two-factor sign-in.
   Organisations need a D-U-N-S number.
2. [ ] **Agreements, Tax and Banking** in https://appstoreconnect.apple.com.
   Accept the **Paid Apps** agreement and fill in bank and tax details. In-app
   purchases do not work without this.
3. [ ] **Add Apple In-App Purchase** to the iOS app for gems (section 1). Then
   create each gem as a **Consumable** in App Store Connect. The first in-app
   purchases must be submitted together with an app version.
4. [ ] **Build in the cloud** with the existing Codemagic iOS workflow
   (`codemagic.yaml`). It needs your Apple signing certificate and provisioning
   profile, which you create in your Apple Developer account.
5. [ ] **Create the app record:** name (max 30 characters), bundle ID, SKU,
   primary language.
6. [ ] **App Privacy ("privacy label"):** the same data as Google's form. Say
   which data is linked to the user, and that nothing is used for tracking
   across other companies' apps.
7. [ ] **Age rating:** answer Apple's questionnaire. Apple changed its age
   groups in 2025 to 4+, 9+, 13+, 16+ and 18+, so answer the newer questions
   too.
8. [ ] **Rules Apple checks closely for this game:**
   - [ ] Report and block for chat and trading (guideline 1.2).
   - [ ] Account deletion inside the app (already done).
   - [ ] Pack odds shown before purchase (guideline 3.1.1).
   - [ ] Gems sold only through Apple In-App Purchase inside the iOS app
     (guideline 3.1.1). No Stripe button in the iOS build.
   - [ ] "Sign in with Apple" is only required if you add Google or Facebook
     login. Email and password alone don't need it.
   - [ ] The app must feel like an app, not a website in a frame (guideline 4.2).
     Test it with no internet and make sure it shows a clear message, not a
     browser error page.
9. [ ] **Screenshots and icon:**
   - [ ] iPhone 6.9-inch screenshots, 1320 × 2868 portrait or 2868 × 1320
     landscape. Take them in landscape, since that's how the game is played.
     1 to 10 images.
   - [ ] iPad 13-inch screenshots (2064 × 2752) only if the app runs on iPad.
   - [ ] App icon 1024 × 1024 PNG, no transparency, square corners (Apple rounds
     them).
10. [ ] **Review notes:** the test login, a short explanation of packs and gems,
    and how to find chat, trading, report and block.
11. [ ] **Review.** Usually 1 to 2 days. Rejections arrive in the Resolution
    Center with the guideline number.

---

## 7. Final check before pressing Submit

- [ ] Everything in section 1 is fixed.
- [ ] Terms of service and privacy policy are live and linked in both stores and
  inside the app.
- [ ] Every card, club and league name is fictional.
- [ ] Test purchases work in each store's sandbox (Google license testers,
  Apple sandbox accounts), and the gems arrive.
- [ ] The reviewers' test account works and has cards and gems.
- [ ] Belgium decision made (switch off real-money packs, or leave the country
  out).
- [ ] Trader details entered in both stores.
- [ ] **Nothing is deployed until you've reviewed it locally.**

## Official pages to check against

- Google Play Console: https://play.google.com/console
- Google Play developer policies: https://play.google.com/about/developer-content-policy/
- Apple Developer Program: https://developer.apple.com/programs/
- Apple App Review Guidelines: https://developer.apple.com/app-store/review/guidelines/
- Apple privacy labels: https://developer.apple.com/app-store/app-privacy-details/
- App Store Connect: https://appstoreconnect.apple.com
- Age ratings for Google Play (IARC): https://www.globalratings.com
