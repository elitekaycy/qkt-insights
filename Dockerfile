FROM node:22-slim AS build
RUN corepack enable && apt-get update && apt-get install -y --no-install-recommends python3 make g++ && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json tsconfig.base.json tsconfig.json tsconfig.server.json ./
COPY packages ./packages
COPY apps ./apps
COPY src ./src
RUN pnpm install --frozen-lockfile && pnpm build:all && pnpm prune --prod --config.confirmModulesPurge=false

FROM node:22-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app/dist ./dist
COPY --from=build /app/packages ./packages
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/package.json ./package.json
EXPOSE 8420
VOLUME /data
ENTRYPOINT ["node", "dist/src/server.js"]
CMD ["run"]
