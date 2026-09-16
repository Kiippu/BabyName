# Nameplate — Change Order 4: Public hosting on PythonAnywhere, and the PIN gate

Nameplate leaves the LAN. It goes to `https://<username>.pythonanywhere.com`, on the free tier,
behind a PIN.

**This supersedes**, in the original build spec: non-goal #2 (*"No internet deployment, no HTTPS,
no cloud"*), the Server and Realtime rows of §3, §8's *"Don't add PINs"*, and step 7 of §11 (QR
code, mDNS). **Everything else stands** — the rounds mechanic (CO-1), themed rounds (CO-2), packs
and themes as data (CO-3), the screen specs, the no-bottom-nav rule, the seed rules. None of the
design moves. The server does.

Precedence, highest first: **CO-4 (hosting & access) → CO-3 → CO-2 → CO-1 → build spec.**
CO-1 through CO-3 are already implemented in this repo; read the code, not just the documents.

Written against the working tree at `D:\kory\repos\BabyName` as of 16 September 2026 — every
file, table and route named below was read, not inferred. PythonAnywhere figures marked *measured*
come from their current docs and staff posts; sources at the foot.

---

## 0. The fact that determines everything else

**PythonAnywhere runs Python WSGI applications only. A Node process can run there but cannot be
exposed to the internet.** Their staff, verbatim: *"You are able to run node, but not to expose it
to the outside world."*

So this is not a deployment. It is a **server rewrite** — and the repo is in unusually good shape
for one, because the hard thinking is all in SQL that copies across untouched.

| Piece | Lines/size | Fate |
|---|---|---|
| `server/src/index.js` | 7 KB | **Rewrite** as a Flask app + blueprints. It is 14 thin route handlers and nothing else |
| `server/src/rounds.js` | **18 KB — a third of the server** | **Rewrite, but mostly transcription.** `eligibleThemesStmt` and `themedDrawStmt` are CO-3's recursive CTEs, already implemented correctly. **Copy the SQL character for character** |
| `db.js`, `identity.js`, `list.js`, `stats.js`, `detail.js`, `names.js`, `settings.js`, `themes.js`, `packs.js`, `seed.js`, `transaction.js` | ~23 KB total | Rewrite. All thin; `node:sqlite`'s `DatabaseSync` is a near-exact match for Python's stdlib `sqlite3` — both synchronous, both prepared-statement based. Named parameters `@foo` become `:foo` |
| `server/src/schema.sql` | 6.5 KB | **Unchanged.** SQLite is SQLite |
| `server/src/stream.js` | 744 B | **Deleted — it is dead code.** See §4 |
| `seed/packs/*.json` | — | Unchanged |
| `client/` (React 18 + TS + Vite) | — | **Two edits only.** §3 and §4 |
| `client/dist/` | 165 KB JS, 19 KB CSS | Already built and already in the tree. Node stays on your laptop as a build tool and never touches the server |
| `data/nameplate.db` | 274 KB | **Moves verbatim — but read §6 first, there is a trap** |
| `bonjour-service`, `qrcode-terminal`, `express`, `cookie-parser` | — | All four dependencies go. The Python app has one: Flask |

Roughly **1,300 lines of JavaScript**, of which `rounds.js` is a third and perhaps half of that
third is SQL string literals that transcribe unchanged. This is a two-to-three-day port, not a
rebuild.

---

## 1. Three things in the repo that change the plan

All three are LAN-correct decisions that become wrong the moment the app has a public URL.

### 1.1 `POST /api/me` is an unauthenticated identity switcher — and it is the *only* identity mechanism

```js
app.post("/api/me", (req, res) => {
  const userId = Number(req.body.userId);
  if (userId !== 1 && userId !== 2) return res.status(400).json({...});
  const session = selectProfile(res, userId);   // no credential checked. at all.
  res.json(mePayload(session));
});
```

Anyone who can reach the URL can `POST {"userId": 2}` and **become either parent**, with full read
access to everything that parent has kept. The build spec's §8 warned about exactly this — *"if
either phone can switch identity at will, blind rating is decoration"* — and on a LAN it was a
defensible call, because the wifi password was the wall. **On a public URL there is no wall.** The
`devices` table has already been dropped (`db.js` migrates it away) and replaced by a 5-minute
sliding `sessions` table, so there is nothing else standing between a stranger and the data.

