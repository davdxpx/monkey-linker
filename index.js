// index.js – Monkey Linker Bot (modular final version)
// --------------------------------------------
// • Loads slash commands from ./commands
// • Manages verified links via SQLite
// • Keeps Railway/Fly/Render alive via HTTP server
// • Auto-registers all commands on boot

require('dotenv').config();
const fs = require('node:fs');
const path = require('node:path');
const express = require('express');
const sqlite = require('sqlite3').verbose();
const { Client, GatewayIntentBits, Collection, REST, Routes, Partials } = require('discord.js');

/*────────── 1 · ENV ──────────*/
const {
  DISCORD_TOKEN,
  CLIENT_ID,
  GUILD_ID
} = process.env;

/*────────── 2 · Discord client ──────────*/
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.DirectMessages,
    GatewayIntentBits.GuildMessageReactions,
    GatewayIntentBits.DirectMessageReactions
  ],
  partials: [Partials.Channel, Partials.Message, Partials.Reaction]
});

client.commands = new Collection();

/*────────── 3 · Load all commands ──────────*/
const commands = [];
const cmdsPath = path.join(__dirname, 'commands');
const cmdFiles = fs.readdirSync(cmdsPath).filter(file => file.endsWith('.js'));

for (const file of cmdFiles) {
  const cmd = require(`./commands/${file}`);
  client.commands.set(cmd.data.name, cmd);
  commands.push(cmd.data.toJSON());
}

/*────────── 4 · Register slash commands ──────────*/
const rest = new REST({ version: '10' }).setToken(DISCORD_TOKEN);

async function registerCommands() {
  try {
    await rest.put(Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID), { body: commands });
    console.log('✅ Slash commands registered');
  } catch (err) {
    console.error(err);
  }
}

/*────────── 5 · SQLite ──────────*/
client.db = new sqlite.Database('./links.db');
client.db.exec(`
  CREATE TABLE IF NOT EXISTS links (
    discord  TEXT PRIMARY KEY,
    roblox   INTEGER UNIQUE NOT NULL,
    code     TEXT,
    verified INTEGER DEFAULT 0,
    created  INTEGER DEFAULT (strftime('%s','now'))
  )
`);

/*────────── 6 · Command interaction handler ──────────*/
client.on('interactionCreate', async interaction => {
  if (!interaction.isChatInputCommand()) return;

  const command = client.commands.get(interaction.commandName);
  if (!command) return;

  try {
    await command.execute(interaction, client);
  } catch (error) {
    console.error(error);
    interaction.reply({ content: '❌ Something went wrong.', ephemeral: true });
  }
});

/*────────── 7 · Keep-alive server ──────────*/
const app = express();
app.get('/', (_, res) => res.send('OK'));
app.get('/healthz', (_, res) => res.send('OK'));
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log('🌐 HTTP keep-alive on', PORT));

/*────────── 8 · Launch ──────────*/
client.once('ready', async () => {
  console.log(`🤖 Logged in as ${client.user.tag}`);
  await registerCommands();
});

client.login(DISCORD_TOKEN);

// Dummy interval for event-loop hold
setInterval(() => console.log('⏳ still alive'), 60_000);
