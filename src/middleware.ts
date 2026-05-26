/**
 * Defense-in-depth Access JWT verification — Astro SSR variant.
 *
 * Mirrors web-hub/functions/_middleware.ts. We can't use that Pages
 * Functions middleware here because Astro SSR with @astrojs/cloudflare
 * outputs dist/_worker.js, which Pages prioritizes over the functions/
 * directory — so a functions/_middleware.ts would be silently bypassed.
 * The fix is to run the same verify logic inside Astro's request
 * pipeline via src/middleware.ts. Crypto, fail-closed behavior, and
 * env vars are identical.
 *
 * What's verified on every request:
 *   1. JWT signature against Cloudflare's published JWKS for our team
 *   2. `iss` claim matches our Zero Trust team domain
 *   3. `aud` claim matches our Access application's AUD tag
 *   4. JWT not expired (handled by jose)
 *
 * On pass: stores the verified email on `locals.userEmail` for downstream
 * use (per-user attribution on books/reviews). On fail: 403, no detail.
 */

import { defineMiddleware } from 'astro:middleware';
import { env } from 'cloudflare:workers';
import { createRemoteJWKSet, jwtVerify } from 'jose';

let cachedJwks: ReturnType<typeof createRemoteJWKSet> | null = null;
let cachedTeamDomain: string | null = null;

function getJwks(teamDomain: string) {
  if (!cachedJwks || cachedTeamDomain !== teamDomain) {
    cachedJwks = createRemoteJWKSet(new URL(`${teamDomain}/cdn-cgi/access/certs`));
    cachedTeamDomain = teamDomain;
  }
  return cachedJwks;
}

function reject(reason: string, status = 403): Response {
  return new Response('Forbidden', {
    status,
    headers: {
      'X-Robots-Tag': 'noindex, nofollow',
      'Cache-Control': 'no-store, max-age=0',
      'X-Falkizar-Reject-Reason': reason,
    },
  });
}

function parseCookie(cookieHeader: string, name: string): string | null {
  for (const part of cookieHeader.split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    const k = part.slice(0, eq).trim();
    if (k === name) return part.slice(eq + 1).trim();
  }
  return null;
}

export const onRequest = defineMiddleware(async (context, next) => {
  const teamDomain = env.ACCESS_TEAM_DOMAIN;
  const expectedAud = env.ACCESS_APP_AUD;

  if (!teamDomain || !expectedAud) {
    return reject('server misconfigured', 500);
  }

  const jwt =
    context.request.headers.get('Cf-Access-Jwt-Assertion') ??
    parseCookie(context.request.headers.get('Cookie') ?? '', 'CF_Authorization');

  if (!jwt) {
    return reject('missing JWT');
  }

  try {
    await jwtVerify(jwt, getJwks(teamDomain), {
      issuer: teamDomain,
      audience: expectedAud,
    });
  } catch {
    return reject('invalid JWT');
  }

  // Verified email — Access sets this header alongside the JWT after
  // SSO. Trustworthy because the JWT above just passed signature +
  // issuer + audience checks against the same Access app.
  context.locals.userEmail = context.request.headers.get('Cf-Access-Authenticated-User-Email') ?? '';

  return next();
});