This is not a hardening task to schedule. **It is the reason the PIN exists, and the site cannot go
up before it is closed.** §3.

### 1.2 The database on disk is 274 KB. Its write-ahead log is 4.1 MB.

```
data/nameplate.db          274,432 bytes
data/nameplate.db-wal    4,124,152 bytes   <- 15x the database
data/nameplate.db-shm       32,768 bytes
```

`db.js` sets `PRAGMA journal_mode = WAL`, and the log has never been checkpointed. **Most of the
round history is in that `-wal` file, not in the `.db` file.** Copy `nameplate.db` on its own to
PythonAnywhere and you arrive with a database that looks plausible, opens cleanly, and is missing
weeks of sorting. Migration procedure in §6 — three commands, and the single most destructive
mistake available in this plan.

### 1.3 `data/` lives inside the repo, and the pack loader runs on every boot

`data/` sits at the repo root alongside `server/` and `client/`, holding the live database and four
backups. One `git clean -fd` to fix a bad deploy and every round ever played is gone. It moves
outside the clone, permanently (§7).

Separately, `seed()` — and therefore `loadPacks()` — runs at module load in `index.js`, so **every
process start re-upserts 3 packs, 61 themes, 846 names and ~1,032 links**: roughly 3,600 statements
before the first request is served. On a laptop with WAL that is a few milliseconds. On
PythonAnywhere it is a write transaction against a networked filesystem with no WAL, on every
reload, holding up the first request. Make it an explicit script (§7) and have the app assert the
counts at boot instead of rebuilding them.

---

## 2. What the free tier gives you, and what it costs

*Measured, from PythonAnywhere's docs:*

| Free tier | Consequence for Nameplate |
|---|---|
| **1 web app, 1 web worker** | Writes are serialised by the platform before SQLite is even involved — which is why §6 is short. Also why a held-open connection would be fatal, if you still had one |
| **1 month expiry** | The site disables itself monthly unless you click "Run until…" on the Web tab. **This is the uptime problem** — §8 |
| **100 CPU-seconds/day** | Comfortable on the numbers in §4, provided static assets bypass Python |
| **No MySQL** (accounts created after 15 Jan 2026) | Irrelevant. You're on SQLite and staying there |
| **512 MiB disk** | Fine: venv ~40 MB, `dist/` ~200 KB, database ~1 MB |
| **Outbound allowlisted** | `github.com` is on the list, so `git pull` deploys work. The app makes no outbound calls anyway — CO-3 §4 ruled that out on the "works with the router offline" principle, and that decision now pays for itself |
| **HTTPS free on the subdomain** | And it repairs the PWA — §7 |
| **No SSH, 2 Bash consoles** | Enough: `git`, `python`, `sqlite3` are all there |

### On "100% uptime" — the honest version

Nobody sells 100%. The free tier gives you a site that is always listening and never sleeps, and
then **disables itself once a month.** That is the only outage you are actually likely to have, and
it is a calendar problem, not an engineering one (§8). The upgrade path is **Developer, $10/month**
— no expiry, 5,000 CPU-seconds, 3 web workers, custom domain, SSH. Nothing in this plan changes on
upgrade except that three workers write to one SQLite file, so re-read §6 first.

---

## 3. The gate

### Two PINs, one per parent — and it lands on exactly one endpoint

The insertion point is already built. `POST /api/me {userId}` takes a claim and mints a session;
the PIN version takes a *credential* and mints the same session. Everything downstream —
`sessionMiddleware`, `requireUser`, `mePayload`, the 401 handling in `api.ts`, the fallback to the
claim screen in `App.tsx` — works unchanged.

```
POST /api/gate  { pin: "481920" }  ->  { userId, label, surname }   (replaces POST /api/me)
```

One shared PIN plus the existing "which one of you is this?" screen would be the obvious design.
**Don't.** A PIN per parent does two jobs with one mechanism:

