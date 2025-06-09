# Use an official Node.js runtime that includes Python
FROM node:18-slim

# Set the working directory in the container
WORKDIR /usr/src/app

# Install Python and the tool to create virtual environments
RUN apt-get update && apt-get install -y python3 python3-pip python3-venv

# Create a virtual environment in the /opt/venv directory
RUN python3 -m venv /opt/venv

# Add the virtual environment's bin directory to the PATH.
# This makes `python` and `pip` from the venv the default.
ENV PATH="/opt/venv/bin:$PATH"

# Copy Python requirements file
COPY requirements.txt ./

# Install Python dependencies (this will now use the venv's pip)
RUN pip install --no-cache-dir -r requirements.txt

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