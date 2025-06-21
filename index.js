// ╔═══════════════════════════════════════════════════════════════════╗
// ║  index.js – Monkey Linker Bot  v2                                ║
// ║  Discord ⇆ Roblox account linking, slash‑command loader,         ║
// ║  OpenCloud lookup, keep‑alive server, SQLite persistence.        ║
// ║                                                                   ║
// ║  © StillBrokeStudios 2025 • Author @davdxpx                        ║
// ╚═══════════════════════════════════════════════════════════════════╝

// ─────────────────────────────  CONFIG  ──────────────────────────────
require('dotenv').config();
const {
  DISCORD_TOKEN,
  CLIENT_ID,
  GUILD_ID,          // ⇢  If omitted → commands registered globally
  VERIFIED_ROLE_ID,
  UNIVERSE_ID,
  OC_KEY,
  PORT               = 8080,
  DEBUG_LINKER       = '0',   // set to "1" for verbose prints
} = process.env;

const DBG  = DEBUG_LINKER === '1';
const log  = (...m) => DBG && console.log('[DBG]', ...m);
const warn = (...m) => console.warn('[WARN]', ...m);

// ───────────────────────────  DEPENDENCIES  ──────────────────────────
const fs      = require('node:fs');
const path    = require('node:path');
const axios   = require('axios');
const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const {
  Client,
  REST,
  Routes,
  Collection,
  GatewayIntentBits,
  Partials,
} = require('discord.js');

// ────────────────────────  INITIALISE CLIENT  ────────────────────────
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.DirectMessages,
    GatewayIntentBits.GuildMessageReactions,
    GatewayIntentBits.DirectMessageReactions,
  ],
  partials: [Partials.Channel, Partials.Message, Partials.Reaction],
});

// Attach custom containers
client.commands = new Collection();
client.cooldowns = new Collection(); // ⏱️ per‑command cooldowns

// ─────────────────────────────  DATABASE  ────────────────────────────
const db = new sqlite3.Database('./links.db', err => {
  if (err) return console.error('❌ DB load error', err);
  log('SQLite opened');
});
client.db = db;

db.serialize(() => {
  db.exec(
    `CREATE TABLE IF NOT EXISTS links (
      discord   TEXT    PRIMARY KEY,
      roblox    INTEGER UNIQUE NOT NULL,
      code      TEXT,
      verified  INTEGER DEFAULT 0,
      created   INTEGER DEFAULT (strftime('%s','now'))
    )`,
    err => err && console.error('❌ DB init error', err),
  );
});

// Scheduled cleanup of unverified stale rows
setInterval(() => db.run(
  'DELETE FROM links WHERE verified=0 AND (strftime("%s","now")-created) > 900'
), 5 * 60_000);

// ─────────────────────────  COMMAND LOADER  ──────────────────────────
function loadCommands() {
  const dir = path.resolve('./commands');
  const files = fs.readdirSync(dir).filter(f => f.endsWith('.js'));
  const list = [];
  for (const f of files) {
    const cmd = require(path.join(dir, f));
    if (!cmd?.data || !cmd?.execute) {
      warn(`Skipping invalid command file ${f}`);
      continue;
    }
    client.commands.set(cmd.data.name, cmd);
    list.push(cmd.data.toJSON());
    log('Loaded command', cmd.data.name);
  }
  return list;
}

async function registerCommands(list) {
  const rest = new REST({ version: '10' }).setToken(DISCORD_TOKEN);
  const route = GUILD_ID
    ? Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID)
    : Routes.applicationCommands(CLIENT_ID);
  await rest.put(route, { body: list });
  console.log(`✅ Registered ${list.length} slash commands ${GUILD_ID ? 'in guild' : 'globally'}`);
}

// ────────────────────────  INTERACTION HANDLER  ──────────────────────
client.on('interactionCreate', async interaction => {
  if (!interaction.isChatInputCommand()) return;
  const cmd = client.commands.get(interaction.commandName);
  if (!cmd) return;

  // Cool‑down (per command per user)
  const key = `${interaction.user.id}:${cmd.data.name}`;
  const now = Date.now();
  const cooldown = client.cooldowns.get(key);
  if (cooldown && (now - cooldown) < (cmd.cooldown || 3_000)) {
    return interaction.reply({ content: '⏳ Cool‑down … try again shortly.', ephemeral: true });
  }
  client.cooldowns.set(key, now);

  try {
    await cmd.execute(interaction, db, {
      VERIFIED_ROLE_ID,
      UNIVERSE_ID,
      OC_KEY,
      GUILD_ID,
    });
  } catch (err) {
    console.error('❌ Command error', err);
    if (interaction.replied || interaction.deferred) {
      interaction.followUp({ content: '⚠️ An internal error occurred.', ephemeral: true });
    } else {
      interaction.reply({ content: '⚠️ An internal error occurred.', ephemeral: true });
    }
  }
});

