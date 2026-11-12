FROM node:26-bookworm-slim AS deps
WORKDIR /app
RUN npm install -g pnpm@10.18.1
COPY package.json pnpm-lock.yaml* ./
RUN if [ -f pnpm-lock.yaml ]; then pnpm install --frozen-lockfile; else pnpm install; fi

FROM node:26-bookworm-slim AS build
WORKDIR /app
RUN npm install -g pnpm@10.18.1
COPY --from=deps /app/node_modules ./node_modules
COPY package.json tsconfig.json ./
COPY src ./src
RUN pnpm build

FROM node:26-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production
RUN npm install -g pnpm@10.18.1
COPY package.json pnpm-lock.yaml* ./
RUN if [ -f pnpm-lock.yaml ]; then pnpm install --prod --frozen-lockfile; else pnpm install --prod; fi
COPY --from=build /app/dist ./dist
COPY public ./public
RUN mkdir -p /app/data
EXPOSE 3000
CMD ["pnpm", "start"]