| | Shared PIN + pick-a-person | **One PIN per parent** |
|---|---|---|
| Keeps strangers out | Yes | Yes |
| Establishes *which* parent | An unauthenticated pick — §1.1, unchanged | **The PIN is the claim** |
| Blind reveal rests on | Politeness | The other person's PIN |
| Screens | PIN screen **and** picker | PIN screen only |

`ClaimDevice.tsx` (1.4 KB, two buttons) becomes `PinScreen.tsx` — a 6-digit numeric field,
`inputMode="numeric"`, autofocus. `api.claim(userId)` becomes `api.gate(pin)`. That is the whole
client change for this section.

### Rules — all of them, not most

- **6 digits.** 4 is 10,000 combinations with two valid answers in the space.
- **Store a hash.** `werkzeug.security.generate_password_hash` (scrypt) is already in Flask's
  dependency tree. Add `pin_hash TEXT` to `users`.
- **Compare against both users' hashes every time**, even after one matches, so timing doesn't say
  whose PIN it was.
- **Rate-limit, with the counter in SQLite**, not a module-level dict that evaporates on the worker
  restart a brute-force attempt would cause:
  ```sql
  CREATE TABLE IF NOT EXISTS gate_attempts (
    id INTEGER PRIMARY KEY,
    ip TEXT,
    at INTEGER NOT NULL,        -- epoch ms, matching sessions.expires_at
    ok INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_gate_attempts_at ON gate_attempts(at);
  ```
  5 failures from an IP in 15 minutes → locked 15 minutes. **Plus a global cap**: 30 failures in an
  hour locks the gate for an hour, because for a two-person app that is not a typo. Prune rows
  older than a day on write — the same opportunistic sweep `selectProfile` already does for
  `sessions`.
  > Behind PythonAnywhere's proxy, `request.remote_addr` is the proxy, not the phone. Read
  > `X-Forwarded-For` — but **log what it actually contains before relying on it**. If it's not
  > trustworthy, the global cap alone is sufficient for two users.
- **One failure message**: *"That PIN isn't right."* No hints, no "that's Anna's PIN".
- **Gate every `/api/*` route** in a single `before_request` with a two-path allowlist (`POST
  /api/gate`, `GET /api/health`), so a route added in six months is protected by default rather
  than by memory. `requireUser` becomes redundant; delete it rather than leaving two mechanisms.

### The session TTL has to change — and it's a real trade-off

`identity.js` uses a **5-minute sliding session**, deliberately: the comment explains it replaced
permanent device binding because a shared phone kept getting stuck as the wrong person. With PINs,
that problem is solved better — you re-enter *your own* PIN — but 5 minutes now means typing six
digits nearly every time you open the app.

**Recommendation: 30-day sliding, plus an explicit "Not me — switch" action** in the settings
sheet. The deployed reality is two phones, one person each (spec §12), and a long session is what
makes a home-screen PWA feel like an app rather than a login form. The `Secure` flag goes on the
cookie (it is currently `secure: false` with a comment pointing at LAN-only HTTP), and `SameSite`
stays `lax`.

**If you actually share one phone, keep it short** — 15 minutes, say — because then the idle
timeout *is* the blind-reveal defence. Pick one and write the number in the comment that is
currently there explaining the 5.

### What is not gated, and why that's fine

`index.html`, `/assets/*` and the icons are served by nginx (§7) and are public. That is correct —
they are an empty shell, and it is what keeps them off the CPU budget. **The requirement: no name
data may be baked into the bundle.** It currently isn't — everything comes from `/api/*` — so this
is a one-time check after the first production build: grep `dist/assets/*.js` for a name that only
exists in `world.json`.

### Recovery

```bash
python -c "
from werkzeug.security import generate_password_hash as h
import sqlite3; d = sqlite3.connect('/home/USER/nameplate-data/nameplate.db')
d.execute('UPDATE users SET pin_hash=? WHERE id=?', (h('123456'), 1)); d.commit()"
```

Plus a "Change my PIN" row in the settings sheet — same component, two entry points, the pattern
§9 of the build spec already set.

---

## 4. SSE: delete it. The polling you need is already written.

**`stream.js` is dead code.** `broadcast()` is exported and never called from anywhere in the repo.
`openMatchStream()` in `api.ts` is never imported by any component. Both are leftovers from the
superseded duel mechanic ("push channel for match takeovers", CO-1 deleted the concept). The
endpoint currently does nothing but emit a heartbeat every 25 seconds into a connection nobody opens.

