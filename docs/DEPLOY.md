# Deploying LifePilot

Everything runs on Render, with Postgres on Neon and the scheduler on GitHub
Actions. All free, no credit card.

Budget about 30 minutes the first time, most of it waiting for builds.

> The API sleeps after 15 minutes of inactivity and takes about a minute to
> wake. The UI is a static site, so it never sleeps — the page loads instantly
> and shows a waking notice while the API comes back.

---

## 1. Database

1. Create a project at [console.neon.tech](https://console.neon.tech).
2. Copy the **pooled** connection string.

No migrations. Tables are created on first use.

---

## 2. API

1. Push this repository to GitHub.
2. In Render, choose **New → Blueprint** and point it at the repo. It reads
   [`render.yaml`](../render.yaml) and creates both services.
3. Fill in the environment variables it marks as required.

Three depend on the deployed hostnames, so set them once the service exists:

| Variable | Value |
|---|---|
| `PUBLIC_BASE_URL` | `https://lifepilot-api.onrender.com` |
| `WEB_BASE_URL` | the static site URL, e.g. `https://lifepilot-web.onrender.com` |
| `GOOGLE_OAUTH_REDIRECT_URI` | `https://lifepilot-api.onrender.com/connect/google/callback` |

`WEB_BASE_URL` is both the origin CORS allows and the base for password-reset
links. Getting it wrong shows up as the web app being unable to reach the API.

Check it:

```bash
curl https://lifepilot-api.onrender.com/health
# {"ok":true,"persistent":true,"app":"lifepilot"}
```

`persistent: true` means it reached the database. If it is `false`,
`DATABASE_URL` did not arrive.

### Building the image locally first

Render builds from `apps/api/Dockerfile` with the **repo root** as context — the
lockfile and the shared workspace both live above that file.

```bash
docker build -f apps/api/Dockerfile -t lifepilot-api .
docker run --rm -p 10000:10000 --env-file .env lifepilot-api
```

---

## 3. Web

The blueprint creates this alongside the API as a **static site**, which is free,
CDN-served and never sleeps. Set one environment variable on it:

```
NEXT_PUBLIC_API_URL = https://lifepilot-api.onrender.com
```

It is baked into the bundle at build time, so changing it later needs a redeploy
rather than a restart.

Then set `WEB_BASE_URL` on the API to the static site's URL. That is the origin
CORS allows and the base for password-reset links.

### Using Vercel instead

The app is a plain static export, so it deploys anywhere. On Vercel: import the
repo, set the root directory to `apps/web`, and add the same
`NEXT_PUBLIC_API_URL`. The API already allows any `*.vercel.app` origin so
preview builds work; use `ALLOWED_ORIGINS` (comma-separated) for anywhere else.

---

## 4. Scheduler

[`.github/workflows/tick.yml`](../.github/workflows/tick.yml) drains due
reminders twice an hour and wakes the API as a side effect.

Add two repository secrets under **Settings → Secrets and variables → Actions**:

| Secret | Value |
|---|---|
| `API_URL` | `https://lifepilot-api.onrender.com` |
| `TICK_SECRET` | the same value set on Render |

Until both exist the job skips with a notice. It never fails the run on an
unreachable API, so it will not email you while the API is still going up.

---

## 5. Google Calendar (optional)

Only needed if you want approved plans to write real calendar events. Without
it, plans still produce a downloadable `.ics`.

1. In [Google Cloud Console](https://console.cloud.google.com/apis/credentials),
   create an **OAuth client → Web application**.
2. Enable the **Google Calendar API**.
3. Add the redirect URI: `https://lifepilot-api.onrender.com/connect/google/callback`
4. Set `GOOGLE_OAUTH_CLIENT_ID` and `GOOGLE_OAUTH_CLIENT_SECRET` on Render.

Request only `calendar.events` on the consent screen — it is the single scope
this app asks for. Broader scopes make Google's verification review harder and
show users a more alarming consent screen for no functional gain.

While the app is unverified, Google shows an "unverified app" warning and caps
the project at 100 users for its lifetime.

---

## 6. Password reset email (optional)

Set `RESEND_API_KEY` from [resend.com](https://resend.com/api-keys). Without it,
reset links go to the server log instead of an inbox.

With the shared `onboarding@resend.dev` sender, Resend only delivers to the
address that owns the Resend account. To email anyone else, verify a domain at
[resend.com/domains](https://resend.com/domains) and point `EMAIL_FROM` at it.

---

## After deploying

Walk the flow in a private window, so you hit the cold start a visitor would:

1. Open the site. It loads immediately; the first request shows a waking notice.
2. **Continue as guest.**
3. Ask something small: *"What is 250 USD in yen?"*
4. Ask for a plan, then ask to save it. The approval card should appear and the
   run should stop until you decide.
5. Approve it and confirm you get a shareable plan link.
6. Run the tick workflow by hand (**Actions → tick → Run workflow**).

If step 4 never pauses, the agent skipped the approval tool. Check the Render
logs rather than the browser — the gate is enforced server-side.
