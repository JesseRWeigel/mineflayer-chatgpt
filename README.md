# Mineflayer-ChatGPT

A Minecraft chatbot powered by OpenAI's ChatGPT and integrated with Mineflayer.

## Setup

1. Make sure you have [Node.js](https://nodejs.org/) installed (version 14 or higher).

2. Clone the repository and navigate to the project directory: `git clone https://github.com/yourusername/mineflayer-chatgpt.git
cd mineflayer-chatgpt`

3. Install the required dependencies: `npm install`

4. Create a `.env` file in the project root directory with the following content: `OPENAI_API_KEY=your_openai_api_key
MINECRAFT_HOST=minecraft_server_host
MINECRAFT_PORT=minecraft_server_port
MINECRAFT_USERNAME=chatbot_username
MINECRAFT_VERSION=minecraft_version
MINECRAFT_AUTH=minecraft_auth_type`

Replace `your_openai_api_key` with your actual OpenAI API key. Set the other variables according to your Minecraft server configuration.

5. Run the chatbot: `node index.js`

The chatbot will now connect to the specified Minecraft server and start responding to chat messages using ChatGPT.

## Features

- Responds to chat messages from players in the Minecraft server.
- Utilizes the ChatGPT API for generating human-like responses.
- Provides contextual information about the Minecraft world and players to ChatGPT for better responses.

## Tags

- #openai
- #chatgpt
- #minecraft
- #mineflayer
