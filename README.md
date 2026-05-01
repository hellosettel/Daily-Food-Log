# Daily Log

A two-user food and weight tracker. PWA — works on iPhone or Android home screen, offline-capable, syncs across devices.

**Stack:** vanilla HTML/CSS/JS · Supabase (Postgres + auth) · IndexedDB (local-first) · Netlify (hosting)

**Philosophy:** Awareness, not restriction. Sugar shows as a running daily total — no target, no shame, just the number.

---

## Setup (one time, ~20 minutes)

### 1. Create a Supabase project

1. Go to <https://supabase.com/dashboard> and click **New Project**
2. Name it whatever you want (e.g. `daily-food-log`) — this is **separate** from any other Supabase projects you have
3. Pick a strong database password and a region close to you
4. Wait ~2 minutes for it to provision

### 2. Run the schema

1. In the new project, open **SQL Editor** in the left sidebar
2. Click **New query**
3. Open `supabase/schema.sql` from this repo, copy the entire contents, paste into the editor
4. Click **Run**

You should see "Success. No rows returned." That's correct — the script just creates tables and policies.

### 3. Configure auth

1. Go to **Authentication → Providers → Email**
2. Make sure **Email** is enabled
3. Turn **Confirm email** OFF (magic links handle verification — leaving this on causes a double-confirmation loop)
4. Go to **Authentication → URL Configuration**
5. Set **Site URL** to your final app URL (e.g. `https://daily-log.netlify.app`)
6. Add the same URL under **Redirect URLs**

### 4. Get your API credentials

1. Go to **Settings → API**
2. Copy the **Project URL** and the **anon / public** key
3. Open `js/config.js` in this repo
4. Paste them into the placeholders:

```js
SUPABASE_URL: 'https://your-project-id.supabase.co',
SUPABASE_ANON_KEY: 'eyJhb...long-key...'
```

These are safe to commit — the anon key only works through Row Level Security, which we configured in the schema. It cannot bypass the user-isolation policies.

### 5. Deploy to Netlify

1. Push this folder to a new GitHub repo
2. In Netlify, **Add new site → Import from Git → pick the repo**
3. Build settings: leave **Build command** empty, set **Publish directory** to `.` (the repo root)
4. Click **Deploy**
5. Once live, copy the URL Netlify gives you (e.g. `daily-log.netlify.app`)
6. Go back to Supabase → Authentication → URL Configuration and make sure that URL is set as **Site URL** and **Redirect URL**

### 6. Install on your phone

**iOS:**
1. Open the Netlify URL in Safari
2. Tap the share button → **Add to Home Screen**
3. Open from the home screen → sign in with your email
4. Tap the magic link in your email — it opens the app, signed in

**Android:**
1. Open the Netlify URL in Chrome
2. Tap the menu → **Add to Home screen** (or Chrome may prompt automatically)
3. Same sign-in flow as above

### 7. Add your wife

She does the same install steps with her own email. Both of you share the food library; everything else (meals, weight, notes, targets) is private to each account.

---

## Daily use

- **Today:** log meals as you eat them. Quick-add picks from your most-logged foods first.
- **Month:** glance at the calendar — green = hit protein, amber = logged but missed, gray = no log.
- **Weight:** log 2–3x a week. Trend line plots after the second entry.
- **More:** edit targets, manage food library, export your data, sign out.

Sugar shows as a counter on the Today view, not a bar. The point is awareness, not restriction. After a couple weeks of data you'll know your real baseline; whether you set a soft cap then is up to you.

---

## Updating the app

Changes flow through Git → Netlify in about a minute:

1. Edit a file locally
2. Commit and push to GitHub
3. Netlify auto-deploys
4. Open the app on your phone — fresh version loads

If a change doesn't appear after refreshing, swipe the app out of recents and reopen. The service worker caches aggressively for offline support; closing fully forces a refresh. To make this happen automatically on bigger releases, bump `CACHE_VERSION` in `service-worker.js` (e.g. `v1.0.0` → `v1.0.1`).

### Adding a food everyone gets by default

Add to `js/seed.js` — but seeds only run on a brand-new (empty) `foods` table. For an already-running app, just add the food in-app via Settings → Manage foods. Both you and your wife will see it.

### Tweaking the protein hit threshold

Edit `PROTEIN_HIT_THRESHOLD` in `js/config.js`. This controls when a calendar day turns green.

---

## File map

```
.
├── index.html              app shell
├── manifest.json           PWA manifest
├── service-worker.js       offline cache
├── css/styles.css          all styling
├── icons/                  app icons (PNG)
├── js/
│   ├── config.js           ← edit this with Supabase credentials
│   ├── db.js               IndexedDB wrapper
│   ├── seed.js             default food library
│   ├── sync.js             Supabase sync layer
│   ├── ui.js               render + event handlers
│   └── app.js              entry point
└── supabase/
    └── schema.sql          ← paste into Supabase SQL Editor on setup
```

---

## Troubleshooting

**Magic link goes to a blank page or shows "Invalid login link":**
Site URL and Redirect URL in Supabase auth settings must exactly match the URL you opened the app from. Check trailing slashes.

**Sign-in works but data doesn't sync:**
Open browser console on desktop. Most likely: schema wasn't run, or RLS policies missing. Re-run `supabase/schema.sql`.

**App stuck on loading:**
Service worker bug, usually fixed by force-quitting and reopening. If persistent, in browser DevTools → Application → Service Workers → Unregister, then reload.

**Lost my data:**
Settings → Export all my data. Do this periodically. Local data lives in IndexedDB; cloud data in Supabase. Either side can rebuild the other.

---

## License

Personal use. Built for one household.