This matters more than tidiness: **on one web worker, one client holding that stream open would
block the entire site for both of you** — including the partner whose sealing you were waiting on.
PythonAnywhere also kills any request over 5 minutes (*measured*), so it would die mid-round anyway.
Delete `stream.js`, the route, `openMatchStream`, and `MatchEvent`. Nothing calls them.

**And the waiting screen already polls.** `SetScreen.tsx` refreshes `/api/round` every 3 seconds
while `round.waiting`, with a `visibilitychange` listener for the resumed-from-background case and a
clean `clearInterval` on unmount. It is well built — the comment even explains why the visibility
listener is needed. Two adjustments for the CPU budget:

1. **3s → 5s.** Nothing in this app is worth 0.3 requests per second.
2. **Add a hard stop after 10 minutes**, replaced by a "Check again" button. A phone left awake on
   the waiting screen is the only realistic way to spend 100 CPU-seconds.

Optionally, serve `/api/round` with an `ETag` and return `304` while waiting — the waiting payload
is small and identical between polls. Worth it if the quota ever gets tight; not worth it on day one.

**Quota arithmetic** (*estimate — measure on the running site*): a Flask + SQLite request of this
shape should cost single-digit milliseconds; budget 20 ms. 100 CPU-seconds ÷ 0.02 s ≈ **5,000
requests/day**. A heavy evening — two parents, ten rounds, fifty sets, plus shortlist browsing and
two ten-minute waits — is a few hundred. An order of magnitude of headroom.

The blind rule stays enforced server-side in `getRoundResult` (403 until both have sealed), exactly
as CO-1 requires. The poll is a doorbell, never a source of truth.

---

## 5. The port, route by route

Every route in `index.js` as it exists today. All gated except where noted.

| Route | Source module | Port notes |
|---|---|---|
| `POST /api/gate` | **new** `gate.py` | Replaces `POST /api/me`. Ungated, rate-limited. §3 |
| `GET /api/me` | `identity.js` | `mePayload` minus `candidates` — there is nothing to pick from any more |
| ~~`POST /api/me`~~ | `identity.js` | **Deleted.** §1.1 |
| `GET /api/round` | `rounds.js` | The big one. Copy the CTEs verbatim |
| `POST /api/set` | `rounds.js` | The one hot write path. One `BEGIN IMMEDIATE`, six rows, commit |
| `GET /api/round/:id/result` | `rounds.js` | 403 until both sealed. Server-side |
| `POST /api/round/:id/ack` | `rounds.js` | Per-parent recap acknowledgement (`round_acks`) |
| `POST /api/names` | `names.js` | Duplicate → 400 + toast, as now |
| `GET /api/names/:id` | `detail.js` | Counts, not a round log (CO-2 §1) |
| `GET /api/list?tab=in\|out` | `list.js` | `rounds_survived DESC, selectivity DESC` |
| `GET /api/stats` | `stats.js` | Agreement % = per-round overlap |
| `GET /api/settings`, `PUT /api/settings` | `settings.js` | Whole-object PUT, as built — not the spec's `/api/settings/surname` |
| `GET /api/themes`, `PUT /api/themes/:id` | `themes.js` | CO-3 step 6 |
| ~~`GET /api/stream`~~ | `stream.js` | **Deleted.** §4 |
| `GET /api/health` | new | Ungated, `{ok: true}` |
| `GET /api/backup` | new | Gated. §9 |
| `GET /*` (SPA fallback) | `index.js` | Becomes a Flask catch-all serving `dist/index.html`; `express.static` becomes nginx mappings (§7) |

### The database layer — five rules

`db.js` becomes `db.py`, and four of the five PRAGMAs change:

1. **Connection per request** on `flask.g`, closed in `teardown_appcontext`. Not a module-level
   singleton — `db.js` can hold one because Node is one process with one thread; a WSGI worker is
   not that.
2. **`PRAGMA busy_timeout = 5000`**, first thing on every connection. This single line converts
   almost every *"database is locked"* into a short wait.
