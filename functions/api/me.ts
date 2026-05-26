/**
 * Returns identity info about the current request. Cheap endpoint
 * that proves the middleware ran (the email header is only present
 * because Cloudflare Access verified the SSO and the middleware
 * verified the JWT). The frontend uses this on boot to decide what
 * to render per-user.
 */

interface Env {
  ACCESS_TEAM_DOMAIN: string;
  ACCESS_APP_AUD: string;
}

export const onRequestGet: PagesFunction<Env> = (context) => {
  const email = context.request.headers.get('Cf-Access-Authenticated-User-Email') ?? '';
  return Response.json({ email });
};
