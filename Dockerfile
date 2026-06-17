# Use Node.js LTS (Long Term Support) version
FROM node:18-alpine

# Create app directory
WORKDIR /usr/src/app

# Install app dependencies
# Note: Ensure package-lock.json is generated locally and committed to Git!
COPY package*.json ./

# Define environment variable early (helps optimization tools and packages)
ENV NODE_ENV=production

# Install dependencies using the updated production flag
RUN npm ci --omit=dev

# Bundle app source
COPY . .

# Your app binds to port 9000
EXPOSE 9000

# Start the server
CMD [ "node", "server.js" ]