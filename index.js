// index.js – Monkey Linker Bot (final modular)
// --------------------------------------------
// • Loads slash commands from ./commands
// • Verifies Roblox profile via ✅ reaction
// • Uses SQLite for links
// • OpenCloud support optional
// • Keeps Railway/Fly/Render alive
// © StillBrokeStudios 2025 · @davdxpx

require('dotenv').config();
const fs = require('node:fs');
const path = require('node:path');
const express = require('express');
const sqlite = require('sqlite3').verbose();
const axios = require('axios');
const { Client, GatewayIntentBits, Partials, Collection, REST, Routes } = require('discord.js');

const {
  DISCORD_TOKEN,
  CLIENT_ID,
  GUILD_ID,
  VERIFIED_ROLE_ID,
  UNIVERSE_ID,
  OC_KEY
} = process.env;

/*────────── 1 · Client + DB ──────────*/
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

/*────────── 2 · Load + register commands ──────────*/
const commandFiles = fs.readdirSync('./commands').filter(f => f.endsWith('.js'));
const commands = [];

for (const file of commandFiles) {
  const cmd = require(`./commands/${file}`);
  client.commands.set(cmd.data.name, cmd);
  commands.push(cmd.data.toJSON());
}

const rest = new REST({ version: '10' }).setToken(DISCORD_TOKEN);
async function registerCommands() {
  await rest.put(Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID), { body: commands });
  console.log('✅ Slash commands registered');
}

/*────────── 3 · Interactions ──────────*/
client.on('interactionCreate', async interaction => {
  if (!interaction.isChatInputCommand()) return;
  const command = client.commands.get(interaction.commandName);
  if (!command) return;

  try {
    await command.execute(interaction, client.db, {
      VERIFIED_ROLE_ID,
      UNIVERSE_ID,
      OC_KEY,
      GUILD_ID
    });
  } catch (err) {
    console.error(err);
    interaction.reply({ content: '❌ Error executing command.', ephemeral: true });
  }
});

/*────────── 4 · ✅ Reaction = verify profile ──────────*/
client.on('messageReactionAdd', async (reaction, user) => {
  if (user.bot || reaction.emoji.name !== '✅') return;
  if (reaction.partial) await reaction.fetch();

  client.db.get('SELECT * FROM links WHERE discord=?', [user.id], async (_, row) => {
    if (!row || row.verified) return;

    try {
      const { data: profile } = await axios.get(`https://users.roblox.com/v1/users/${row.roblox}`);
      if (!profile.description?.includes(row.code))
        return user.send('❌ Code not found – save it and react again.');

      client.db.run('UPDATE links SET verified=1 WHERE discord=?', [user.id]);
      user.send('✅ Linked! You may remove the code.');

      if (VERIFIED_ROLE_ID) {
        const guild = await client.guilds.fetch(GUILD_ID);
        const member = await guild.members.fetch(user.id).catch(() => null);
        if (member) member.roles.add(VERIFIED_ROLE_ID).catch(console.error);
      }

      if (UNIVERSE_ID && OC_KEY) {
        try {
          const entryKey = `Player_${row.roblox}`;
          const oc = await axios.get(
            `https://apis.roblox.com/datastores/v1/universes/${UNIVERSE_ID}/standard-datastores/datastore/entries/entry`,
            {
              params: { datastoreName: 'MainDataStore', entryKey },
              headers: { 'x-api-key': OC_KEY }
            }
          );
          const data = JSON.parse(oc.data.data);
          const lvl = data?.PlayerData?.Progress?.Level ?? '?';
          const stat = data?.PlayerData?.Progress?.Statues ?? '?';
          user.send(`📊 Monkey Level **${lvl}** · Statues **${stat}/42**`);
        } catch (e) {
          console.error(e);
        }
      }
    } catch (e) {
      console.error(e);
      user.send('⚠️ Verification failed.');
    }
  });
});

/*────────── 5 · Cleanup ──────────*/
setInterval(() =>
  client.db.run('DELETE FROM links WHERE verified=0 AND (strftime("%s","now")-created) > 900'),
  300_000);

/*────────── 6 · Keep-alive HTTP server ──────────*/
const app = express();
app.get('/', (_, res) => res.send('OK'));
app.get('/healthz', (_, res) => res.send('OK'));
app.listen(process.env.PORT || 3000, () => console.log('🌐 HTTP keep-alive ready'));
setInterval(() => console.log('⏳ still alive'), 60_000);

/*────────── 7 · Boot ──────────*/
client.once('ready', async () => {
  console.log(`🤖 Logged in as ${client.user.tag}`);
  await registerCommands();
});

client.login(DISCORD_TOKEN);
