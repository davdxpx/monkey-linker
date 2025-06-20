// index.js – Monkey Linker Bot (final version)
// --------------------------------------------
// • /connect <RobloxUser> links Discord ↔ Roblox via profile-code
// • Auto-registers command on boot
// • SQLite cache, role-grant, optional Open-Cloud progress
// • Tiny HTTP server keeps Railway/Fly/Render alive
// --------------------------------------------

require('dotenv').config();
const {
  Client,
  GatewayIntentBits,
  Partials,
  EmbedBuilder,
  REST,
  Routes
} = require('discord.js');
const axios   = require('axios');
const sqlite  = require('sqlite3').verbose();
const crypto  = require('crypto');
const http    = require('http');

/*────────── 0 · ENV ──────────*/
const {
  DISCORD_TOKEN,
  CLIENT_ID,
  GUILD_ID,
  VERIFIED_ROLE_ID, // optional
  UNIVERSE_ID,      // optional
  OC_KEY            // optional
} = process.env;

/*────────── 1 · Runtime slash-command register ──────────*/
async function registerSlash() {
  const rest = new REST({ version: '10' }).setToken(DISCORD_TOKEN);
  await rest.put(
    Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID),
    {
      body: [{
        name: 'connect',
        description: 'Link your Roblox account',
        options: [{
          name: 'robloxuser',
          description: 'Exact Roblox username (case-sensitive)',
          type: 3,
          required: true
        }]
      }]
    }
  );
  console.log('✅ Slash command registered');
}

/*────────── 2 · SQLite ──────────*/
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

/*────────── 3 · Discord client ──────────*/
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.DirectMessages
  ],
  partials: [Partials.Channel]
});

client.once('ready', async () => {
  console.log(`🤖 Logged in as ${client.user.tag}`);
  try { await registerSlash(); } catch (e) { console.error(e); }
});

/* helper – new Roblox username → userId endpoint */
async function getUserId(username) {
  const { data } = await axios.post(
    'https://users.roblox.com/v1/usernames/users',
    { usernames: [username], excludeBannedUsers: true },
    { timeout: 5000 }
  );
  return data.data[0]?.id; // undefined if not found
}

/*────────── 4 · /connect handler ──────────*/
client.on('interactionCreate', async (i) => {
  if (!i.isChatInputCommand() || i.commandName !== 'connect') return;
  const rbxName = i.options.getString('robloxuser', true);
  await i.deferReply({ ephemeral: true });

  /* 4.1   Roblox lookup (new API) */
  let userId;
  try {
    userId = await getUserId(rbxName);
  } catch (e) {
    console.error(e);
    return i.editReply('⚠️ Roblox API error – try again later.');
  }
  if (!userId) return i.editReply('🚫 Roblox user not found.');

  /* 4.2   Duplicate check */
  const pending = await new Promise(r =>
    db.get('SELECT verified FROM links WHERE discord=?', [i.user.id], (_, row) => r(row))
  );
  if (pending && !pending.verified)
    return i.editReply('⚠️ You already have a pending link. Finish that first.');

  /* 4.3   Generate code & store */
  const code = crypto.randomBytes(3).toString('hex').toUpperCase();
  db.run(
    'INSERT OR REPLACE INTO links (discord, roblox, code, verified, created) VALUES (?,?,?,?,strftime("%s","now"))',
    [i.user.id, userId, code, 0]
  );

  /* 4.4   DM instructions */
  const dmEmbed = new EmbedBuilder()
    .setColor(0x00bcd4)
    .setTitle('Account Link – Final Step')
    .setDescription(
      `**1.** Paste \`${code}\` in your Roblox profile **About**.\n` +
      '**2.** React ✅ to this DM within 15 min.\n\n' +
      '_You can remove the code after verification._'
    );
  const dm = await i.user.send({ embeds: [dmEmbed] });
  await dm.react('✅');
  i.editReply('📩 Check your DMs for the verification code!');
});

/*────────── 5 · Reaction-verification ──────────*/
client.on('messageReactionAdd', async (reaction, user) => {
  if (user.bot || reaction.emoji.name !== '✅') return;
  if (reaction.partial) await reaction.fetch();

  db.get('SELECT * FROM links WHERE discord=?', [user.id], async (_, row) => {
    if (!row || row.verified) return;

    try {
      const { data: profile } = await axios.get(
        `https://users.roblox.com/v1/users/${row.roblox}`,
        { timeout: 5000 }
      );
      if (!profile.description?.includes(row.code))
        return user.send('❌ Code not found – save it in your profile and react again.');

      db.run('UPDATE links SET verified=1 WHERE discord=?', [user.id]);
      user.send('✅ Linked! You can delete the code from your profile.');

      /* optional role */
      if (VERIFIED_ROLE_ID) {
        const guild  = await client.guilds.fetch(GUILD_ID);
        const member = await guild.members.fetch(user.id).catch(() => null);
        if (member) member.roles.add(VERIFIED_ROLE_ID).catch(console.error);
      }

      /* optional progress */
      if (UNIVERSE_ID && OC_KEY) {
        try {
          const entryKey = `Player_${row.roblox}`;
          const oc = await axios.get(
            `https://apis.roblox.com/datastores/v1/universes/${UNIVERSE_ID}/standard-datastores/datastore/entries/entry`,
            {
              params: { datastoreName: 'MainDataStore', entryKey },
              headers: { 'x-api-key': OC_KEY },
              timeout: 5000
            }
          );
          const data  = JSON.parse(oc.data.data);
          const lvl   = data?.PlayerData?.Progress?.Level   ?? '?';
          const stat  = data?.PlayerData?.Progress?.Statues ?? '?';
          user.send(`📊 Monkey Level **${lvl}** · Statues **${stat}/42**`);
        } catch (e) { console.error(e); }
      }

    } catch (e) {
      console.error(e);
      user.send('⚠️ Verification failed – try later.');
    }
  });
});

/*────────── 6 · Cleanup stale pending (15 min) ──────────*/
setInterval(() =>
  db.run('DELETE FROM links WHERE verified=0 AND (strftime("%s","now")-created) > 900'),
  300_000);

/*────────── 7 · Keep-alive HTTP server ──────────*/
const express = require('express');
const app = express();

app.get('/', (_, res) => res.send('OK'));  // Health-Check
app.listen(process.env.PORT || 3000, () =>
  console.log('🌐 HTTP keep-alive ready')
);

/*────────── 8 · Launch ──────────*/
client.login(DISCORD_TOKEN);
