# RealUptime Monitor agent.
#
# Two stages on purpose. The build stage compiles TypeScript; the runtime
# stage receives the compiled dist/ and nothing else, so the shipped image
# contains no compiler, no tests and no source. Official images are built
# from this same source, signed with cosign, and published to GHCR (see
# README.md, "Verifying the image"); an image you build here is functionally
# identical but carries no signature.

FROM node:22-alpine AS build
WORKDIR /agent
COPY package.json tsconfig.json tsconfig.build.json ./
COPY *.ts ./
RUN npm install --no-audit --no-fund && npm run build

FROM node:22-alpine
RUN addgroup -S agent && adduser -S agent -G agent
USER agent
WORKDIR /agent
COPY --from=build /agent/dist ./dist
ENTRYPOINT ["node", "dist/agent.js"]
