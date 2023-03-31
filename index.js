const mineflayer = require('mineflayer')
const dotenv = require('dotenv')
const axios = require('axios')
const Biome = require('prismarine-biome')
dotenv.config()

const openaiApiKey = process.env.OPENAI_API_KEY
const openaiApiUrl = 'https://api.openai.com/v1/chat/completions'

const bot = mineflayer.createBot({
  host: process.env.MINECRAFT_SERVER_HOST,
  port: parseInt(process.env.MINECRAFT_SERVER_PORT),
  username: process.env.MINECRAFT_USERNAME,
  auth: process.env.MINECRAFT_AUTH,
  version: process.env.MINECRAFT_VERSION,
})

bot.on('kicked', console.log)

bot.on('spawn', () => {
  console.log('Chatbot spawned')
})

// Store conversation history for different players
const playerContexts = {}

bot.on('chat', async (username, message) => {
  if (username === bot.username) return

  console.log(`${username}: ${message}`)

  if (message === '!location') {
    const position = bot.entity.position
    const biome = bot.world.getBiome(position.x, position.z)
    const landmarks = bot.findBlocks({
      matching: [BlockType.Monument, BlockType.Village],
      maxDistance: 64,
      count: 10,
    })

    const landmarkNames = landmarks.map((l) => l.name).join(', ')

    bot.chat(
      `You are at (${position.x}, ${position.y}, ${position.z}) in the ${Biome[biome]} biome. Nearby landmarks: ${landmarkNames}`
    )
  }

  // Retrieve or create the context for the player
  if (!playerContexts[username]) {
    playerContexts[username] = []
  }
  const context = playerContexts[username]

  try {
    // Collect information about the world, players, and mobs
    const botPosition = bot.entity.position
    const botHealth = bot.health
    const botGameMode = bot.game.gameMode
    const botInventory = bot.inventory.items()
    const players = bot.players
    const nearbyMobs = bot.nearestEntity((entity) => entity.type === 'mob')

    // Format the information as messages
    const messages = [
      {
        role: 'system',
        content:
          'You are an AI assistant that helps players in a Minecraft world. You have knowledge about the world, players, mobs, and your own status, and you can use this information to provide helpful responses. Remember to always answer questions within the context of Minecraft.',
      },
      {
        role: 'assistant',
        content: `I am currently at position x: ${botPosition.x.toFixed(
          2
        )}, y: ${botPosition.y.toFixed(2)}, z: ${botPosition.z.toFixed(
          2
        )}. My health is ${botHealth} and my game mode is ${botGameMode}. My inventory contains the following items: ${botInventory
          .map((item) => `${item.name} x${item.count}`)
          .join(', ')}`,
      },
    ]

    // Add information about other players
    Object.values(players).forEach((player) => {
      if (player.username !== bot.username && player.entity) {
        const playerPosition = player.entity.position
        messages.push({
          role: 'assistant',
          content: `Player ${
            player.username
          } is at position x: ${playerPosition.x.toFixed(
            2
          )}, y: ${playerPosition.y.toFixed(2)}, z: ${playerPosition.z.toFixed(
            2
          )}.`,
        })
      }
    })

    // Add information about nearby mobs
    if (nearbyMobs) {
      const mobPosition = nearbyMobs.position
      messages.push({
        role: 'assistant',
        content: `I found a nearby ${
          nearbyMobs.mobType
        } at position x: ${mobPosition.x.toFixed(
          2
        )}, y: ${mobPosition.y.toFixed(2)}, z: ${mobPosition.z.toFixed(2)}.`,
      })
    }

    context.push({ role: 'user', content: message })

    const response = await axios.post(
      openaiApiUrl,
      {
        model: 'gpt-4',
        messages: context,
        temperature: 0.5,
        max_tokens: 300,
      },
      {
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${openaiApiKey}`,
        },
      }
    )

    const chatReply = response.data.choices[0].message.content.trim()
    console.log(`Chatbot: ${chatReply}`)

    // Add GPT-4's response to the context
    context.push({ role: 'assistant', content: chatReply })

    bot.chat(chatReply)
  } catch (error) {
    console.error('Error getting response from OpenAI API:', error)
  }
})
