// Monkey Linker Bot – links a Discord user to their Roblox account via profile‑code method
require('dotenv').config();
const { Client, GatewayIntentBits, Partials, EmbedBuilder } = require('discord.js');
const axios = require('axios');
const sqlite = require('sqlite3').verbose();
const crypto = require('crypto');

/***************************
 *  0 · Database setup      *
 ***************************/
const db = new sqlite.Database('./links.db');
db.exec(`CREATE TABLE IF NOT EXISTS links (
  discord TEXT PRIMARY KEY,
  roblox  INTEGER UNIQUE NOT NULL,
  code    TEXT,
  verified INTEGER DEFAULT 0,
  created  INTEGER DEFAULT (strftime('%s','now'))
)`);

/***************************
 *  1 · Discord client      *
 ***************************/
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.DirectMessages
  ],
  partials: [Partials.Channel] // allow DM handling
});

client.once('ready', () => console.log(`🤖 Logged in as ${client.user.tag}`));

/***************************
 *  2 · /CONNECT handler    *
 ***************************/
client.on('interactionCreate', async (interaction) => {
  if (!interaction.isChatInputCommand() || interaction.commandName !== 'connect') return;
  const rbxName = interaction.options.getString('robloxuser', true);
  await interaction.deferReply({ ephemeral: true });

  // 2.1 Resolve userId via Roblox API
  const res = await axios.get(`https://api.roblox.com/users/get-by-username?username=${encodeURIComponent(rbxName)}`);
  if (!res.data.Id) return interaction.editReply('🚫 Roblox user not found. Check spelling & try again.');

  const userId = res.data.Id;

  // 2.2 Generate link code & store pending row
  const code = crypto.randomBytes(3).toString('hex').toUpperCase();
  db.run('INSERT OR REPLACE INTO links (discord, roblox, code, verified) VALUES (?,?,?,0)',
    [interaction.user.id, userId, code]);

  // 2.3  DM instructions to user
  const dmEmbed = new EmbedBuilder()
    .setColor(0x00bcd4)
    .setTitle('Account Link – Final Step')
    .setDescription(
      `Paste this code **exactly** in your Roblox profile About section, save, then react ✅ here within 15 min:\n\n`+
      `\`${code}\`\n\nYou can delete it after verification.`)
    .setFooter({ text: 'StillBroke Studios • Monkey Simulator' });

  const dm = await interaction.user.send({ embeds: [dmEmbed] });
  await dm.react('✅');
  await interaction.editReply('📩 Check your DMs for instructions!');
});

/***************************
 *  3 · Reaction checker     *
 ***************************/
client.on('messageReactionAdd', async (reaction, user) => {
  if (user.bot || reaction.emoji.name !== '✅') return;
  // Ensure full message for partials
  if (reaction.partial) await reaction.fetch();

  db.get('SELECT * FROM links WHERE discord = ?', [user.id], async (err, row) => {
    if (err || !row || row.verified) return;

    try {
      const profile = await axios.get(`https://users.roblox.com/v1/users/${row.roblox}`);
      if (!profile.data.description || !profile.data.description.includes(row.code)) {
        return user.send('❌ Code not found on your profile. Make sure it is saved and visible, then react again.');
      }

      // Mark verified & clear code
      db.run('UPDATE links SET verified = 1 WHERE discord = ?', [user.id]);
      user.send('✅ Linked! You can now remove the code from your profile.');

      /* OPTIONAL: fetch progress from Open Cloud
      if (process.env.UNIVERSE_ID && process.env.OC_KEY) {
        const entryKey = `Player_${row.roblox}`;
        const resp = await axios.get(
          `https://apis.roblox.com/datastores/v1/universes/${process.env.UNIVERSE_ID}/standard-datastores/datastore/entries/entry`,
          {
            params: { datastoreName: 'MainDataStore', entryKey },
            headers: { 'x-api-key': process.env.OC_KEY }
          }
        );
        const data = JSON.parse(resp.data.data);
        const level = data?.PlayerData?.Progress?.Level ?? 'N/A';
        user.send(`📊 Current Monkey level: **${level}**`);
      }
      */

    } catch (e) {
      console.error(e);
      user.send('⚠️ Something went wrong. Try again later.');
    }
  });
});

/***************************
 *  4 · Start the bot        *
 ***************************/
client.login(process.env.DISCORD_TOKEN);
