/// <reference types="astro/client" />

// Cloudflare bindings + env. Typed globally so `import { env } from
// 'cloudflare:workers'` gives back the right shape across the app.
// Mirrors the bindings declared in infrastructure/kids-library.tf and
// the Pages env vars set by Terraform.
declare namespace Cloudflare {
  interface Env {
    ACCESS_TEAM_DOMAIN: string;
    ACCESS_APP_AUD: string;
    DB: D1Database;
    ISBN_CACHE: KVNamespace;
    COVERS: R2Bucket;
  }
}

declare namespace App {
  interface Locals {
    /** Verified email from Cf-Access-Authenticated-User-Email after middleware passes. */
    userEmail: string;
  }
}
