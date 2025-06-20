// index.js – Monkey Linker Bot (modular commands)
// ------------------------------------------------------
// • /connect, /progress, /unlink via commands/
// • SQLite cache, role-grant, Open Cloud progress optional
// • Keeps Railway/Fly/Render alive via express
// ------------------------------------------------------

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const express = require('express');
const sqlite = require('sqlite3').verbose();
const {
  Client,
  GatewayIntentBits,
  Partials,
  Collection,
  REST,
  Routes
} = require('discord.js');

/*────────── 0 · ENV ──────────*/
const {
  DISCORD_TOKEN,
  CLIENT_ID,
  GUILD_ID
} = process.env;

/*────────── 1 · Slash-command loading ──────────*/
const commands = [];
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.DirectMessages,
    GatewayIntentBits.GuildMessageReactions,
    GatewayIntentBits.DirectMessageReactions
  ],
  partials: [Partials.Channel]
});

client.commands = new Collection();
const cmdFiles = fs.readdirSync('./commands').filter(f => f.endsWith('.js'));
for (const file of cmdFiles) {
  const command = require(`./commands/${file}`);
  client.commands.set(command.data.name, command);
  commands.push(command.data.toJSON());
}

/*────────── 2 · Register slash commands ──────────*/
client.once('ready', async () => {
  console.log(`🤖 Logged in as ${client.user.tag}`);
  const rest = new REST({ version: '10' }).setToken(DISCORD_TOKEN);
  try {
    await rest.put(Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID), { body: commands });
    console.log('✅ Slash commands registered');
  } catch (err) {
    console.error('❌ Command register error:', err);
  }
});

/*────────── 3 · SQLite DB ──────────*/
const db = new sqlite.Database('./links.db');
db.exec(`
  CREATE TABLE IF NOT EXISTS links (
    discord  TEXT PRIMARY KEY,
    roblox   INTEGER UNIQUE NOT NULL,
    code     TEXT,
    verified INTEGER DEFAULT 0,
    created  INTEGER DEFAULT (strftime('%s','now'))
  )
`);
client.db = db;

/*────────── 4 · Interaction handling ──────────*/
client.on('interactionCreate', async interaction => {
  if (!interaction.isChatInputCommand()) return;
  const command = client.commands.get(interaction.commandName);
  if (!command) return;
  try {
    await command.execute(interaction, client);
  } catch (err) {
    console.error(err);
    if (interaction.replied || interaction.deferred) {
      await interaction.editReply({ content: '❌ Error executing command.' });
    } else {
      await interaction.reply({ content: '❌ Error executing command.', ephemeral: true });
    }
  }
});

/*────────── 5 · Keep-alive HTTP server ──────────*/
const app = express();
app.get('/', (_, res) => res.send('OK'));
app.get('/healthz', (_, res) => res.send('OK'));
app.listen(process.env.PORT || 3000, () => console.log('🌐 HTTP keep-alive ready'));
setInterval(() => console.log('⏳ still alive'), 60_000);

/*────────── 6 · Launch bot ──────────*/
client.login(DISCORD_TOKEN);
