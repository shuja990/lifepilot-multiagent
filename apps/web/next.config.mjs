import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // Pin the trace root. Next walks up looking for a lockfile and found one in a
  // parent directory outside this repo, which would bundle the wrong tree.
  outputFileTracingRoot: path.join(here, '..', '..'),
};

export default nextConfig;
