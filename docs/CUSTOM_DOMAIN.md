# Verastar custom domain

Configured 2026-10-12 with user authorization.

- Public URL: https://verastar.papertrellis.com
- Netlify site: `14488e48-5f99-4391-8d7e-9cd16ccfedeb` (`verastar`).
- Primary custom domain: `verastar.papertrellis.com`.
- Namecheap DNS: CNAME host `verastar`, target `verastar.netlify.app.`, automatic TTL (observed 1799 seconds).
- Existing apex, www, verification, and mail records preserved.
- Netlify-managed Let's Encrypt certificate issued 2026-10-12; automatic renewal enabled.
- Existing Netlify address permanently redirects to the custom domain.

## Authentication

Shared Supabase project: `lahahztitoqjumrxjcim`.
Added exact redirect allow-list entries for `https://verastar.papertrellis.com` and `https://verastar.papertrellis.com/`.
Preserved existing allow-list entries and shared default Site URL (`https://statup.app`). Verastar explicitly supplies `window.location.origin` as `emailRedirectTo`.

## Verification

- Authoritative DNS and public resolvers 1.1.1.1 and 8.8.8.8 returned the new CNAME.
- Netlify reported DNS verification successful and certificate state `issued` for the new hostname.
- HTTPS request using the public DNS-resolved address with hostname/certificate validation returned 200. The HTML SHA-256 matched the existing production address: `0b44592c485754d9ef9de2afba42d302ce64b5670f419fba12f1ef0cd7245c1e`.
- HTTP returned 301 to the HTTPS address.
- Generated and consumed a magic link for the existing dedicated QA account without sending email: HTTP 303 to the new origin with an authenticated session and no auth error.
- At verification time, the Mac/browser still cached an earlier negative DNS result, so a rendered walkthrough at the new origin remained unverified. No DNS or hosts-file override was installed.
- Email delivery and paid model/digest runs were not exercised.

Attaching the domain required no app redeployment. The subsequent redirect release is described below; its source is preserved together with the beta release in Git.

## Legacy-address redirect (2026-10-12)

Deployed routing update `6accd614dff828244c227b4b` after the user requested the redirect. Routing is now in `public/_redirects`, which Vite copies to the deploy output, for consistent manual and Git builds.

Live checks confirmed HTTP 301 from `https://verastar.netlify.app/` to the custom domain, preserving `?firstrun=1` and `/api-key-guide.html?source=old`. HTTP first redirects to HTTPS on the legacy hostname, then to the custom domain. Netlify processed all three rules without errors. Build passed. Local DNS cache limitation noted above persisted at this check.

The later DNS diagnosis found that both authoritative nameservers, Cloudflare, Google, Tailscale, and one ISP resolver returned the correct CNAME. The second ISP resolver still held an NXDOMAIN response with a remaining negative-cache TTL. This is resolver propagation, not a missing domain record or certificate. No hosts-file override or replacement IP record is needed.
