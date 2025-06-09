# Use an official Node.js runtime that includes Python
FROM node:18-slim

# Set the working directory in the container
WORKDIR /usr/src/app

# (Optional but good practice) Ensure Python and pip are available
RUN apt-get update && apt-get install -y python3 python3-pip

# --- Python Dependency Installation ---
# Copy the Python requirements file into the container
COPY requirements.txt ./

# Install the Python dependencies listed in requirements.txt
RUN pip install --no-cache-dir -r requirements.txt

# --- Node.js Dependency Installation ---
# Copy package.json and package-lock.json
COPY package*.json ./

# Install Node.js dependencies using the lock file for consistency
RUN npm ci --only=production

# --- Application Code ---
# Copy the rest of your application's source code
COPY . .

# Expose the port the app runs on
EXPOSE 8080

# Define the command to run your app
CMD [ "node", "src/bot.js" ]