# Deploying LifePilot

Three pieces: the API on **Render**, the web app on **Vercel**, the database on
**Neon**. All three have real free tiers and none needs a credit card.

Budget roughly 30 minutes the first time, most of it waiting for builds.

---

## Why this combination

**Hugging Face Spaces is out.** Docker Spaces moved to paid, which was the
original plan in [PLAN.md](./PLAN.md) §7.

**Fly.io is out.** It removed its free tier and now requires a card up front.

**Render** gives 750 instance-hours a month — about one always-on service —
builds from a Dockerfile, and needs no card. The catch is honest and worth
knowing before you demo: **a free service spins down after 15 minutes of
inactivity, and the next request waits about a minute** while it wakes. The web
app shows a "waking the server" message rather than appearing broken, but the
first click after a quiet period is slow.

**Koyeb** is the closest alternative if Render's terms change; it scales to zero
after an hour rather than 15 minutes. The Dockerfile works there unchanged.

---

## 1. Database — Neon

1. Create a project at [console.neon.tech](https://console.neon.tech).
2. Copy the **pooled** connection string.

No migrations to run. Every table is created on first use, so the first request
after deploy sets up the schema itself.

---

## 2. API — Render

1. Push this repository to GitHub.
2. In Render, choose **New → Blueprint** and point it at the repo. It reads
   [`render.yaml`](../render.yaml) and creates the service.
3. Fill in the environment variables it marks as required. `render.yaml` lists
   which are secret and which are safe to keep in version control.

Three values depend on the deployed hostnames, so set them once the service
exists:

| Variable | Value |
|---|---|
| `PUBLIC_BASE_URL` | `https://lifepilot-api.onrender.com` |
| `WEB_BASE_URL` | your Vercel URL, e.g. `https://lifepilot.vercel.app` |
| `GOOGLE_OAUTH_REDIRECT_URI` | `https://lifepilot-api.onrender.com/connect/google/callback` |

`WEB_BASE_URL` does double duty: it is the origin CORS allows, and the base for
password-reset links. Getting it wrong shows up as the web app being unable to
reach the API at all.

Verify with:

```bash
curl https://lifepilot-api.onrender.com/health
# {"ok":true,"persistent":true,"app":"lifepilot"}
```

`persistent: true` confirms it reached Neon. If it says `false`, `DATABASE_URL`
did not arrive.

### Building the image locally first

Render builds from `apps/api/Dockerfile` with the **repo root** as context — the
lockfile and the shared workspace both live above that file. To check it before
pushing:

```bash
docker build -f apps/api/Dockerfile -t lifepilot-api .
docker run --rm -p 10000:10000 --env-file .env lifepilot-api
```

---

## 3. Web — Vercel

1. **New Project**, import the repo.
2. Set the **root directory** to `apps/web`. Vercel then detects Next.js.
3. Add one environment variable:

   ```
   NEXT_PUBLIC_API_URL = https://lifepilot-api.onrender.com
   ```

   It is read at build time and baked into the bundle, so changing it later
   needs a redeploy, not just a restart.

Preview deployments get a new hostname per push. The API allows any
`*.vercel.app` origin so previews work without reconfiguring CORS; set
`ALLOWED_ORIGINS` (comma-separated) if you deploy the web app elsewhere.

---

## 4. Scheduler — GitHub Actions

[`.github/workflows/tick.yml`](../.github/workflows/tick.yml) drains due
reminders twice an hour and wakes the API as a side effect.

Add two repository secrets under **Settings → Secrets and variables → Actions**:

| Secret | Value |
|---|---|
| `API_URL` | `https://lifepilot-api.onrender.com` |
| `TICK_SECRET` | the same value set on Render |

Until both exist the job skips with a notice rather than failing. It never fails
the run on an unreachable API either — an earlier version did, and it emailed a
failure notice every 15 minutes before the API was deployed.

---

## 5. Google Calendar (optional)

Only if you want approved plans to write real calendar events. Without it, plans
still produce a downloadable `.ics`, which needs no OAuth at all.

1. In [Google Cloud Console](https://console.cloud.google.com/apis/credentials),
   create an **OAuth client → Web application**.
2. Enable the **Google Calendar API**.
3. Add the redirect URI: `https://lifepilot-api.onrender.com/connect/google/callback`
4. Set `GOOGLE_OAUTH_CLIENT_ID` and `GOOGLE_OAUTH_CLIENT_SECRET` on Render.

**Request only `calendar.events` on the consent screen.** It is the single scope
this app asks for. Adding broader scopes — especially `auth/calendar`, which
grants permission to permanently delete every calendar the user can access —
makes Google's verification review harder and shows users a more alarming
consent screen, for no functional gain.

While the app is unverified, Google shows an "unverified app" warning and caps
the project at 100 users for its lifetime. That is why this is opt-in.

---

## 6. Password reset email (optional)

Set `RESEND_API_KEY` from [resend.com](https://resend.com/api-keys). Without it,
reset links are written to the server log instead of sent.

With the shared `onboarding@resend.dev` sender, Resend only delivers to the
address that owns the Resend account. To email anyone else, verify a domain at
[resend.com/domains](https://resend.com/domains) and point `EMAIL_FROM` at it.

---

## After deploying

Walk the flow yourself, in a private window so you hit the cold start a visitor
would:

1. Open the Vercel URL. Expect a slow first load; the wake notice should appear.
2. **Continue as guest** — proves the no-signup path works.
3. Ask something small: *"What is 250 USD in yen?"*
4. Ask for a plan, then ask to save it — the approval card should appear and the
   run should stop until you decide.
5. Approve it, and confirm you get a shareable plan link.
6. Trigger the tick workflow by hand (**Actions → tick → Run workflow**) and
   check the run log says what you expect.

If step 4 never pauses, the agent skipped the approval tool — check the Render
logs rather than the browser, since the gate is enforced server-side.
