# Use the official Playwright image which includes all browsers
FROM mcr.microsoft.com/playwright:v1.40.0-focal

WORKDIR /app

# Copy package files
COPY package*.json ./

# Install dependencies
RUN npm ci

# Copy source code
COPY . .

# Build TypeScript to JavaScript
RUN npm run build

# Playwright installs browsers in /ms-playwright, ensure permissions if needed. 
# With official image, root is default or pwuser.
# The image is pre-baked with browsers.

# Expose port
EXPOSE 3000

# Start the application
CMD ["node", "dist/server.js"]
