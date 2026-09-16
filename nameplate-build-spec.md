# Nameplate — build spec

A two-person baby-name app, served on a home LAN. Two parents rank boys' names by
head-to-head duels; the app finds the names they *both* independently rank highly.

### Files in this handoff

| File | What it is |
|---|---|
| `nameplate-build-spec.md` | This document. The source of truth. |
| `names.json` | The 500-name seed pile, ready to load. See §10. |
| `nameplate-prototype.html` | A **working single-file prototype** — open it in a browser. |

The prototype is not a mockup: the duel loop, Elo maths, pair selection, blind gating,
match detection, vetoes, sheets and setup all work. **It has been reviewed and signed off by
the parents.** Read its source and lift from it freely — the CSS custom-property token block,
the type scale, the Elo and pairing functions and the copy are all intended to carry over
more or less verbatim. Where this document and the prototype disagree, the document wins;
where the document is silent, match the prototype.

What the prototype fakes, and the real app must not: it runs both people in one browser with
a simulated partner and `localStorage`. The real app is a server with two devices, real
persistence, and no identity switcher (§8).

---

## 1. The idea in one paragraph

Every other baby-name app is a swipe deck: you both mark names "yes", and end up with forty
names you both said yes to and no way to choose between them. Nameplate replaces the binary
with a **duel** — two names on screen, tap the one you prefer. Each tap feeds an Elo rating,
so a full ranked order emerges from single taps with no sliders and no scales. Ratings are
**blind**: neither person sees the other's opinion on a name until both have rated it at
least three times. When a name lands near the top of both people's lists, both phones fire a
match takeover at the same moment.

## 2. Non-goals

- No accounts or passwords. Exactly two users, claimed per-device on first run (§8), LAN-only.
- No internet deployment, no HTTPS, no cloud. It must work with the router offline.
- No girls' names, no sibling/multi-child support, no sharing outside the two of them.
- No push notifications. The app is open or it isn't.

---

## 3. Stack

| Layer | Choice | Why |
|---|---|---|
| Server | Node 20+, Express | Boring, zero-config |
| DB | SQLite via `better-sqlite3`, single file `data/nameplate.db` | Synchronous, one file to back up |
| Client | Vite + React + TypeScript | Fast build, static output served by the same Express process |
| Styling | Plain CSS with custom properties (copy the token block from the prototype) | No Tailwind needed; the design is token-driven |
| Realtime | Server-Sent Events on `GET /api/stream` | One-way is all that's needed; simpler than WebSockets |
| Install to phone | PWA — `manifest.webmanifest` + minimal service worker | So it opens fullscreen from the home screen |

Single process. `npm start` builds the client if needed, starts Express on `0.0.0.0:3000`,
and prints the LAN URL plus a terminal QR code (`qrcode-terminal`) to scan from both phones.

Optional nicety: advertise `nameplate.local` over mDNS with `bonjour-service` so they don't
have to remember the laptop's IP when DHCP reassigns it.

---

## 4. Data model

```sql
CREATE TABLE users (
  id       INTEGER PRIMARY KEY,     -- 1 = father, 2 = mother
  name     TEXT NOT NULL,           -- their actual first name, set at §9 setup
  surname  TEXT NOT NULL DEFAULT ''  -- the two may differ; never assume they match
);

CREATE TABLE devices (              -- a phone is bound to a person once, see §8
  token      TEXT PRIMARY KEY,
  user_id    INTEGER REFERENCES users(id),
  claimed_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE names (
  id        INTEGER PRIMARY KEY,
  name      TEXT NOT NULL UNIQUE,
  origin    TEXT,
  meaning   TEXT,
  added_by  INTEGER REFERENCES users(id),   -- NULL for seed names
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE ratings (                      -- one row per user per name
  user_id     INTEGER REFERENCES users(id),
  name_id     INTEGER REFERENCES names(id),
  elo         REAL NOT NULL DEFAULT 1500,
  comparisons INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, name_id)
);

CREATE TABLE duels (                        -- append-only log; ratings are derivable
  id        INTEGER PRIMARY KEY,
  user_id   INTEGER REFERENCES users(id),
  winner_id INTEGER REFERENCES names(id),
  loser_id  INTEGER REFERENCES names(id),
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE vetoes (
  user_id  INTEGER REFERENCES users(id),
  name_id  INTEGER REFERENCES names(id),
  created_at TEXT DEFAULT (datetime('now')),
  PRIMARY KEY (user_id, name_id)
);

CREATE TABLE matches (
  name_id    INTEGER PRIMARY KEY REFERENCES names(id),
  matched_at TEXT DEFAULT (datetime('now'))
);

-- keys: baby_surname ('father'|'mother'|'both'|'undecided'), setup_done
CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT);
```

Keep `duels` append-only so ratings can be recomputed from scratch if the algorithm is
tuned later. Ship a `npm run recompute` script that replays the log.

