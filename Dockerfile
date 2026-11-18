FROM node:20-alpine
WORKDIR /app
ENV NODE_ENV=production
RUN chown node:node /app
USER node
COPY --chown=node:node package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund
COPY --chown=node:node src/ ./src/
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=45s --retries=3 CMD ["node", "src/http/healthcheck.js"]
CMD ["node", "src/index.js"]
