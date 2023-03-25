const mineflayer = require('mineflayer')
const dotenv = require('dotenv')
const axios = require('axios')

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

bot.on('chat', async (username, message) => {
  if (username === bot.username) return

  console.log(`${username}: ${message}`)

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

    messages.push({ role: 'user', content: message })

    const response = await axios.post(
      openaiApiUrl,
      {
        model: 'gpt-3.5-turbo',
        messages: messages,
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
    bot.chat(chatReply)
  } catch (error) {
    console.error('Error getting response from OpenAI API:', error)
  }
})
