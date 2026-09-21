# Getting a public link (Render, free tier)

This gets you a real `https://something.onrender.com` link you can send to
people. Render's free tier needs no credit card. The tradeoff you're
accepting: this app stores keys in a plain file, and Render's free tier
disk is **not persistent** - every redeploy (and sometimes a restart after
inactivity) wipes it, meaning **every key you've generated gets deleted**
and you're back to zero. The server handles this gracefully (see below) but
it's worth knowing before you sell/hand out keys.

## 1. Push this code to GitHub

You need your own GitHub account (free) and a new repository.

```bash
cd enhanced.aim.net
git init
git add .
git commit -m "Initial commit"
```

Then on github.com: New repository → give it a name → **don't** initialize
it with a README (you already have one) → create. It'll show you commands
like these - run them:

```bash
git remote add origin https://github.com/YOUR_USERNAME/YOUR_REPO.git
git branch -M main
git push -u origin main
```

## 2. Deploy on Render

1. Go to [render.com](https://render.com) → sign up (GitHub login is
   easiest) → **New** → **Blueprint**.
2. Pick the GitHub repo you just pushed. Render reads `render.yaml` (already
   in this project) and pre-fills everything - including generating random
   `JWT_SECRET` and `ADMIN_TOKEN` values for you automatically.
3. Click **Apply** / **Deploy**. First build takes a couple of minutes.
4. Once it's live, Render shows you the URL - something like
   `https://enhanced-aim-net.onrender.com`. That's your link.

## 3. Get your admin key

Since the free tier starts with an empty `data/keys.json`, the server
auto-creates one admin key the moment it first boots and prints it to the
logs. In the Render dashboard: your service → **Logs** tab → look for a
block like:

```
============================================================
No keys found - created a bootstrap ADMIN key:
  R6S-XXXX-XXXX-XXXX-XXXX
Enter it on the site's activation screen to reach /admin.html.
============================================================
```

Copy that key, go to your new URL, enter it on the activation screen - it
drops you straight into `/admin.html`, same as locally. From there you can
generate real keys to hand out.

**Without a database this happens again and again.** Keys live in a file
on Render's disk, and the free tier's disk is wiped on every redeploy and
whenever Render spins the service down after 15 minutes of inactivity. Each
time, every key stops working and a **new** bootstrap key appears in the
logs. Step 3b fixes that for free.

## 3b. Keep keys between deploys (Supabase, free)

With `DATABASE_URL` set, keys are stored in a Postgres database instead of
on Render's disk, so deploys, restarts and sleeping don't touch them. The
table is created automatically on first start.

1. Sign up at [supabase.com](https://supabase.com) and create a **New
   project**. Pick any name. Let it generate a **database password** and
   save that somewhere safe - a password of just letters and numbers avoids
   having to escape special characters later. Choose the region closest to
   your Render service's region.
2. When the project is ready, click **Connect** at the top of the project
   dashboard and copy the **Session pooler** connection string. It looks
   like
   `postgresql://postgres.abcdefgh:[YOUR-PASSWORD]@aws-0-eu-west-2.pooler.supabase.com:5432/postgres`.
   Replace `[YOUR-PASSWORD]` (brackets included) with your database password.
   Use the session pooler rather than the "direct connection": the direct
   one is IPv6-only on Supabase's free plan, which Render can't reach.
3. In Render: your service → **Environment** → **Add Environment Variable**.
   Key `DATABASE_URL`, value the connection string from step 2. Save - Render
   redeploys by itself.
4. In **Logs**, look for `Key storage: Postgres (DATABASE_URL)`, then one
   last bootstrap admin key (the new database starts empty). That admin key,
   and every key you generate from now on, survives future deploys.

In Supabase's **Table Editor** you'll see a `license_keys` table - handy
for looking at keys directly. Row Level Security is switched on for it, so
Supabase's public API can't read it; only this server can.

Free Supabase projects pause after about a week with no activity. If that
ever happens, logins fail until you click **Restore** in the Supabase
dashboard. Nothing is deleted.

## 4. Optional: your own domain instead of onrender.com

If you own a domain (e.g. aim.net) and want `enhanced.aim.net` instead of the
`onrender.com` link: Render dashboard → your service → **Settings** →
**Custom Domain** → add `enhanced.aim.net` → it gives you a CNAME record to add
at your domain's DNS provider. Once that propagates (usually minutes to a
couple hours), the real domain works with HTTPS automatically, no other
changes needed - nothing in the app hardcodes a domain.