---

## 5. The rating algorithm — this is the part that matters

### Elo
```
K = comparisons < 10 ? 32 : 20
expected_win = 1 / (1 + 10^((loser.elo - winner.elo) / 400))
winner.elo += K_winner * (1 - expected_win)
loser.elo  -= K_loser  * (1 - expected_win)
both.comparisons += 1
```
Everyone starts at 1500. A skip writes nothing.

### Pair selection
Random pairs waste taps. Pick each pair like this:

1. Build the live pool: all names not vetoed **by either** user.
2. Sort by `comparisons` ascending — under-rated names get seen first.
3. Pick name A from the least-rated ~35% of the pool.
4. Pick name B:
   - **12% of the time**, uniformly at random (a wildcard, to break local optima and stop
     the session feeling like a rut).
   - **Otherwise**, from the 7 names with the closest Elo to A. Comparing near-equals
     extracts the most information per tap.
5. Reject a pair already shown to that user recently; retry up to 40 times.
6. Randomise which one renders on top, so position never correlates with anything.

### Vetoes
Long-press a name for **720ms** to strike it out. The strike-through animation must not
appear until **260ms** into the press — a tap is the *positive* action, and if the name a
user is choosing flashes a line through it the moment their finger lands, the gesture reads
as "delete" instead of "pick". Nothing about a normal tap may ever look destructive.

A veto is permanent and personal, but it
removes the name from **both** people's queues — no point spending taps on a name that is
already dead. The name moves to the "Struck out" tab labelled with who killed it, so the
other person can see it and argue. Any veto can be reversed from the name's detail sheet.
Every veto shows an "Undo" toast for a few seconds.

### Blind reveal
- A user's own ratings are never sent to the other client.
- `GET /api/list` returns the other person's Elo for a name **only when both users have
  `comparisons >= 3` on it**. Otherwise the field comes back `null` and the UI renders a
  dashed "pending" bar. Do the gating server-side — don't send it and hide it in CSS.
- Vetoes are the one exception: revealed immediately, because they change what you're shown.

### Matches
A name matches when it is in **both** users' top `matchDepth()` **and** both have
`comparisons >= 3`, where:

```
matchDepth = max(10, round(live_pool_size * 0.05))    // 25 at 500 names, 10 at 76
```

A fixed top-10 is right for a small pile and far too strict for a large one: over 500 names
two people who genuinely agree would almost never collide, and the app would simply never
fire the moment it's built around. Scale the bar with the pile, floor it at ten.
Insert into `matches`, then push over SSE to both clients, which fire the full-screen
takeover. Match once per name — never re-fire. If a match is later vetoed, delete the row.

### Combined "Ours" ranking
`combined_score = MIN(elo_dad, elo_mum)`

A name is only as strong as whoever likes it least. This is deliberate — averaging lets a
name one of them loves and the other tolerates float to the top, which is exactly the
wrong answer for a decision that needs two enthusiastic yeses.

### Agreement %
**Pairwise concordance**, not set overlap: of the name-pairs you have both confidently
rated and both have a clear preference between (Elo gap ≥ 15 on both sides), the share you
order the same way. 50% is a coin toss; 100% is identical taste.

Do not compute this as "share of my top 20 that's also in her top 20" — that collapses
toward zero as the pile grows and would read as 6% for a couple who actually agree.
Concordance is scale-free and means the same thing at 76 names as at 500.

---

## 6. Screens

### Duel (home) — keep it empty
The whole point of this screen is that it has nothing on it. No header, no nav bar, no
counters, no instructions. Just:
- Two full-width name plates split by a hairline rule with an italic "or" sitting on it.
- Each plate: the name huge in Bodoni Moda, then origin (mono, uppercase, claret) and
  meaning (italic serif) beneath.
- A small pill top-right showing whose phone this is. In the real app it is a **label, not a
  switch** — see the warning in §8.
- One thin bottom strip: a bordered **"Neither" pill, centred, minimum 44px tall** — skipping is a
  frequent action and must be as easy to hit as the names themselves — and a quiet
  "SHORTLIST ⟨n⟩" text link right.

### Navigation — no bottom tab bar
**Do not build a bottom nav bar.** On a phone the last ~60px of the viewport is routinely
eaten by browser chrome or a host panel, and anything anchored there becomes unreachable —
which strands the user on whatever screen they're on. All navigation is top-anchored:

- Duel screen: no chrome at all. The "Shortlist" link in the bottom strip is the way out,
  and it is not the only one — see below.
- Shortlist: a top bar with a **"‹ Keep duelling"** button on the left (claret, ≥40px tall)
  and the Dad/Mum switch on the right.
