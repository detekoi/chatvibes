FROM node:20-slim

WORKDIR /app

# Install dependencies for Secret Manager
COPY package*.json ./
RUN npm ci --only=production

# Copy cleanup script
COPY scripts/cleanup-secret-versions.js ./cleanup-secret-versions.js

# Run the cleanup script with --execute flag
CMD ["node", "cleanup-secret-versions.js", "--execute"]
