# Multi-stage build: dependencies are resolved once (cached layer); the runtime image
# runs as the unprivileged `node` user. No browser is installed: Playwright Test is used
# as a test runner only.

FROM node:20-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund && npm cache clean --force

FROM node:20-slim AS runtime
LABEL org.opencontainers.image.title="llm-test-harness" \
      org.opencontainers.image.description="LLM testing & evaluation framework on Playwright Test" \
      org.opencontainers.image.licenses="MIT"
ENV NODE_ENV=test \
    CI=true \
    LLM_PROVIDER=mock \
    LLM_GATE=true
WORKDIR /app
COPY --from=deps --chown=node:node /app/node_modules ./node_modules
COPY --chown=node:node . .
RUN chown node:node /app && mkdir -p reports && chown node:node reports
USER node

# Default: validate the YAML, unit tests, then the LLM evals with the quality gate enforced.
CMD ["sh", "-c", "npm run validate && npm run test:unit && npm run test:llm"]
