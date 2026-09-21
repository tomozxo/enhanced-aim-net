# enhanced.aim.net — sensitivity calibration tool

A licensed, key-gated web app for finding your mouse sensitivity in
**Rainbow Six Siege** (hip-fire, 1× ADS and 2.5× ADS), **Valorant** or
**CS2 / CS:GO**, picked from the game selector at the top of the page. It has
fullscreen flick/target/tracking drills, a 3-candidate-x-3-round
calibration pass, an iterative "fine-tune further" step, per-user license
keys locked to the first browser/device that activates them (via a cookie,
not your network), and a user-adjustable accent color + light/dark mode.

Just want a real public link to send people, instead of running this on
your own machine? Skip to **[DEPLOY.md](DEPLOY.md)**.

## 1. Install Node.js

Nothing here needs Python or any native build tools, but it does need
Node.js (this machine didn't have it installed, so none of this has been
run outside the browser-only frontend test described below). Get the LTS
installer from nodejs.org, or on Windows:

```bash
winget install -e --id OpenJS.NodeJS.LTS
```

Then, from the `enhanced.aim.net` folder:

```bash
npm install
```

## 2. Configure secrets

```bash
cp .env.example .env
```

Edit `.env` and set real random values for `JWT_SECRET` and `ADMIN_TOKEN`
(e.g. `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`
run twice). `ADMIN_TOKEN` is the password for the key-management panel —
treat it like any other admin credential.

If you're deploying behind a reverse proxy (nginx, Cloudflare, a PaaS
router), set `TRUST_PROXY_HOPS` to how many proxy hops sit in front of the
app. The license lock itself no longer depends on this (it's cookie-based
now, see below), but it still matters for two things: per-IP rate limiting
on the activation endpoint, and correctly detecting HTTPS so the device
cookie gets the `Secure` flag. `render.yaml` sets this to `"true"` (trust
the whole chain) rather than a specific hop count, which is the safer
default when you don't know the exact proxy topology in front of you.

## 3. Run it

```bash
npm start
```

- App: http://localhost:3000/ (redirects to the license-activation screen)
- Admin panel: http://localhost:3000/admin.html

## 4. Get yourself into the admin panel

**This copy already has an admin key pre-seeded in `data/keys.json`** (sent
to you separately, not written in this file) — just type it into the
activation screen and you'll land in `/admin.html`. It's unused/unlocked to
any device until you activate it, exactly like any other key. If you ever
need another one, or you're starting from a clean `data/` folder, there are
two ways in:

**Your own admin key** — mint one from the command line:

```bash
node server/cli.js admin "your name"
```