3. **`PRAGMA foreign_keys = ON`** on every connection — it is per-connection and off by default.
   `db.js` already does this; don't lose it in translation.
4. **`BEGIN IMMEDIATE` for every write.** `transaction.js` wraps writes today; keep the wrapper,
   take the write lock up front.
5. **`PRAGMA journal_mode = DELETE` — turn WAL off.** WAL coordinates through a shared-memory file
   that networked filesystems don't provide reliably, and PythonAnywhere's storage is networked.
   This inverts the choice `db.js` makes today, which is correct for a laptop. **Put the reason in
   a comment** or someone will helpfully re-enable it.

### DDL stops running at import

`db.js` executes `schema.sql` plus a series of guarded `ALTER`/`DROP` migrations every time the
process starts. On PythonAnywhere that is DDL on every worker start. The database is already fully
migrated — those guards have all fired. Move schema and migrations into `init_db.py`, run once by
hand, and have `create_app()` assert instead:

```python
assert counts() == (3, 61, 846, 1032), "run init_db.py"
```

### Tests that must survive the language change

CO-3 shipped measured assertions. Re-implement in `pytest` — they are the regression surface of the
data model:

- **1,000 draws from `classical`, zero variant-family clashes** (CO-3 measured 21.6% for a naive
  themed draw). The easiest thing to lose in a port, because the wrong query returns
  plausible-looking names.
- A region draw (`africa`) returns rows at all — the recursive-CTE trap from CO-3 §1.
- Loader idempotency: **3 packs, 61 themes, 846 names, 1032 links**, no name id moved.
- `/api/round/:id/result` → 403 when only one parent has sealed.
- **Gate:** wrong PIN ×5 → locked; correct PIN during lockout → still locked.

---

## 6. Moving the database (the trap from §1.2)

The schema doesn't change, so this is a file copy — **after** folding the 4.1 MB write-ahead log
back into the 274 KB database. Stop the Node server first; nothing may be holding the file.

```bash
# laptop, with the server stopped
sqlite3 data/nameplate.db "PRAGMA wal_checkpoint(TRUNCATE);"
sqlite3 data/nameplate.db "PRAGMA journal_mode = DELETE;"   # -wal and -shm should now be gone
sqlite3 data/nameplate.db "PRAGMA integrity_check;"         # expect: ok
```

Then upload `nameplate.db` alone through the Files tab to `/home/USER/nameplate-data/`. If a `-wal`
file still exists after those commands, **something still has the database open** — find it before
copying anything.

Round history, survivors, settings and both users arrive intact. Do it while nobody is mid-round.

### SQLite in production, honestly

