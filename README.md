# Broky Discord Bot

Broky is a Discord bot designed to integrate with Roblox, specifically for the game Monkey Simulator. It allows users to link their Roblox accounts to their Discord accounts and fetch their in-game progress.

## Features

- **Roblox Account Linking:** Securely link your Roblox account to your Discord account.
- **Progress Tracking:** Fetch and display your Monkey Simulator progress directly in Discord.
- **Slash Commands:** Easy-to-use slash commands for all functionalities.

## Prerequisites

- Node.js (version 18.0.0 or higher)
- npm (Node Package Manager)
- A Discord Bot Token
- MongoDB instance

## Setup

1. **Clone the repository:**
   ```bash
   git clone https://github.com/your-username/broky.git
   cd broky
   ```

2. **Install dependencies:**
   ```bash
   npm install
   ```

3. **Configure environment variables:**
   Create a `.env` file in the root directory and add the following variables:
   ```env
   DISCORD_TOKEN=your_discord_bot_token
   MONGODB_URI=your_mongodb_connection_string
   ROBLOX_API_KEY=your_roblox_api_key
   # You may also need other variables like GUILD_ID for command deployment
   ```

4. **Deploy slash commands:**
   Before starting the bot for the first time, or when commands change, you need to deploy them to Discord.
   ```bash
   npm run deploy
   ```
   This script typically requires your `DISCORD_TOKEN` and `CLIENT_ID` (your bot's application ID) and `GUILD_ID` (if deploying to a specific server for testing) to be set in your `.env` file or environment.

5. **Start the bot:**
   ```bash
   npm start
   ```
   For development with automatic restarts when files change:
   ```bash
   npm run dev
   ```

## Commands

The bot uses slash commands. Here are some of the main commands (based on the `commands/` directory):

- `/connect [roblox_username]`: Initiates the process to link your Roblox account.
- `/progress`: Fetches and displays your Monkey Simulator progress (requires a linked account).
- `/help`: Shows a list of available commands and their descriptions.
- `/unlink`: Unlinks your currently connected Roblox account.
- `/connection`: Checks the status of your Roblox account connection.
- `/admin <subcommand>`: Admin-specific commands.
- `/managemod <subcommand>`: Commands for managing moderators or modules.
- `/events <subcommand>`: Likely related to in-game events or bot events.

For a full list of commands and their detailed usage, you can use the `/help` command once the bot is running in your server.

## Project Structure

- `index.js`: The main entry point for the bot application.
- `deploy-commands.js`: Script used to register slash commands with Discord's API.
- `commands/`: Directory containing the logic for each slash command.
  - `admin.js`: Handles administrative commands.
  - `connect.js`: Manages linking Roblox accounts.
  - `connection.js`: Provides information about the current Roblox connection.
  - `events.js`: Likely deals with game or bot-related events.
  - `help.js`: Provides users with help information about commands.
  - `managemod.js`: Commands for moderator management or module control.
  - `progress.js`: Fetches and displays player progress from Monkey Simulator.
  - `unlink.js`: Handles unlinking Roblox accounts.
- `utils/`: Contains utility functions and helper modules.
  - `gameData.js`: May include functions for interacting with game-specific data or APIs.
  - `idGenerator.js`: Utility for generating unique IDs if needed.
  - `migrateEvents.js`: Script possibly used for migrating event data structures.
  - `permissions.js`: Helper functions for managing command permissions.
- `package.json`: Node.js project manifest file. Defines project metadata, dependencies, and scripts (like `start`, `dev`, `deploy`).
- `railway.json`: Configuration file for deploying the application on the Railway platform.
- `.env`: (Not in the repository, but crucial for local setup) Stores environment variables like API keys and tokens.
- `.gitignore`: Specifies intentionally untracked files that Git should ignore (e.g., `node_modules/`, `.env`).

## Contributing

Contributions are welcome! If you'd like to contribute, please fork the repository, make your changes, and submit a pull request. For major changes, please open an issue first to discuss what you would like to change.

## License

This project is licensed under the MIT License. (Assuming MIT from `package.json`, if a `LICENSE` file exists, it would confirm this).

## Author

StillBrokeStudios © 2025 · @davdxpx (as per `package.json`)
