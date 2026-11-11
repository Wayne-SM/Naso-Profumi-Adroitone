# NASO Profumi — clone
#
# The image pipeline needs libvips; the sharp npm package ships prebuilt
# binaries for linux-x64, so no system image libraries are required.

FROM node:22-bookworm-slim AS deps

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

FROM node:22-bookworm-slim AS runtime

ENV NODE_ENV=production \
    PORT=3000

WORKDIR /app

# Dependencies (sharp included).
COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./

# Application code.
COPY lib ./lib
COPY server ./server

# The mirrored site: pages, assets, captured API payloads, countries.js.
COPY public ./public

# The resized-image cache is written at runtime.
RUN mkdir -p /app/public/.imgcache && chown -R node:node /app/public/.imgcache

USER node

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server/server.mjs"]
