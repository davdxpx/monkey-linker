// index.js – Monkey Linker Bot (all-in-one)
// Links a Discord user to their Roblox account via profile-code method
// Keeps Railway (or any PaaS) alive with a tiny HTTP server
// Auto-registers /connect each time the bot boots

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

/*────────── 0 · ENV & constants ──────────*/
const {
  DISCORD_TOKEN,
  CLIENT_ID,
  GUILD_ID,
  VERIFIED_ROLE_ID,  // optional: role granted after link
  UNIVERSE_ID,       // optional: for progress fetch
  OC_KEY             // optional: Open Cloud API key
} = process.env;

/*────────── 1 · Slash-command register (guild scoped) ──────────*/
async function registerSlash() {
  const cmd = [{
    name: 'connect',
    description: 'Link your Roblox account',
    options: [{
      name: 'robloxuser',
      description: 'Exact Roblox username (case-sensitive)',
      type: 3,
      required: true
    }]
  }];

  const rest = new REST({ version: '10' }).setToken(DISCORD_TOKEN);
  await rest.put(
    Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID),
    { body: cmd }
  );
  console.log('✅ Slash command registered');
}

/*────────── 2 · SQLite setup ──────────*/
const db = new sqlite.Database('./links.db');
db.exec(`
  CREATE TABLE IF NOT EXISTS links (
    discord   TEXT PRIMARY KEY,
    roblox    INTEGER UNIQUE NOT NULL,
    code      TEXT,
    verified  INTEGER DEFAULT 0,
    created   INTEGER DEFAULT (strftime('%s','now'))
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
  partials: [Partials.Channel] // enable DM messages
});

client.once('ready', async () => {
  console.log(`🤖 Logged in as ${client.user.tag}`);
  try { await registerSlash(); } catch (e) { console.error(e); }
});

/*────────── 4 · /connect handler ──────────*/
client.on('interactionCreate', async (i) => {
  if (!i.isChatInputCommand() || i.commandName !== 'connect') return;

  const rbxName = i.options.getString('robloxuser', true);
  await i.deferReply({ ephemeral: true });

  /* 4.1 Roblox lookup */
  const lookup = await axios.get(
    `https://api.roblox.com/users/get-by-username?username=${encodeURIComponent(rbxName)}`
  );
  if (!lookup.data.Id) return i.editReply('🚫 Roblox user not found.');

  const userId = lookup.data.Id;

  /* 4.2 Duplicate check / rate-limit (pending exists) */
  const pending = await new Promise(r =>
    db.get('SELECT verified FROM links WHERE discord=?', [i.user.id], (_, row) => r(row))
  );
  if (pending && !pending.verified)
    return i.editReply('⚠️ You already have a pending link. Finish that first.');

  /* 4.3 Generate code & store */
  const code = crypto.randomBytes(3).toString('hex').toUpperCase();
  db.run('INSERT OR REPLACE INTO links (discord, roblox, code, verified, created) VALUES (?,?,?,?,strftime("%s","now"))',
    [i.user.id, userId, code, 0]);

  /* 4.4 Send DM */
  const embed = new EmbedBuilder()
    .setColor(0x00bcd4)
    .setTitle('Account Link – Final Step')
    .setDescription(
      `1️⃣ Paste **${code}** into your **Roblox profile About section**.\n` +
      '2️⃣ Return to this DM and press ✅ within 15 minutes.\n\n' +
      '_You can remove the code after verification._'
    )
    .setFooter({ text: 'StillBroke Studios • Monkey Simulator' });

  const dm = await i.user.send({ embeds: [embed] });
  await dm.react('✅');

  i.editReply('📩 Check your DMs for the verification code!');
});

/*────────── 5 · Reaction-handler (verify) ──────────*/
client.on('messageReactionAdd', async (reaction, user) => {
  if (user.bot || reaction.emoji.name !== '✅') return;
  if (reaction.partial) await reaction.fetch();

  db.get('SELECT * FROM links WHERE discord=?', [user.id], async (_, row) => {
    if (!row || row.verified) return; // nothing pending

    try {
      const profile = await axios.get(`https://users.roblox.com/v1/users/${row.roblox}`);
      if (!profile.data.description?.includes(row.code))
        return user.send('❌ Code not found on profile. Save it and react again.');

      /* Mark verified */
      db.run('UPDATE links SET verified=1 WHERE discord=?', [user.id]);
      user.send('✅ Linked! You may delete the code from your profile.');

      /* Optional role grant */
      if (VERIFIED_ROLE_ID) {
        const guild  = await client.guilds.fetch(GUILD_ID);
        const member = await guild.members.fetch(user.id).catch(()=>null);
        if (member) member.roles.add(VERIFIED_ROLE_ID).catch(console.error);
      }

      /* Optional progress fetch */
      if (UNIVERSE_ID && OC_KEY) {
        const entryKey = `Player_${row.roblox}`;
        const oc = await axios.get(
          `https://apis.roblox.com/datastores/v1/universes/${UNIVERSE_ID}/standard-datastores/datastore/entries/entry`,
          {
            params: { datastoreName: 'MainDataStore', entryKey },
            headers: { 'x-api-key': OC_KEY }
          }
        );
        const data  = JSON.parse(oc.data.data);
        const level = data?.PlayerData?.Progress?.Level ?? 'N/A';
        const stats = data?.PlayerData?.Progress?.Statues ?? 'N/A';
        user.send(`📊 Monkey Level **${level}** · Statues **${stats}/42**`);
      }

    } catch (e) {
      console.error(e);
      user.send('⚠️ Verification failed, try again later.');
    }
  });
});

/*────────── 6 · House-keeping: delete stale pending rows (15 min+) ──────────*/
setInterval(() =>
  db.run('DELETE FROM links WHERE verified=0 AND (strftime("%s","now")-created) > 900'),
  300_000);

/*────────── 7 · Keep-alive HTTP server (for Railway web service) ──────────*/
http.createServer((_, res) => res.end('Linker alive')).listen(process.env.PORT || 3000);

/*────────── 8 · Launch ──────────*/
client.login(DISCORD_TOKEN);