That prints an `R6S-...` key. Enter it in the **same key box everyone else
uses** on the main site (http://localhost:3000/) — the activation screen
recognizes it's an admin key and sends you straight to `/admin.html`
instead of the sensitivity tool. It's a real license key under the hood
(same device-lock, same session), just flagged as admin, so once you're in you
can mint more admin keys for trusted staff straight from the panel (there's
an "Admin key" checkbox next to Generate).

**Raw ADMIN_TOKEN (fallback)** — go straight to `/admin.html` and paste the
`ADMIN_TOKEN` from `.env` into the gate instead of a key. Useful for
scripts/CI, or as a break-glass path if you ever lock yourself out of every
admin key.

## 5. Generate license keys for everyone else

From the admin panel (fill in a note, optional expiry, leave "Admin key"
unchecked, click Generate), or from the command line:

```bash
node server/cli.js new "buyer note" 30   # 30-day expiry, omit for no expiry
node server/cli.js list
node server/cli.js unlock R6S-XXXX-XXXX-XXXX-XXXX   # after a buyer clears cookies/switches browsers
node server/cli.js revoke R6S-XXXX-XXXX-XXXX-XXXX
```

Keys look like `R6S-AB12-C3D4-E5F6-G7H8`. Hand one to each user — it
locks itself to their browser the first time they activate it.

## Troubleshooting: "Start calibration" does nothing

If you update the code on a server that's already running, **restart
`npm start`** — Express won't pick up file changes on its own. If the app
was already open in a browser tab, do a **hard refresh** (Ctrl+Shift+R)
before retesting; static files are served with `Cache-Control: no-cache`
now specifically so this class of "I fixed it but it still does the old
thing" doesn't happen again, but an already-loaded tab can still be running
whatever JS it loaded before the fix. If it still doesn't work after both of
those, open DevTools (F12) → Console and check for a red error the moment
you click the button — the drill engine now surfaces a popup with the error
message instead of failing silently, and logs the full error to the console
either way.

## Troubleshooting: "Failed to fetch" / the whole site goes unreachable

If a request fails with a raw **"Failed to fetch"** (not a proper error
message in red text) and reloading the page afterward gives
**`ERR_CONNECTION_REFUSED`**, that means the Node process itself crashed —
not just that one request. **Check the terminal window where you ran
`npm start`**: if it printed a stack trace and stopped, that's your answer,
and that stack trace is exactly what I'd need to fix it. Run `npm start`
again to bring it back up in the meantime.

As of this version, every route is wrapped so a thrown error turns into a
normal JSON error response instead of taking the process down, and there
are also process-level `uncaughtException`/`unhandledRejection` handlers as
a last resort that log and keep the server running rather than exit. If you
still manage to crash it, whatever gets printed to that terminal is the
thing to send me.

## How the license lock works

- On first activation, the server sets a long-lived, random cookie
  (`r6sf_device`, `server/cookies.js`) identifying "this browser" and
  records it on the key. Every later activation/verify check compares the
  incoming cookie against that stored value instead of an IP address.
  There's no separate password — the key itself is the credential.
- This replaced an earlier IP-based lock. IP-locking broke in two ordinary
  situations: a buyer's ISP/mobile network reassigning their IP (locks them
  out of a key that's genuinely still theirs), and - what actually forced
  the change - Render's proxy not reporting a fully consistent IP for the
  same visitor across requests, which intermittently locked people out of
  their *own* freshly-activated key. A cookie doesn't have either problem:
  it survives network changes entirely, since it isn't derived from the
  network at all.
- The cookie is `HttpOnly` (page JS can't read or tamper with it) and
  `SameSite=Lax`, set for 10 years. What it does *not* survive: clearing
  cookies, private/incognito windows (each one starts with an empty cookie
  jar, so it looks like a new device every time), or switching to a
  different browser on the same PC - each of those needs an admin "Unlock
  device" the same way a changed IP used to.
- Two people behind the same WiFi network are no longer a problem the way
  they were under IP-locking (different browsers, different cookies) -
  device-locking is arguably *stricter* against casual sharing than IP ever
  was, since copying a specific cookie value between machines is a lot less
  convenient than "we're on the same WiFi."
- Sessions are JWTs valid for 12 hours, re-checked against the key store
  (revoked/expired/device) on every reload and every 5 minutes. Revoking a
  key in the admin panel kicks the user out within that window, not
  instantly.
- This is a client-side gate on top of a server-side check — solid against
  casual key sharing, not proof against someone determined to read the
  page's JS. There's no way to make a pure website fully tamper-proof;
  that's inherent to running in someone else's browser, not a bug here.

## Games

Each game keeps its own settings, results and fine-tune history; mouse DPI,
the accent colour and the sens converter are shared. Everything
game-specific lives in [`public/js/games.js`](public/js/games.js).

**Valorant and CS2 are exact.** Both games turn the camera a fixed number
of degrees per mouse count, times your sens:

| Game | Degrees per count at sens 1 | Field of view |
| --- | --- | --- |
| Valorant | 0.07 | Locked: 70.53° vertical, which is 103° wide on 16:9 and 86.6° on 4:3 |
| CS2 / CS:GO | 0.022 (default `m_yaw` / `m_pitch`) | Fixed: 90° wide on 4:3 (73.74° vertical), 106.26° on 16:9 |

The drill uses the same numbers, so the same mouse movement turns you
exactly as far as it does in-game. For example, Valorant 0.4 at 800 DPI is
40.82 cm per 360°, and CS2 1.0 at 800 DPI is 51.95 cm.

Both games also let you pick your in-game **resolution** (native 16:9 ones
plus the usual stretched-res picks like 1280×960, 1440×1080, 1024×768 and
1280×1024) and whether a non-native one is **stretched** or shown with
**black bars**. The drill renders at that resolution and scales it to the
screen the same way, so 4:3 stretched looks as wide and as soft as it does
in-game. The drill fills the whole screen for this; the top bar and hints
float over it.

**Raw input.** "Exact" relies on the browser giving raw mouse counts
(`unadjustedMovement`), which Chrome and Edge do: no Windows pointer speed
or "Enhance pointer precision" applied, the same as the games. Firefox and
Safari don't support it, so the drill footer warns you when you're on one
of them. If the browser refuses to capture the mouse for any other reason,
such as Chrome's short cooldown after pressing Esc, the drill stays paused
until you click back in. It no longer quietly falls back to accelerated
input for the rest of the session.

Siege is still the estimated model described below.

## About the sensitivity numbers (Rainbow Six Siege)

Siege doesn't publish a cm/360° formula, so every optic's "Estimated
cm/360°" and the drills' actual crosshair rotation speed come from an
approximate model in [`public/js/sensMath.js`](public/js/sensMath.js), each
tab tuned with its own constant so the numbers move the right direction and
land in a plausible range — not reverse-engineered from the game's code.
Real-world feedback (people whose in-game feel didn't match the drill at
identical settings) is expected here; there's no way to get this exactly
right without access to Ubisoft's actual formula.

The fix is the "Calibrate to your real sens" section in the sidebar. In
R6, line your crosshair up with a mark, drag across the pad until you've
turned exactly one full 360° back onto it, and measure that distance with a
ruler — that's your real cm/360. Enter it for Hip-fire, 1× ADS and/or
2.5× ADS and that optic becomes exact.

Importantly, the measurement is stored *with the sens/DPI it was taken at*
and converted into a yaw constant, rather than being used as a fixed
output. That matters for two reasons: changing your sens or DPI afterwards
rescales correctly instead of still reporting the old measured number, and
the candidate sensitivities a calibration run tests (e.g. 42 / 50 / 58)
actually differ from each other. An earlier build stored the measurement as
a frozen value, which silently made all three candidates feel identical and
the resulting recommendation meaningless.

The stat tile above the drills reads "Measured cm/360°" instead of
"Estimated cm/360°" once an optic is calibrated, so it's obvious which
numbers are real and which are still guesses. ADS·1× specifically has *no*
raw settings-menu number in real Siege at all (1× sights apply an internal
speed-up Ubisoft doesn't expose), so measuring is the only way to get that
one exactly right.

The drills themselves use the browser's Pointer Lock API (`movementX/Y`),
which reports OS-processed pixel deltas, not raw HID mouse counts — this is
the same approximation every browser-based aim trainer uses, since raw
mouse counts simply aren't available to web pages. It's fine for comparing
candidates *against each other* in one sitting; treat the absolute cm/360°
number as a ballpark, not a lab measurement.

## Calibration structure

One "Start calibration" run tests 3 candidate sensitivities (current value,
and roughly ±15% either side, e.g. 50 → 42 / 50 / 58) across 3 drills
(flicking, target-clearing, tracking), each repeated 3 rounds for
consistency — 27 scored 7-second blocks plus a warm-up, about 4 minutes.
Losing window focus (alt-tab, clicking outside) auto-pauses a run and
keeps progress; "Resume round" re-captures the mouse.

**Scoring.** Each target has one ring splitting it into an inner circle and
an outer band. A hit anywhere on the target counts, inside or outside the
ring:

- Flick: hits per second.
- Targets: dots cleared per second. There are always 5 up - popping one
  brings a replacement in straight away, somewhere free in the same area.
- Tracking: share of the round the crosshair was on the dot.

The share of hits that landed inside the ring is shown as "Inner hits" for
reference only; it doesn't change the score. Each drill is a third of a
candidate's score, relative to the best candidate in that drill. The winner gets a confidence label based on how
far ahead of the runner-up it finished: *Clear winner* (8+ points), *Close
call* (3-7) or *Too close to call* (under 3). Those thresholds are rules of
thumb, not a statistical test.

**Fine-tune further** (on the results screen and the recommendation card)
runs another pass centred on the last winner with half the spread:
±8 → ±4 → ±2 → ±1 for a sens of 50. Once it's down to ±1, the finest step
Siege's slider has, further passes re-test the same three values and pool
the rounds with the previous ones (up to 4 passes' worth), so the answer
keeps getting more reliable rather than just being re-rolled.

## Project layout

```
server/         Express app: license activation/verify, admin key API, key storage
  cookies.js      Device-cookie helper (the license lock's identity source)
  store.js        License keys: format, activation, device lock
  store-pg.js     ...stored in Postgres/Supabase when DATABASE_URL is set
  store-file.js   ...or in data/keys.json when it isn't
public/         Static frontend (no build step)
  index.html    License activation screen
  app.html      The sensitivity tool itself (gated by a valid session)
  admin.html    Key management panel (gated by ADMIN_TOKEN)
  js/
    session.js      Verifies/refreshes the license session on app.html
    state.js         App settings + calibration results, persisted to localStorage
    games.js          Per-game sens formulas, FOV, resolutions (R6 / Valorant / CS2)
    sensMath.js       The approximate R6 sensitivity/cm-360 model
    sensConvert.js    Game-to-game sens converter (yaw constants per game)
    theme.js          Accent color picker + light/dark mode
    drills.js         Three.js first-person drill engine: pointer lock, fullscreen, pause/resume
    calibration.js    Candidate/queue building and scoring
    app.js            Wires it all together
data/keys.json  License key store when DATABASE_URL is unset (created on first run; not committed)
```

## Known limitations / things to revisit before real money changes hands

- No payment integration — this only issues/validates keys, it doesn't sell
  them. Wire key creation into whatever you use to sell (Stripe webhook,
  Discord bot, manual) by calling `POST /api/admin/keys`.
- Without `DATABASE_URL`, keys live in `data/keys.json`, which is fine
  locally but wiped on every deploy on Render's free tier. Set
  `DATABASE_URL` (see DEPLOY.md, step 3b) for anything real.
- No HTTPS/TLS is configured here — put this behind a reverse proxy (nginx,
  Caddy, Cloudflare) that terminates TLS before exposing it publicly.
  Device cookies and admin tokens sent over plain HTTP are not meaningfully
  secure (the cookie also only gets its `Secure` flag when the app can see
  the connection is HTTPS - see `TRUST_PROXY_HOPS` above).
