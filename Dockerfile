# Works on Hugging Face Spaces (Docker SDK) and on any container host.
FROM node:22.23.4-slim
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build && npm prune --omit=dev
ENV PORT=7860 HOST=0.0.0.0 DATA_DIR=/data
# HF Spaces runs as uid 1000; /data is only persistent with a Space storage bucket attached.
RUN mkdir -p /data && chown -R 1000:1000 /data /app
USER 1000
EXPOSE 7860
CMD ["node", "dist/main.js"]
