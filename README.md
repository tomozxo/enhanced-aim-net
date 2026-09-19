# enhanced.aim.net — R6 sensitivity calibration tool

A licensed, key-gated web app for finding a Rainbow Six Siege mouse
sensitivity: hip-fire, 1× ADS and 2.5× ADS, with fullscreen flick/target/tracking
drills, a 3-candidate-x-3-round calibration pass, an iterative "recalibrate"
fine-tune step, per-user license keys locked to the first IP that activates
them, and a user-adjustable accent color + light/dark mode.

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
app so `req.ip` resolves to the real visitor IP instead of the proxy's IP.
Get this wrong and the IP-lock either locks to the proxy's IP (breaks
everyone) or trusts a spoofable header (defeats the lock) — leave it at `0`
for direct connections.

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
any IP until you activate it, exactly like any other key. If you ever need
another one, or you're starting from a clean `data/` folder, there are two
ways in:

**Your own admin key** — mint one from the command line:

```bash
node server/cli.js admin "your name"
```

That prints an `R6S-...` key. Enter it in the **same key box everyone else
uses** on the main site (http://localhost:3000/) — the activation screen
recognizes it's an admin key and sends you straight to `/admin.html`
instead of the sensitivity tool. It's a real license key under the hood
(same IP-lock, same session), just flagged as admin, so once you're in you
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
node server/cli.js unlock R6S-XXXX-XXXX-XXXX-XXXX   # after a buyer's IP changes
node server/cli.js revoke R6S-XXXX-XXXX-XXXX-XXXX
```

Keys look like `R6S-AB12-C3D4-E5F6-G7H8`. Hand one to each user — it
IP-locks itself the first time they activate it.

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

- A key activates on whichever IP address uses it **first**, and is locked
  to that IP from then on. There's no separate password — the key itself is
  the credential.
- This is a **network-IP lock, not a device/hardware lock**. A browser
  cannot read a real hardware ID (motherboard/disk serial etc.) — that's
  blocked by every browser for privacy reasons, full stop. Locking to a
  browser fingerprint instead was the other option on the table; IP-only is
  what's implemented here per your call.
- Practically: dynamic home IPs, mobile networks, and VPNs can all change a
  user's IP, which will lock them out until you unlock the key from the
  admin panel. Two people behind the same NAT/office IP will conflict too.
  This trades convenience for simplicity — there's no support burden from a
  fingerprinting false-negative, but you should expect "it stopped working"
  tickets whenever someone's ISP reassigns their IP. Unlock via the admin
  panel's "Unlock IP" button or `node server/cli.js` (add a CLI unlock
  command if you want one; today unlocking is admin-panel or a direct edit
  of `data/keys.json`).
- Sessions are JWTs valid for 12 hours, re-checked against the key store
  (revoked/expired/IP) on every reload and every 5 minutes. Revoking a key
  in the admin panel kicks the user out within that window, not instantly.
- This is a client-side gate on top of a server-side check — solid against
  casual key sharing, not proof against someone determined to read the
  page's JS. There's no way to make a pure website fully tamper-proof;
  that's inherent to running in someone else's browser, not a bug here.

## About the sensitivity numbers

Siege doesn't publish a cm/360° formula, and 1× (reflex/red-dot) sights
apply a speed-up internally that isn't exposed as a settings-menu number at
all — that's why the sidebar shows "Estimated" for ADS·1×. The "Estimated
cm/360°" stat and the drills' crosshair speed all come from an approximate
model in [`public/js/sensMath.js`](public/js/sensMath.js), tuned so the
numbers move the right direction and land in a plausible range — not
reverse-engineered from the game's code. Use "Match mouse movement" in the
sidebar to enter a cm/360° you've actually measured in-game for 1× ADS, and
the app uses that instead of the estimate.

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
"Recalibrate" on the recommendation card re-runs the same structure centered
on the previous best result with a narrower spread, so repeated
recalibration passes converge on a value rather than re-testing the same
range. Losing window focus (alt-tab, clicking outside) auto-pauses a run
and keeps progress; "Resume round" re-captures the mouse.

## Project layout

```
server/         Express app: license activation/verify, admin key API, JSON file store
public/         Static frontend (no build step)
  index.html    License activation screen
  app.html      The sensitivity tool itself (gated by a valid session)
  admin.html    Key management panel (gated by ADMIN_TOKEN)
  js/
    session.js      Verifies/refreshes the license session on app.html
    state.js         App settings + calibration results, persisted to localStorage
    sensMath.js       The approximate sensitivity/cm-360 model
    theme.js          Accent color picker + light/dark mode
    drills.js         Canvas drill engine: pointer lock, fullscreen, pause/resume
    calibration.js    Candidate/queue building and scoring
    app.js            Wires it all together
data/keys.json  License key store (created on first run; not committed)
```

## Known limitations / things to revisit before real money changes hands

- No payment integration — this only issues/validates keys, it doesn't sell
  them. Wire key creation into whatever you use to sell (Stripe webhook,
  Discord bot, manual) by calling `POST /api/admin/keys`.
- The JSON file store is fine for tens to low thousands of keys on a single
  server; it is not a database. Swap `server/store.js` for a real DB if you
  outgrow it.
- No HTTPS/TLS is configured here — put this behind a reverse proxy (nginx,
  Caddy, Cloudflare) that terminates TLS before exposing it publicly. IP
  locking and admin tokens over plain HTTP are not meaningfully secure.
