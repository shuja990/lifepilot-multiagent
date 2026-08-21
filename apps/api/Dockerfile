# Build from the REPO ROOT, not this directory:
#   docker build -f apps/api/Dockerfile .
# The npm workspace layout means the lockfile and the shared package both live
# above this file, so a narrower context cannot install correctly.

# ---------------------------------------------------------------- build stage
FROM node:22-slim AS build
WORKDIR /app

# Manifests first, so the dependency layer is cached across source-only changes.
# All three workspace manifests are copied even though the web app is not built
# here: npm reads every workspace to resolve the lockfile, and omitting one
# makes `npm ci` fail with a lockfile-out-of-sync error.
COPY package.json package-lock.json ./
COPY packages/shared/package.json packages/shared/
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/

# Dev dependencies are required here — TypeScript compiles during this stage.
RUN npm ci --workspace @lifepilot/shared --workspace @lifepilot/api --include-workspace-root

# The root tsconfig both workspaces extend. Without it `tsc` fails to resolve
# its base config and exits 2 — which only shows up in the image, since a local
# build always has the file sitting above it.
COPY tsconfig.base.json ./

COPY packages/shared packages/shared
COPY apps/api apps/api

# Compile to plain JavaScript rather than shipping tsx.
#
# An earlier version installed with --omit=dev and then ran `npx tsx`, which is
# a devDependency — so the image built cleanly and then failed at boot with
# "tsx not found". Compiling means the runtime image needs no TypeScript at all.
RUN npm run build --workspace @lifepilot/shared \
 && npm run build --workspace @lifepilot/api

# -------------------------------------------------------------- runtime stage
FROM node:22-slim AS runtime
WORKDIR /app

ENV NODE_ENV=production

# Production dependencies only. The compiled output needs no compiler.
COPY package.json package-lock.json ./
COPY packages/shared/package.json packages/shared/
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
RUN npm ci --omit=dev --workspace @lifepilot/shared --workspace @lifepilot/api --include-workspace-root \
 && npm cache clean --force

COPY --from=build /app/packages/shared/dist packages/shared/dist
COPY --from=build /app/apps/api/dist apps/api/dist

# Render injects PORT; this default only matters when running the image locally.
ENV PORT=10000
EXPOSE 10000

# Run as a non-root user. The base image ships `node` for exactly this.
USER node

CMD ["node", "apps/api/dist/server.js"]
