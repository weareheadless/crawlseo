# CrawlSEO — Project Handover

> **Date:** 2026-07-23
> **App:** [weareheadless/crawlseo](https://github.com/weareheadless/crawlseo) (Next.js 16 + PostgreSQL + Prisma)
> **Access URL:** https://static.casamigo.net/seo/login
> **Server:** weaviate (216.238.93.99)

---

## ✅ What's Working

| Feature | Status |
|---------|--------|
| Dev server (port 3001, npm run dev) | ✅ Running |
| PostgreSQL (Docker, port 5432) | ✅ Running |
| Nginx reverse proxy (static.casamigo.net/seo/) | ✅ Configured |
| Google OAuth sign-in | ✅ Working |
| Dashboard / sites pages | ✅ Working |
| GSC API (direct curl test) | ✅ Returns 6 properties |
| Session cookie (curl test) | ✅ Session lookup works |

---

## ❌ What's Broken

**"Failed to load GSC properties"** when clicking "Add Site" in the UI.

---

## Current Configuration Summary

### Files Modified (relative to upstream)

| File | Change | Why |
|------|--------|-----|
| `next.config.ts` | `basePath: "/seo"`, `allowedDevOrigins: ["static.casamigo.net"]` | App served under `/seo/` path |
| `lib/auth.ts` | `pages.signIn: "/seo/login"`, `pages.error: "/seo/login"`, `cookies.sessionToken.options.path: "/"` | Auth redirects + cookie path |
| `app/api/auth/[...nextauth]/route.ts` | Restored to `export const { GET, POST } = handlers;` | Standard handler |
| `app/(auth)/login/page.tsx` | `redirectTo: "/seo/dashboard"`, `redirect("/seo/dashboard")` | Login redirect path |
| `components/layout/app-shell.tsx` | `href="/seo/api/auth/signout"` | Logout link path |
| `lib/session-helper.ts` | **NEW** — reads session cookie directly from DB, bypasses `auth()` | Auth.js session lookup unreliable behind proxy |
| `app/api/gsc/properties/route.ts` | Uses `getUserIdFromCookies()` instead of `auth()` | Bypass flaky auth |
| `app/api/gsc/sync/route.ts` | Uses `getUserIdFromCookies()` instead of `auth()` | Bypass flaky auth |
| `components/sites/add-site-modal.tsx` | `fetch("/seo/api/gsc/properties")` and `fetch("/seo/api/sites")` | Client fetch missing `/seo/` prefix |
| `components/sites/sync-button.tsx` | `fetch("/seo/api/gsc/sync")` | Client fetch missing `/seo/` prefix |
| `components/sites/evaluate-alerts-button.tsx` | `fetch("/seo/api/alerts")` | Client fetch missing `/seo/` prefix |
| `components/settings/api-keys-section.tsx` | `fetch("/seo/api/user/...")` | Client fetch missing `/seo/` prefix |

### .env.local

```
DATABASE_URL=postgresql://crawlseo:changeme@localhost:5432/crawlseo
NEXTAUTH_URL=https://static.casamigo.net
NEXTAUTH_SECRET=<set in .env.local>
AUTH_SECRET=<set in .env.local>
GOOGLE_CLIENT_ID=<set in .env.local>
GOOGLE_CLIENT_SECRET=<set in .env.local>
```

### Nginx (static.casamigo.net — `/etc/nginx/sites-available/chat.casamigo.net`)

```nginx
# CrawlSEO auth callbacks (Google OAuth)
location /api/auth/ {
    proxy_pass http://127.0.0.1:3001/seo/api/auth/;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_read_timeout 86400s;
    proxy_send_timeout 86400s;
}

# CrawlSEO app
location /seo/ {
    proxy_pass http://127.0.0.1:3001/seo/;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_read_timeout 86400s;
    proxy_send_timeout 86400s;
    proxy_buffering off;
}
```

### Google Cloud Console

- **Project:** 438849395964
- **Authorized redirect URIs:** BOTH needed:
  - `https://static.casamigo.net/api/auth/callback/google`
  - `https://static.casamigo.net/seo/api/auth/callback/google`
- **APIs enabled:** Search Console API

---

## Known Issues & Gotchas

### 1. GSC properties not loading in browser
- Curl with session cookie works: `curl -H "Cookie: __Secure-authjs.session-token=..." https://static.casamigo.net/seo/api/gsc/properties` → returns 200 with data
- Browser shows "Failed to load" — likely cookie not being sent or wrong cookie name
- The `getUserIdFromCookies()` in `lib/session-helper.ts` reads `__Secure-authjs.session-token` and `authjs.session-token` from request cookies
- Auth.js sets `__Secure-` prefixed cookies on HTTPS (which it is behind Cloudflare)

### 2. Hydration mismatch (cosmetic)
- `href="/api/auth/signout"` vs `href="/seo/api/auth/signout"` — stale browser JS cache
- Does NOT affect functionality — signout works fine

### 3. `env-url-basepath-mismatch` warning
- `NEXTAUTH_URL=https://static.casamigo.net` has no path, so basePath defaults to `/api/auth`
- This is intentional — auth callbacks go through `/api/auth/` nginx rule

### 4. Turbopack cache issues
- Changes to `lib/` files sometimes need `.next` deletion + restart to pick up
- `rm -rf /SEO/.next` then `npm run dev` for clean compile

---

## Diagnostic Commands

```bash
# Check dev server
curl https://static.casamigo.net/seo/api/health

# Test GSC endpoint (no auth — should return 401)
curl https://static.casamigo.net/seo/api/gsc/properties

# Test GSC endpoint WITH session cookie (get token from DB first)
SESSION_TOKEN=$(sudo docker exec seo-db-1 psql -U crawlseo -d crawlseo -t -c \
  "SELECT \"sessionToken\" FROM \"Session\" WHERE \"userId\"=(SELECT id FROM \"User\" WHERE email='valle.benjamin@gmail.com') ORDER BY expires DESC LIMIT 1;" | tr -d ' ')
curl -H "Cookie: __Secure-authjs.session-token=$SESSION_TOKEN" https://static.casamigo.net/seo/api/gsc/properties

# Test GSC API directly
TOKEN=$(sudo docker exec seo-db-1 psql -U crawlseo -d crawlseo -t -c \
  "SELECT \"googleTokens\"->>'accessToken' FROM \"User\" WHERE email='valle.benjamin@gmail.com';" | tr -d ' ')
curl "https://www.googleapis.com/webmasters/v3/sites" -H "Authorization: Bearer $TOKEN"

# Check database
sudo docker exec seo-db-1 psql -U crawlseo -d crawlseo -c "SELECT email, \"googleTokens\" IS NOT NULL as has_tokens FROM \"User\";"
sudo docker exec seo-db-1 psql -U crawlseo -d crawlseo -c "SELECT \"sessionToken\", expires FROM \"Session\";"

# Clean restart
pkill -9 -f "next dev"; fuser -k 3001/tcp; sleep 2; rm -rf /SEO/.next; cd /SEO && npm run dev

# Reload nginx
sudo nginx -t && sudo nginx -s reload
```

---

## Next Steps for Debugging

1. **Open browser DevTools → Network tab** while clicking "Add Site"
2. Check what URL the `fetch()` call goes to — should be `/seo/api/gsc/properties`
3. Check if the session cookie (`__Secure-authjs.session-token` or `authjs.session-token`) is included in the request
4. Check the response status and body

The most likely remaining issue: **the browser is not sending the session cookie** to `/seo/api/gsc/properties`, or the cookie name doesn't match what `getUserIdFromCookies()` looks for.