- Adding a name is **a sheet, not a screen** — opened from a full-width "+ Add a name to the
  pile" row pinned directly under the section note at the top of the shortlist. The sheet
  holds the name field, the optional note, the surname field and the say-it-aloud preview.
  Reject a name already in the pile with a toast rather than silently duplicating it.

This leaves exactly two screens (duel, shortlist) and two sheets (add, name detail).

**Overlays must be `position: fixed` and vertically centred — never bottom-anchored.** A
sheet that slides up from the bottom edge is the iOS convention and it is wrong here for the
same reason the tab bar was: the bottom strip of the viewport is unreliable, so a
bottom-anchored sheet opens *off-screen* and the tap looks like it did nothing. Centre every
sheet, cap it at `78vh`, and give it a close **×** in its own top-right corner so dismissing
never requires reaching the bottom either. Toasts go at the **top** of the viewport, for the
same reason.

Interactions: **tap a plate and that name wins** — this is the positive action and must
read that way. The winner takes a claret wash and the word "chosen" in tiny mono caps
beneath it; the loser fades to ~28%; after ~260ms the next pair loads. Long-press = veto,
with the name letter-spacing opening and striking through, but only after the delay in §5.
Haptic buzz on veto and on match.

**First run only**, before the first duel: a full-screen ink overlay stating the two rules —
"*Tap* the name you like more. It wins." / "*Hold* a name to strike it out for good." — plus
one line explaining the blind reveal, and a Start button. Shown once per device, then never
again. This is the only place instructions are allowed to live; the duel screen itself stays
empty forever.

**Both plates must be visually identical.** No colour, size or position difference — any
asymmetry biases the vote and corrupts the ratings.

### Shortlist
Three tabs: **Ours** / **Mine** / **Struck out**. Rows show rank, the name in serif,
origin · meaning in mono caps, a two-bar mini chart (you / them) with a "Match" chip in
brass or a "Pending" chip in claret, and a **chevron** — rows are tappable and must look it.

