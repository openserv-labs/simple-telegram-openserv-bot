import dotenv from 'dotenv'
import TelegramBot from 'node-telegram-bot-api'
import { Agent } from '@openserv-labs/sdk'
import axios from 'axios'
import { z } from 'zod'

// Load environment variables
dotenv.config()

class SimpleTelegramBot extends Agent {
  private bot: TelegramBot
  private workspaceId: number
  private agentId: number

  constructor() {
    // Validate required environment variables
    const requiredVars = ['TELEGRAM_BOT_TOKEN', 'OPENSERV_API_KEY', 'WORKSPACE_ID', 'AGENT_ID']
    const missingVars = requiredVars.filter(varName => !process.env[varName])
    
    if (missingVars.length > 0) {
      console.error('❌ Missing required environment variables:', missingVars)
      process.exit(1)
    }

    // Initialize Agent (parent class)
    super({
      systemPrompt: 'You are a helpful assistant.',
      apiKey: process.env.OPENSERV_API_KEY!
    })

    // Initialize bot
    this.bot = new TelegramBot(process.env.TELEGRAM_BOT_TOKEN!, { polling: true })
    this.workspaceId = parseInt(process.env.WORKSPACE_ID!)
    this.agentId = parseInt(process.env.AGENT_ID!)

    // Add debug capability to discover available agents
    this.addDebugCapability()

    this.setupHandlers()
  }

  private addDebugCapability() {
    // Add this temporary capability to see available agents
    this.addCapability({
      name: 'debugAgents',
      description: 'Debug: log all available agents',
      schema: z.object({}),
      async run({ args, action }) {
        if (!action?.workspace?.agents) {
          console.log('❌ No workspace agents available')
          return 'No workspace context available'
        }
        
        console.log('🔍 Available Agents in Workspace:')
        action.workspace.agents.forEach((agent, index) => {
          console.log(`${index + 1}. Name: \"${agent.name}\" | ID: ${agent.id}`)
          console.log(`   Capabilities: ${agent.capabilities_description}`)
          console.log('---')
        })
        
        return `Found ${action.workspace.agents.length} agents. Check console for details.`
      }
    })
  }

  private setupHandlers() {
    // Handle /start command
    this.bot.onText(/\/start/, async (msg) => {
      const chatId = msg.chat.id
      await this.bot.sendMessage(chatId, 
        '🤖 Simple OpenServ Bot!\
\
Usage: /ask [your question]\
Example: /ask What is OpenServ?'
      )
    })

    // Handle /ask command
    this.bot.onText(/\/ask (.+)/, async (msg, match) => {
      const chatId = msg.chat.id
      const question = match?.[1]

      if (!question) {
        await this.bot.sendMessage(chatId, '❌ Please write a question: /ask [your question]')
        return
      }

      // Send typing indicator
      this.bot.sendChatAction(chatId, 'typing')

      try {
        console.log(`📝 Question received: \"${question}\"`)
        
        // Create task for the agent
        const task = await this.createTask({
          workspaceId: this.workspaceId,
          assignee: this.agentId,
          description: 'Answer user question',
          body: `User asked: \"${question}\"\
\
Please provide a helpful and accurate answer.`,
          input: question,
          expectedOutput: 'A clear and helpful answer to the user question',
          dependencies: []
        })

        console.log(`🚀 Task created with ID: ${task.id}`)

        // Wait for task completion
        const result = await this.waitForTaskCompletion(task.id, chatId)
        
        if (result) {
          await this.bot.sendMessage(chatId, result)
        } else {
          await this.bot.sendMessage(chatId, '❌ Sorry, I could not answer your question. Please try again.')
        }

      } catch (error) {
        console.error('Error processing question:', error)
        await this.bot.sendMessage(chatId, '❌ An error occurred. Please try again.')
      }
    })

    // Handle /help command
    this.bot.onText(/\/help/, async (msg) => {
      const chatId = msg.chat.id
      const helpText = `
📖 Help:

Commands:
• /start - Start the bot
• /ask [question] - Ask a question
• /help - Show this help message

Example:
/ask Give information about OpenServ platform
      `
      await this.bot.sendMessage(chatId, helpText)
    })

    // Error handling
    this.bot.on('polling_error', (error) => {
      console.error('Telegram polling error:', error)
    })

    console.log('✅ Telegram bot handlers set up successfully!')
  }

  private async waitForTaskCompletion(taskId: number, chatId: number): Promise<string | null> {
    const maxWaitTime = 120000 // 2 minutes
    const pollInterval = 5000   // 5 seconds
    const startTime = Date.now()

    while (Date.now() - startTime < maxWaitTime) {
      try {
        // Continue typing indicator
        this.bot.sendChatAction(chatId, 'typing')

        // Check task status
        const taskDetail = await this.getTaskDetail({
          taskId: taskId,
          workspaceId: this.workspaceId
        })

        console.log(`⏳ Task ${taskId} status: ${taskDetail?.status}`)

        if (taskDetail?.status === 'done') {
          console.log(`✅ Task completed!`)

          // Check for output file
          if (taskDetail.attachments && taskDetail.attachments.length > 0) {
            try {
              const files = await this.getFiles({ workspaceId: this.workspaceId })
              const resultFile = files.find((file: any) => 
                taskDetail.attachments?.some((att: any) => file.path?.includes(att.path))
              )

              if (resultFile) {
                const fileContent = await axios.get(resultFile.fullUrl)
                
                // Clean up the file
                await this.deleteFile({
                  workspaceId: this.workspaceId,
                  fileId: resultFile.id
                }).catch(() => {})

                return fileContent.data || 'Task completed but could not retrieve result.'
              }
            } catch (fileError) {
              console.error('Error reading result file:', fileError)
            }
          }

          // If no file attachment, check task output
          if (taskDetail.output) {
            return taskDetail.output
          }

          return 'Task completed.'
        }

        if (taskDetail?.status === 'error') {
          console.error(`❌ Task failed`)
          return null
        }

        // Wait before next poll
        await new Promise(resolve => setTimeout(resolve, pollInterval))

      } catch (pollError) {
        console.error('Error during polling:', pollError)
        // Continue polling despite errors
      }
    }

    console.log(`⏰ Task ${taskId} timeout`)
    return 'Timeout. The task might still be processing.'
  }

  public async start(): Promise<void> {
    try {
      console.log('🚀 Starting Simple OpenServ Telegram Bot...')
      
      // Start the OpenServ agent server
      await super.start()
      
      console.log('✅ Bot is running! Send /start to begin.')

      // Handle graceful shutdown
      process.on('SIGINT', () => {
        console.log('\
⏹️ Shutting down bot...')
        this.bot.stopPolling()
        process.exit(0)
      })

    } catch (error) {
      console.error('❌ Error starting bot:', error)
      process.exit(1)
    }
  }
}

// Start the bot
if (require.main === module) {
  const bot = new SimpleTelegramBot()
  bot.start()
}

export default SimpleTelegramBot
