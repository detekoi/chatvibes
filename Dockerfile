# Use an official Node.js runtime as a parent image
FROM node:18-slim

# Set the working directory in the container
WORKDIR /usr/src/app

# Copy package.json and package-lock.json (or yarn.lock)
COPY package*.json ./

# Install app dependencies
RUN npm ci --only=production # Use npm ci for faster, more reliable builds in CI/CD

# Bundle app source
COPY . .

# Expose the port the app runs on (e.g., 8080)
EXPOSE 8080

# Define the command to run your app
CMD [ "node", "src/bot.js" ]