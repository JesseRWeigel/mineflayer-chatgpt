# Mineflayer-ChatGPT

A Minecraft chatbot powered by OpenAI's ChatGPT and integrated with Mineflayer.

## Setup

1. Make sure you have [Node.js](https://nodejs.org/) installed (version 14 or higher).

2. Clone the repository and navigate to the project directory: `git clone https://github.com/JesseRWeigel/mineflayer-chatgpt.git
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

## TODO

[] Improve conversation and context: Enhance the bot's conversation skills by providing a more detailed context to the GPT-4 API, including the conversation history and relevant information about the player or the game.

[] Add more commands: Expand the bot's capabilities by adding more commands that players can use. For example, you can add commands for crafting recipes, mining strategies, building ideas, and more. Use the GPT-4 API to generate helpful responses based on the command and context.

[] Automate actions: Use Mineflayer to execute actions in the game based on the GPT-4 API responses. For example, if a player asks the bot to mine a specific resource, the bot can use Mineflayer to navigate to the resource and mine it.

[] Improve error handling and logging: Add more robust error handling and logging to the bot to ensure it runs smoothly and can recover from unexpected
issues.

## Tags

- #openai
- #chatgpt
- #minecraft
- #mineflayer