// ─────────────────────────  VERIFY VIA ✅ REACTION  ───────────────────
client.on('messageReactionAdd', async (reaction, user) => {
  if (user.bot || reaction.emoji.name !== '✅') return;
  if (reaction.partial) await reaction.fetch();
  log('ReactionAdd by', user.username);

  db.get('SELECT * FROM links WHERE discord=?', [user.id], async (err, row) => {
    if (err) return console.error('DB fetch error', err);
    if (!row || row.verified) return;

    /* 1 · Roblox profile check */
    try {
      const { data: profile } = await axios.get(`https://users.roblox.com/v1/users/${row.roblox}`);
      if (!profile?.description?.includes(row.code)) {
        return user.send('❌ Code not found – save it in your profile and react again.');
      }

      /* 2 · Mark verified */
      db.run('UPDATE links SET verified=1 WHERE discord=?', [user.id]);
      await user.send('✅ Linked! You may now remove the code.');

      /* 3 · Give discord role */
      if (VERIFIED_ROLE_ID) {
        const guild  = await client.guilds.fetch(GUILD_ID);
        const member = await guild.members.fetch(user.id).catch(() => null);
        member?.roles.add(VERIFIED_ROLE_ID).catch(console.error);
      }

      /* 4 · Fetch game stats (OpenCloud optional) */
      if (UNIVERSE_ID && OC_KEY) {
        try {
          const entryKey = `Player_${row.roblox}`;
          const { data } = await axios.get(
            `https://apis.roblox.com/datastores/v1/universes/${UNIVERSE_ID}/standard-datastores/datastore/entries/entry`,
            {
              params: { datastoreName: 'MainDataStore', entryKey },
              headers: { 'x-api-key': OC_KEY },
            },
          );
          const json = JSON.parse(data?.data ?? '{}');
          const lvl  = json?.PlayerData?.Progress?.Level   ?? '?';
          const sts  = json?.PlayerData?.Progress?.Statues ?? '?';
          await user.send(`📊 Monkey Level **${lvl}** · Statues **${sts}/42**`);
        } catch (e) {
          warn('OpenCloud fetch failed', e.response?.status);
        }
      }
    } catch (e) {
      console.error('Verification step failed', e);
      user.send('⚠️ Verification failed, please try again later.');
    }
  });
});

// ─────────────────────────────  EXPRESS  ─────────────────────────────
const app = express();
app.get('/', (_, res) => res.send('OK'));
app.get('/healthz', (_, res) => res.json({ ok: true, ts: Date.now() }));
app.get('/stats',  (_, res) => {
  const mem = process.memoryUsage();
  res.json({
    rss:       mem.rss,
    heapTotal: mem.heapTotal,
    heapUsed:  mem.heapUsed,
    uptime:    process.uptime(),
  });
});

app.listen(PORT, () => console.log(`🌐 Express keep‑alive on :${PORT}`));
setInterval(() => log('⏳ still alive', new Date().toISOString()), 60_000);

// ───────────────────────── ERROR HANDLERS ────────────────────────────
process.on('unhandledRejection', err => console.error('💥 Unhandled promise rejection', err));
process.on('uncaughtException',  err => console.error('💥 Uncaught exception', err));

// ─────────────────────────────  BOOT  ────────────────────────────────
(async () => {
  try {
    const commandList = loadCommands();
    await registerCommands(commandList);
    await client.login(DISCORD_TOKEN);
  } catch (err) {
    console.error('Fatal startup error', err);
    process.exit(1);
  }
})();

/*────────── 7 · Boot ──────────*/
client.once('ready', async () => {
  console.log(`🤖 Logged in as ${client.user.tag}`);
  await registerCommands();
});

client.login(DISCORD_TOKEN);