Tapping a row opens the **name detail sheet**: origin, meaning, the full name with the
surname, your rank and comparison count, theirs (or "sealed until you've both rated it three
times"), and a strike-out / revive action. This sheet is where a name gets killed *after*
you've formed an opinion on it, as opposed to the long-press during a duel.

A stats strip (duels, matches, agreement %) sits at the foot of the list, below the rows.
Names added by either person enter both people's pools at 1500.

---

## 7. API

```
GET  /api/me                     -> { userId, label, surname }
POST /api/me                     { userId }            switch person (cookie)
GET  /api/pair                   -> { a: Name, b: Name }
POST /api/duel                   { winnerId, loserId } -> { matches: Name[] }
POST /api/skip                   { aId, bId }          (record only, to avoid repeats)
POST /api/veto                   { nameId }            -> {}
DELETE /api/veto/:nameId                               revive
GET  /api/list?tab=ours|mine|out -> Row[]              (partner elo nulled per §5)
POST /api/names                  { name, meaning }
GET  /api/stats                  -> { duels, matches, agreement }
PUT  /api/settings/surname       { value }
GET  /api/stream                 SSE: match, veto, partner-progress
```

See §8 for how a request is attributed to a person.

---

## 8. Identity — which phone is which person

There are no passwords, but the app cannot simply *ask* on every load either: the blind
reveal in §5 is only worth anything if a phone can't claim to be the other person and read
their ratings. **Devices are claimed, once.**

1. First load on a device with no `nameplate_device` cookie → server mints a device token,
   stores it, and shows a "Which one of you is this?" screen.
2. The person picks. The server writes `device_token → user_id` and will not accept a
   different user for that token again.
3. The **second** device to appear can only claim the remaining person — show the other
   option already taken, greyed, so there's nothing to get wrong.
4. Any further device (a tablet, a reinstall) shows both options again and rebinds; that's
   the escape hatch for cleared storage. A "This phone is actually <other person>" action in
   settings does the same thing deliberately.

This is a home-LAN app shared by two spouses — the goal is to stop *accidental* anchoring and
idle peeking, not to withstand a determined attacker who already has the wifi password. Don't
add PINs.

> **The Dad/Mum toggle in the prototype is a demo affordance only** — it exists so one person
> can review both sides of the app. **Do not ship it.** If either phone can switch identity
> at will, blind rating is decoration.

## 9. Setup — collected once, on first run

The first thing a new install shows, before any duel, is a setup sheet. The same sheet is
reachable afterwards from "Names & surnames" at the foot of the shortlist — one component,
two entry points, so nothing is a dead end.

It collects:

| Field | Notes |
|---|---|
| Father's first name | Becomes their label everywhere — no hard-coded "Dad"/"Mum" in the UI |
| Father's surname | |
| Mother's first name | |
| Mother's surname | **Do not assume the parents share a surname** |
| The surname he'll carry | Father's / Mother's / Both hyphenated / **Not decided yet** |

`babySurname` drives every full-name rendering in the app:

```
father    -> ["Smit"]
mother    -> ["Novak"]
both      -> ["Smit-Novak"]
undecided -> ["Smit", "Novak", "Smit-Novak", "Novak-Smit"]
```

When it's "not decided yet", the name detail sheet and the setup preview render **every**
variant stacked. This is a feature, not a fallback: hearing "Ari Smit-Novak" next to "Ari
Novak" is often what settles both the first name *and* the surname question, and a name that
only works with one of the four is worth knowing about early.

Middle names are deliberately out of scope for v1 — add a `middle_name` setting later if the
say-it-aloud test starts feeling incomplete.

## 10. Seed data

`seed/names.json` ships with the project — **500 entries, already built**, same data the
prototype runs on. Shape:

```json
{ "name": "Oliver", "origin": "Latin", "meaning": "olive tree", "rank": 1,    "group": null  }
{ "name": "Luka",   "origin": "Slavic", "meaning": "light",     "rank": 53,   "group": "luca" }
{ "name": "Griffin","origin": "Welsh",  "meaning": "strong lord","rank": null, "group": null  }
```

- `rank` — position in Australia's published top 100 for the most recent year, or `null`
  for the other 400. **Never show rank on the duel screen**; it belongs in the detail sheet
  only. A popularity number next to a name at the moment of choosing is pure anchoring, and
  it would corrupt exactly the signal this app exists to capture.
- `group` — a variant family key. 74 families are tagged: Luca/Luka, Miles/Myles,
  Aiden/Aidan, Reece/Rhys, Theo/Theodore, Max/Maxwell/Maximilian, and so on.

### Variant families matter more than they look
Pairing a name against its own spelling variant is a coin toss that teaches the ranking
nothing and makes the app feel stupid — "Luca or Luka?" is not a question anyone can
answer. **The pair selector must reject any pair sharing a `group`.**

### No biblical names — a hard constraint
The parents have ruled out scripture entirely. 101 names were removed and replaced. The rule
applied, and the rule to keep applying if the list is ever extended:

- **Cut** any name borne by a figure in scripture, *in any language form*. Not just Noah,
  Levi and Isaac but Luca/Luka/Lucas/Luke (the evangelist), Jack/Ian/Ivan/Sean/Evan (John),
  Hamish/Seamus/Diego/Santiago (James), Bram (Abraham), Phillip, Simon, Silas, Stephen,
  Thomas, Michael, Gabriel, Toby/Tobias.
- **Keep** surname-derived forms — Jackson, Jaxon, Anderson, Davis, Nixon. Nobody hears
  "John" in "Jackson"; they read as surnames, not scripture.
- **Keep** Latin/Greek roots whose biblical namesake is coincidental: Marcus, Marco, Marcel,
  Martin (all "of Mars") stay while **Mark** goes; Lucian and Luciano (from *lux*) stay while
  Luke goes; Sylvester stays while Silas goes.

Only 71 of the top 100 survive, so `rank` is sparser than it was — that's expected, not a bug.

**Judgement calls left in, for the parents to veto in the app if they disagree:**
Christian, Christopher, Kit, Dominic ("of the Lord"), Cruz ("cross"), Noel ("Christmas"),
Nicholas/Nico/Nikolai (a saint, not scripture), and Jason (overwhelmingly the Argonaut,
though the name does appear once in Acts). These are religious-adjacent but not names of
biblical figures. Do not silently remove them; striking out is the parents' call.

### Provenance, stated honestly
Ranks come from Australia's published top-100 boys' list for the most recent year
([Better Homes & Gardens](https://www.bhg.com.au/lifestyle/australian-names-top-aussie-baby-boy-girl-names/)),
cross-checked against the [Victorian registry](https://www.vic.gov.au/top-baby-names-2025)
and [McCrindle](https://mccrindle.com.au/article/top-baby-names-2025/) top-tens.
The unranked names and **all 500 etymologies are compiled knowledge, not
source-verified.** They're standard and very likely correct, but the meaning sits on screen
at the moment of decision, so before shipping, spot-check the etymologies against Behind the
Name — prioritising any name that reaches a shortlist.

---

## 11. Build order

1. Express + SQLite + schema + seed loader; `GET /api/pair` returning a sane pair.
2. Elo write path and the duel log; verify ratings converge over a scripted 500-duel run.
3. Duel screen, exactly as spec'd in §6 — get this feeling right before anything else.
4. Shortlist with blind gating.
5. SSE + the match takeover.
6. Add screen, vetoes, undo, detail sheet.
7. PWA manifest, service worker, QR code on boot, mDNS.

## 12. Done means

Both phones are on the home wifi, each has Nameplate on the home screen, and either of them
can open it, settle twenty duels in under a minute without reading a single instruction, and
watch a name they both love announce itself on both screens at once.
