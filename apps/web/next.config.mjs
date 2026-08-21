import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,

  /**
   * Static export.
   *
   * The whole UI is client-side: it talks to the API over fetch and SSE, and
   * uses no SSR, route handlers or image optimisation. Exporting means the app
   * is plain files on a CDN, which on free hosting is the difference between a
   * page that loads instantly and one that sleeps and takes a minute to wake.
   *
   * NEXT_PUBLIC_API_URL is baked in at build time either way, so this costs
   * nothing in configurability.
   */
  output: 'export',

  // Pin the trace root. Next walks up looking for a lockfile and can find one
  // in a parent directory outside this repo.
  outputFileTracingRoot: path.join(here, '..', '..'),
};

export default nextConfig;
