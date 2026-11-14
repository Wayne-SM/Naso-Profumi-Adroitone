# Deployment walkthrough

The app is a single Node process. It needs about **700 MB of disk** (the
mirrored pages and image originals) and **~210 MB of RAM** at peak, so a
512 MB instance is comfortable.

Nothing needs a database — the cart lives in a signed cookie.

---

## Before you start

You need:

- **Docker** (for Fly.io, Render, or your own server), or Node 22+ if you
  want to run it directly
- A **Fly.io** account — <https://fly.io/app/sign-up> — and the CLI
- The repo cloned locally:

```bash
git clone https://github.com/Wayne-SM/Naso-Profumi-Adroitone.git
cd Naso-Profumi-Adroitone
```

> The repository is ~650 MB, so the clone takes a while. If it drops the
> connection, retry with a larger buffer:
>
> ```bash
> git -c http.postBuffer=524288000 clone --depth 1 \
>   https://github.com/Wayne-SM/Naso-Profumi-Adroitone.git
> ```

---

## Option A — Fly.io (recommended)

### 1. Install the CLI and sign in

```bash
curl -L https://fly.io/install.sh | sh
fly auth login
```

### 2. Create the app

`fly.toml` is already in the repo, so tell Fly to use it rather than
generating a new one:

```bash
fly apps create naso-profumi-clone
```

### 3. Set the cart secret

The cart is signed with this key. Without it every instance uses a
development fallback, so carts would not be shared between them.

```bash
fly secrets set CART_SECRET=$(openssl rand -hex 32)
```

### 4. Deploy

```bash
fly deploy
```

The first build uploads the image (~700 MB), so give it several minutes.
Fly builds on its own machines — you do **not** need Docker installed locally.

### 5. Check it

```bash
fly status
curl https://naso-profumi-clone.fly.dev/healthz
```

You should get:

```json
{"status":"ok","pages":201,"products":109,"collections":38,...}
```

Then open <https://naso-profumi-clone.fly.dev>.

### 6. Optional — a nicer domain

```bash
fly certs add yourdomain.com
fly alias set yourdomain.com naso-profumi-clone
```

### Useful commands

```bash
fly logs                    # tail the logs
fly ssh console             # a shell on the machine
fly machine restart         # restart it
fly scale count 0           # scale to zero (stops billing, site goes down)
```

### If the deploy fails

| Symptom | Fix |
| --- | --- |
| `no such app` | You skipped step 2, or used a different app name. `fly apps list` to check. |
| Image too large | The build is uploading ~700 MB. Retry — Fly caches layers between builds. |
| Out of memory | Raise `memory` in `fly.toml` from `512mb` to `1gb` and `fly deploy`. |
| Site loads but images 404 | Check `fly logs` for resize errors. The app falls back to the temp directory automatically. |

---

## Option B — Render

1. Push the repo to GitHub (done) and go to
   <https://dashboard.render.com>
2. **New → Web Service** → connect the repository
3. Render detects the `Dockerfile` automatically
4. Set the environment variables:

   | Key | Value |
   | --- | --- |
   | `NODE_ENV` | `production` |
   | `CART_SECRET` | a long random string |
   | `NODE_OPTIONS` | `--max-old-space-size=192` |

5. Choose the **Starter** plan (512 MB is enough) and deploy

`render.yaml` in the repo is a blueprint, so you can also use
**New → Blueprint** and point it at the repo — Render fills in the rest.

### Useful commands

Render has no CLI to drive this, but the dashboard shows logs and lets you
restart the service. `curl https://<your-service>.onrender.com/healthz`
to check it.

---

## Option C — Docker on any server

```bash
docker build -t naso-clone .
docker run -d --name naso-clone \
  -p 3000:3000 \
  -e CART_SECRET=$(openssl rand -hex 32) \
  --restart unless-stopped \
  naso-clone
```

Behind nginx or Caddy, terminate TLS and proxy to `127.0.0.1:3000`.

To use a specific domain, point an `A` record at the host and proxy the
`Host` header through.

---

## Option D — Vercel

Works, but **needs a Pro account**:

- The mirrored files total ~850 MB and Vercel caps static uploads at
  100 MB on Hobby, 1 GB on Pro
- The function bundle exceeds the standard 250 MB limit, so it needs the
  large-functions beta (automatic for projects created after June 2026,
  otherwise set `VERCEL_SUPPORT_LARGE_FUNCTIONS=1`)

```bash
npm i -g vercel
vercel link
vercel env add CART_SECRET production      # paste a random string
vercel env add VERCEL_SUPPORT_LARGE_FUNCTIONS production
vercel --prod
```

---

## Verifying a deployment

The same checks the CI runs, against your live URL:

```bash
CLONE=https://your-domain.example npm run verify
```

That checks every route against the captured origin HTML, resolves every
asset, and compares the runtime fragments (cart drawer, cart table,
predictive search, quickshop) with the origin's markup.

Expect:

```
201/201 routes match the origin's text content
3206/3206 referenced assets resolve
cart mini / cart table / predictive search / quickshop: 100% structural overlap
```

Then check the interactive parts in a browser:

- Add to cart from a product page, and confirm the drawer opens with the
  item and the badge count updates
- Open `/cart` — the table should list the item with a total
- Search in the header — the dropdown should suggest products
- Click **Quickshop** on a collection card — the modal should open with the
  gallery and an add-to-cart button
- Scroll to the bottom — the demo notice should be below the footer
- Click the country selector in the footer — the country list should open

---

## Notes

- **The cart is stateless.** It lives in a signed cookie, so it survives
  restarts and works across instances. Set `CART_SECRET` to the same value
  everywhere.
- **The image cache is disposable.** It is written to
  `public/.imgcache/` (or the temp directory when that is read-only) and
  rebuilt on demand — nothing breaks if it is lost.
- **Checkout is disabled.** `/checkout` shows a placeholder; no orders are
  processed.
- **Third-party widgets** (judge.me reviews, Quinn shoppable video, popup
  tools) still load from their original CDNs and will not function offline.
- **Do not commit `.env`** — it holds the cart secret. `.env.example`
  documents the variables.
