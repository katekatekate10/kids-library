/**
 * Defense-in-depth Access JWT verification.
 *
 * Cloudflare Access is the primary auth layer (gates falkizar.com,
 * web-hub-eyl.pages.dev, and preview branches). This middleware runs
 * AFTER Access at the Pages Functions layer and cryptographically
 * verifies the Cf-Access-Jwt-Assertion header on every request. If
 * Access is misconfigured, bypassed, or experiences an outage, this
 * fails the request closed with 403.
 *
 * What's verified:
 *   1. JWT signature against Cloudflare's published JWKS for our team
 *   2. `iss` claim matches our Zero Trust team domain
 *   3. `aud` claim matches our Access application's AUD tag
 *   4. JWT not expired (handled by jose)
 *
 * Both ACCESS_TEAM_DOMAIN and ACCESS_APP_AUD are injected as Pages env
 * vars by Terraform (see infrastructure/pages.tf).
 */

import { createRemoteJWKSet, jwtVerify } from 'jose';

interface Env {
  ACCESS_TEAM_DOMAIN: string;
  ACCESS_APP_AUD: string;
}

// JWKS is cached at module scope so it's shared across requests on the
// same isolate. jose handles automatic refresh and rate-limits per-key
// fetches against the JWKS endpoint.
let cachedJwks: ReturnType<typeof createRemoteJWKSet> | null = null;
let cachedTeamDomain: string | null = null;

function getJwks(teamDomain: string) {
  if (!cachedJwks || cachedTeamDomain !== teamDomain) {
    cachedJwks = createRemoteJWKSet(new URL(`${teamDomain}/cdn-cgi/access/certs`));
    cachedTeamDomain = teamDomain;
  }
  return cachedJwks;
}

// PWA-only static assets. Browsers fetch the manifest and icon
// WITHOUT cookies by default (no `crossorigin="use-credentials"`),
// so if these go through Access they 302 to SSO and the install
// affordance silently breaks. Carving them out is safe — they're
// metadata/decoration with zero PII. /sw.js is the service worker
// itself; carving it out means it can register even if cookies are
// briefly absent. The rest of the app (including /, /api/*, every
// real route) still goes through full Access + JWT verification.
const PUBLIC_PATHS = new Set([
  '/manifest.webmanifest',
  '/icon.svg',
  '/sw.js',
]);

export const onRequest: PagesFunction<Env> = async (context) => {
  if (PUBLIC_PATHS.has(new URL(context.request.url).pathname)) {
    return context.next();
  }

  const teamDomain = context.env.ACCESS_TEAM_DOMAIN;
  const expectedAud = context.env.ACCESS_APP_AUD;

  if (!teamDomain || !expectedAud) {
    // Misconfiguration: fail closed rather than allow unauthenticated traffic.
    return reject('server misconfigured', 500);
  }

  // Cloudflare Access injects the JWT as a header on every proxied
  // request, and also as a cookie. Accept either source.
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
    // Don't surface the underlying error to the client — could leak
    // info about our verification scheme. Generic 403 is sufficient.
    return reject('invalid JWT');
  }

  return context.next();
};

function reject(reason: string, status = 403): Response {
  return new Response('Forbidden', {
    status,
    headers: {
      'X-Robots-Tag': 'noindex, nofollow',
      'Cache-Control': 'no-store, max-age=0',
      // Diagnostic — useful when debugging. Reasons are generic; no
      // sensitive content. Strip in production if even this is too much.
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
