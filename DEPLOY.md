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

**This only happens once per fresh dataset.** If the free-tier disk gets
wiped (redeploy, or Render spinning the service down after 15 minutes of
inactivity and back up), the server treats it as a fresh boot and prints a
**new** bootstrap key in the logs again - so check there if your old key
stops working and nothing else looks wrong. Any keys you'd handed out
before that point stop working too; there's no way around that on a
non-persistent disk. If that becomes a real problem, the fix later is
upgrading to Render's persistent disk add-on (a few dollars/month), not a
code change.

## 4. Optional: your own domain instead of onrender.com

If you own a domain (e.g. aim.net) and want `enhanced.aim.net` instead of the
`onrender.com` link: Render dashboard → your service → **Settings** →
**Custom Domain** → add `enhanced.aim.net` → it gives you a CNAME record to add
at your domain's DNS provider. Once that propagates (usually minutes to a
couple hours), the real domain works with HTTPS automatically, no other
changes needed - nothing in the app hardcodes a domain.