PythonAnywhere staff (*measured, from their forums*): the filesystem is persistent and replicated;
SQLite is slower there than MySQL; *"the problems we've seen with SQLite normally happen when the DB
files are larger than 1MiB, and get particularly bad if you have different users… concurrently
trying to make changes (because the way it handles locking, especially on networked filesystems,
doesn't scale super-well)."* For small databases with light traffic they say try it.

Nameplate is the good case and provably so: **one web worker** serialises writes before SQLite sees
them, two users, 274 KB of data, and a write burst of six rows five times a round. With the five
rules above you should never see a lock.

**What changes on upgrade:** Developer's 3 workers is the case that quote warns about. Still likely
fine at this write volume — but if `database is locked` starts appearing in the error log after
upgrading, that's the cause, and the fix is MySQL (included on paid plans), not more PRAGMAs.

> Timestamps: `datetime('now')` is UTC and the server runs UTC, where the laptop doesn't. Existing
> rows keep what they have. Nothing in the app reasons about dates, so it's a display footnote.

---

## 7. Layout, deploy, and the PWA

### On the server

```
/home/USER/
  nameplate/                  <- the git clone. Disposable. Holds no state
    server/  app.py  db.py  rounds.py  gate.py  init_db.py  requirements.txt
    seed/packs/*.json
    client/dist/              <- committed build output
  nameplate-data/
    nameplate.db              <- OUTSIDE the clone. §1.3
```

`data/` goes into `.gitignore` in the same commit that moves it, along with `*.db-wal`, `*.db-shm`
and the four `backup-pre-*` files currently tracked alongside it.

### The build stays on the laptop

`npm run build` → commit `client/dist/` → push. Committing build output is normally poor practice;
here it is the mechanism, because the server cannot run Node — and `dist/` is already in the tree,
so this changes nothing about how the project already works.

```bash
# laptop
npm --prefix client run build && git add -A client/dist && git commit -m build && git push
# PythonAnywhere Bash console
cd ~/nameplate && git pull      # then click Reload on the Web tab
```

### WSGI config — and where the secrets live

Web tab → **Manual configuration** (not the Flask wizard, which scaffolds a file you'd delete) →
point at the virtualenv → edit `/var/www/USER_pythonanywhere_com_wsgi.py`:

```python
import sys
sys.path.insert(0, '/home/USER/nameplate/server')
import os
os.environ['NAMEPLATE_DB_PATH']    = '/home/USER/nameplate-data/nameplate.db'
os.environ['NAMEPLATE_SECRET_KEY'] = '<64 random hex chars>'
from app import create_app
application = create_app()
```

`NAMEPLATE_DB_PATH` is the same env var `db.js` already honours for tests — keep the name.
**This file is not in the repo, which makes it the right home for the secret key.** Nothing secret
goes in git: not the key, not the PINs, not the database.

### First run

```bash
git clone https://github.com/USER/nameplate.git ~/nameplate
mkvirtualenv --python=/usr/bin/python3.11 nameplate && pip install flask
mkdir -p ~/nameplate-data      # then upload nameplate.db per §6
python ~/nameplate/server/init_db.py --assert-only
python ~/nameplate/server/set_pin.py 1 <his-pin>
python ~/nameplate/server/set_pin.py 2 <her-pin>
```

### Static mappings (Web tab → Static files)

| URL | Directory |
|---|---|
| `/assets/` | `/home/USER/nameplate/client/dist/assets/` |
| `/icons/` | `/home/USER/nameplate/client/dist/icons/` |

Served by nginx, never touching Python, **zero CPU-seconds** — most of the traffic by volume.
`/`, `/sw.js` and `/manifest.webmanifest` stay on Flask routes, all three with `Cache-Control:
no-cache`. **A long-cached `sw.js` is a site you cannot update.**

### The PWA gets better for free

A service worker requires a secure context, so on `http://192.168.x.x:3000` the install was always
half-broken, particularly on iOS. On HTTPS it works properly for the first time.

One change to `public/sw.js`: it is currently network-first for everything non-`/api/`, which means
every launch hits the network even for the immutable hashed bundle. Make `/assets/*`
**cache-first** (Vite content-hashes the filenames, so a new build is a new URL — it can never go
stale) and leave `index.html` network-first. Every request the worker answers is a request that
costs nothing. Keep the `/api/` exclusion exactly as it is: **a cached round is a blind-reveal bug
wearing a performance costume.** Keep the `controllerchange` reload in `main.tsx` too — the comment
records what it cost to learn.

---

## 8. Uptime operations

**The monthly renewal is the whole job.** The Web tab has a button extending the site another
month; free-tier expiry is **1 month** (*measured — it was 3 months historically, so most advice
online is out of date*). Miss it and the site serves a "disabled" page. **Data is untouched** —
one click restores it — but the app is down until someone notices, which for an evening app could
be days.

1. **A monthly reminder you actually see.** This is the entire fix.
2. **Check the Web tab whenever you deploy** — the expiry date is displayed right there.
3. **$10/month removes it permanently.** Decide after a month of real use.

**CPU quota**: exceeding 100 CPU-seconds throttles your processes rather than stopping the site.
The failure looks like sluggishness, not an error, and it resets daily.

**When something breaks**, the error log is on the Web tab
(`/var/log/USER.pythonanywhere.com.error.log`) and it is always the first place to look. A 500 after
a deploy is nearly always a missing dependency or a stale `.pyc` — reload before debugging anything
else.

**An external uptime monitor** costs ~6 CPU-seconds/day and does nothing about the monthly expiry,
which is the outage you'll actually have. Don't mistake one for the other.

---

## 9. Backups

Free accounts get no scheduled tasks, so this is manual and should be trivial enough that it gets
done.

`GET /api/backup` — gated, returns the database as a download. **Use SQLite's backup API, not a
file read**, or a copy taken mid-write is silently torn:

```python
src = sqlite3.connect(DB_PATH); dst = sqlite3.connect(tmp_path)
src.backup(dst)                  # consistent snapshot even under concurrent writes
dst.close(); src.close()
# send_file(tmp_path, as_attachment=True, download_name=f'nameplate-{date.today()}.db')
```

Bookmark it; tap it when you do the monthly renewal. Same trip, both chores. (The four
`backup-pre-*` files in `data/` show the instinct is already there — this just makes it one tap
from a phone.)

---

## 10. Build order

1. **`db.py` + `schema.sql` + `init_db.py`**, running locally against a *copy* of the checkpointed
   database (§6). Prove it opens and the counts assert.
2. **`gate.py` first** — `POST /api/gate`, the `before_request` allowlist, `pin_hash`,
   `gate_attempts`, lockout. Before any other route, so nothing is ever served unprotected even on
   the laptop.
3. **`rounds.py`** — transcribe the CTEs, then run the 1,000-draw clash test before anything reads
   it. If this is wrong, everything downstream is subtly wrong.
4. **The remaining eleven routes** (§5). Test each against the real data.
5. **Deploy the API alone** and hit `/api/health` and `/api/gate` from a phone on 4G with wifi off.
   **Stop here.** This proves WSGI config, virtualenv, database path, HTTPS and the gate while the
   surface is small enough to debug from a log.
6. **Client**: `ClaimDevice.tsx` → `PinScreen.tsx`, `api.claim` → `api.gate`, delete
   `openMatchStream`, poll 3s → 5s with a 10-minute cap.
7. **Build, commit `dist/`, deploy, add the static mappings.** Grep the bundle for a `world.json`
   name (§3).
8. **`sw.js`**: cache-first for `/assets/*`. Install on both phones from the home screen.
9. **Backup endpoint, monthly reminder, first backup taken.**
10. **Delete** the Node server, `stream.js`, the four npm dependencies, and the LAN instructions in
    the README.

Steps 1–5 are the port. 6–8 are a day. 9–10 are an hour.

---

## 11. What will bite you

Ranked by cost of discovering late.

1. **Copying `nameplate.db` without checkpointing the 4.1 MB WAL.** §1.2. You lose weeks and the
   result looks fine.
2. **Shipping `POST /api/me`.** §1.1. The gate is worthless while it exists.
3. **Leaving `data/` in the repo.** One `git clean -fd` on a bad deploy day.
4. **A cached `sw.js`.** An update the phones refuse to see, with no remote fix.
5. **Rewriting the recursive CTEs as Python loops.** A plain `theme_id = :theme` returns **zero rows
   for every region theme** — CO-3 called this "the single easiest thing to get wrong here", and a
   language port is exactly when a query looks worth simplifying.
6. **The 3-second poll with no cap**, on a phone left awake overnight.
7. **The monthly expiry.** §8.
8. **Re-enabling WAL** because it's what you'd do anywhere else. §5, rule 5.

---

## Sources

- [PythonAnywhere forum — "Deploy node js server on pythonanywhere"](https://www.pythonanywhere.com/forums/topic/29151/) (staff: node runs, cannot be exposed)
- [Free Accounts Features | PythonAnywhere Help](https://help.pythonanywhere.com/pages/FreeAccountsFeatures/) (1 web app, 1 worker, 1 month expiry, 100 CPU-seconds, 512 MiB, MySQL only pre-2026-01-15)
- [PythonAnywhere pricing](https://www.pythonanywhere.com/pricing/) (Developer $10/mo: 3 workers, 5,000 CPU-seconds, custom domain, SSH)
- [Async work in Web apps | PythonAnywhere Help](https://help.pythonanywhere.com/pages/AsyncInWebApps/) (5-minute worker timeout)
- [PythonAnywhere forum — "Advising using SQLite"](https://www.pythonanywhere.com/forums/topic/1847/) (persistence, the 1 MiB threshold, networked-filesystem locking)
- [PythonAnywhere allowlist](https://www.pythonanywhere.com/whitelist/) (`github.com` allowlisted for free accounts)
