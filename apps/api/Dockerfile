# Hugging Face Spaces (Docker) runs this. Node rather than a Python base image,
# since the whole stack is TypeScript.
FROM node:22-slim

# Spaces mounts a read-only filesystem apart from /tmp, so the app must never
# write next to its own code. Everything durable already lives in Postgres.
ENV NODE_ENV=production
WORKDIR /app

# Copy manifests first so a dependency layer is cached across code changes.
COPY package.json package-lock.json ./
COPY packages/shared/package.json packages/shared/
COPY apps/api/package.json apps/api/

# The web workspace is not part of this image; --omit is not enough because npm
# still resolves workspace links, so install from the root with what is present.
RUN npm install --workspaces --include-workspace-root --omit=dev || npm install

COPY packages/shared ./packages/shared
COPY apps/api ./apps/api

RUN npm run build --workspace @lifepilot/shared

# Spaces expects 7860; PORT still wins so the same image runs anywhere.
ENV PORT=7860
EXPOSE 7860

CMD ["npx", "tsx", "apps/api/src/server.ts"]
