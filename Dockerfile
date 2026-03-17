# Use an official Node.js runtime
FROM node:22-slim

# Set the working directory in the container
WORKDIR /usr/src/app

# Copy Node.js package files
COPY package*.json ./

# Install Node.js dependencies
RUN npm ci --only=production

# Bundle app source
COPY . .

# Expose the port the app runs on
EXPOSE 8080

# Define the command to run your app
CMD [ "node", "src/bot.js" ]