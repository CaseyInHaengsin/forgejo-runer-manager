FROM node:22-bookworm-slim AS deps
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-lock.yaml* ./
RUN if [ -f pnpm-lock.yaml ]; then pnpm install --frozen-lockfile; else pnpm install; fi

FROM node:22-bookworm-slim AS build
WORKDIR /app
RUN corepack enable
COPY --from=deps /app/node_modules ./node_modules
COPY package.json tsconfig.json ./
COPY src ./src
RUN pnpm build

FROM node:22-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production
RUN corepack enable
COPY package.json pnpm-lock.yaml* ./
RUN if [ -f pnpm-lock.yaml ]; then pnpm install --prod --frozen-lockfile; else pnpm install --prod; fi
COPY --from=build /app/dist ./dist
COPY public ./public
RUN mkdir -p /app/data
EXPOSE 3000
CMD ["pnpm", "start"]
