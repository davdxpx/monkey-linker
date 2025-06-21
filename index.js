// ╔═══════════════════════════════════════════════════════════════════╗
// ║  index.js – Monkey Linker Bot · FINAL                            ║
// ║  Discord ⇆ Roblox account linking & event commands               ║
// ║                                                                 ║
// ║  ▸ Dual DB‑Backend                                               ║
// ║      • SQLite  (zero‑config fallback)                            ║
// ║      • MongoDB (multi‑cluster, see db/mongo.js)                  ║
// ║  ▸ Slash‑command autoloader & hot‑reload                         ║
// ║  ▸ Robust interaction & reaction verification flow               ║
// ║  ▸ Optional Roblox OpenCloud stats DM                            ║
// ║  ▸ Express keep‑alive + /healthz + /stats                        ║
// ║                                                                 ║
// ║  © StillBrokeStudios 2025 – Author @davdxpx                      ║
// ╚═══════════════════════════════════════════════════════════════════╝

// ───────────────────────────── CONFIG ─────────────────────────────
require('dotenv').config();
const {
  DISCORD_TOKEN,
  CLIENT_ID,
  GUILD_ID,
  VERIFIED_ROLE_ID,
  ADMIN_ROLES          = '',              // comma‑separated names or IDs

  // DB selection
  DB_PATH              = './links.db',
  MONGO_DB_NAME,
  MONGO_URI_1,
  MONGO_URI_2,
  MONGO_URI_3,
  MONGO_URI_4,

  // Roblox OpenCloud (optional)
  UNIVERSE_ID,
  OC_KEY,

  // Runtime / Hosting
  PORT                 = 8080,
  KEEPALIVE_URL,

  // Debug flags
  DEBUG_LINKER         = '0',
  DEBUG_MONGO          = '0',
} = process.env;

const DBG  = DEBUG_LINKER === '1';
const log  = (...m) => DBG && console.log('[DBG]', ...m);
const warn = (...m) => console.warn('[WARN]', ...m);

// ─────────────────────────── DEPENDENCIES ───────────────────────────
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

// ────────────────────────────── CLIENT ──────────────────────────────
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

client.commands  = new Collection();
client.cooldowns = new Collection();

// ──────────────────────── DB BACKEND SELECTION ──────────────────────
let linkStore; // unified CRUD interface used throughout the bot

function wrapSql(db) {
  const get = (q, p=[]) => new Promise((res, rej) => db.get(q, p, (e,r)=>e?rej(e):res(r)));
  const run = (q, p=[]) => new Promise((res, rej) => db.run(q, p, e=>e?rej(e):res()));
  return { get, run };
}

async function initSqlite() {
  return new Promise((resolve, reject) => {
    const db = new sqlite3.Database(DB_PATH, err => {
      if (err) return reject(err);
      log('SQLite open', DB_PATH);
    });
    db.exec(`CREATE TABLE IF NOT EXISTS links (
      discord   TEXT    PRIMARY KEY,
      roblox    INTEGER UNIQUE NOT NULL,
      code      TEXT,
      attempts  INTEGER DEFAULT 0,
      verified  INTEGER DEFAULT 0,
      created   INTEGER DEFAULT (strftime('%s','now'))
    )`, err => err && warn('DB init error', err));

    const sql = wrapSql(db);

    const api = {
      get:        discord => sql.get('SELECT * FROM links WHERE discord=?', [discord]),
      getByRb:    roblox  => sql.get('SELECT * FROM links WHERE roblox=?',  [roblox]),
      upsertLink: ({ discord, roblox, code, attempts=0 }) => sql.run(
        'INSERT OR REPLACE INTO links (discord, roblox, code, attempts, verified, created) VALUES (?,?,?,?,0,strftime("%s","now"))',
        [discord, roblox, code, attempts],
      ),
      setAttempts: (discord, attempts) => sql.run('UPDATE links SET attempts=? WHERE discord=?', [attempts, discord]),
      verify:     discord => sql.run('UPDATE links SET verified=1 WHERE discord=?', [discord]),
      cleanupExpired: seconds => sql.run(
        'DELETE FROM links WHERE verified=0 AND (strftime("%s","now")-created) > ?',
        [seconds],
      ),
    };

    // periodic cleanup (15 min default)
    setInterval(() => api.cleanupExpired(900).catch(()=>{}), 5 * 60_000);
    resolve(api);
  });
}

async function initMongoBackend() {
  const { initMongo } = require('./db/mongo');
  const mongo = await initMongo({
    MONGO_DB_NAME,
    MONGO_URI_1, MONGO_URI_2, MONGO_URI_3, MONGO_URI_4,
    debug: DEBUG_MONGO === '1',
  });
  return mongo.links; // links API exposed by db/mongo.js
}

async function selectBackend() {
  if (MONGO_URI_1 && MONGO_DB_NAME) {
    log('Using MongoDB backend');
    try { return await initMongoBackend(); }
    catch (e) { console.error('❌ Mongo init failed, falling back to SQLite', e); }
  }
  log('Using SQLite backend');
  return await initSqlite();
}

// ────────────────────────── COMMAND LOADER ──────────────────────────
function loadCommands() {
  const dir = path.resolve('./commands');
  const files = fs.readdirSync(dir).filter(f => f.endsWith('.js'));
  const list = [];
  for (const f of files) {
    delete require.cache[require.resolve(path.join(dir, f))]; // hot‑reload support
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

// ────────────────────────── INTERACTIONS ────────────────────────────
client.on('interactionCreate', async interaction => {
  if (!interaction.isChatInputCommand()) return;
  const cmd = client.commands.get(interaction.commandName);
  if (!cmd) return;

  // per‑command / per‑user cooldown
  const key = `${interaction.user.id}:${cmd.data.name}`;
  const now = Date.now();
  const cooldown = client.cooldowns.get(key);
  if (cooldown && (now - cooldown) < (cmd.cooldown || 3_000))
    return interaction.reply({ content: '⏳ Cool‑down … try again shortly.', ephemeral: true });
  client.cooldowns.set(key, now);

  try {
    await cmd.execute(interaction, linkStore, {
      VERIFIED_ROLE_ID,
      ADMIN_ROLES,
      UNIVERSE_ID,
      OC_KEY,
      GUILD_ID,
    });
  } catch (err) {
    console.error('❌ Command error', err);
    const fn = (interaction.replied || interaction.deferred) ? interaction.followUp.bind(interaction)
                                                            : interaction.reply.bind(interaction);
    fn({ content: '⚠️ Internal error occurred.', ephemeral: true }).catch(()=>{});
  }
});

// ────────────── VERIFY BY ✅ REACTION  (ROBLOX PROFILE) ─────────────
client.on('messageReactionAdd', async (reaction, user) => {
  if (user.bot || reaction.emoji.name !== '✅') return;
  if (reaction.partial) await reaction.fetch();

  try {
    const row = await linkStore.get(user.id);
    if (!row || row.verified) return;

    const { data: profile } = await axios.get(`https://users.roblox.com/v1/users/${row.roblox}`);
    if (!profile?.description?.includes(row.code))
      return user.send('❌ Code not found – save it in your profile and react again.');

    await linkStore.verify(user.id);
    await user.send('✅ Linked! You may now remove the code.');

    if (VERIFIED_ROLE_ID) {
      const guild  = await client.guilds.fetch(GUILD_ID);
      const member = await guild.members.fetch(user.id).catch(() => null);
      member?.roles.add(VERIFIED_ROLE_ID).catch(console.error);
    }

    // Optional OpenCloud stats DM
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
        const lvl = json?.PlayerData?.Progress?.Level   ?? '?';
        const sts = json?.PlayerData?.Progress?.Statues ?? '?';
        await user.send(`📊 Monkey Level **${lvl}** · Statues **${sts}/42**`);
      } catch (e) {
        warn('OpenCloud fetch failed', e.response?.status);
      }
    }
  } catch (err) {
    console.error('Verification flow error', err);
    user.send('⚠️ Verification failed, please try again later.');
  }
});

// ───────────────────────────── EXPRESS ─────────────────────────────
const app = express();
app.get('/',       (_, res) => res.send('OK'));
app.get('/healthz',(_, res) => res.json({ ok: true, ts: Date.now() }));
app.get('/stats',  (_, res) => {
  const m = process.memoryUsage();
  res.json({ rss: m.rss, heap: m.heapUsed, uptime: process.uptime() });
});
app.listen(PORT, () => console.log(`🌐 Express keep‑alive on :${PORT}`));

if (KEEPALIVE_URL) setInterval(() => axios.get(KEEPALIVE_URL).catch(()=>{}), 5 * 60_000);

// ─────────────────── GLOBAL ERROR HANDLERS ─────────────────────────
process.on('unhandledRejection', err => console.error('💥 Unhandled promise rejection', err));
process.on('uncaughtException' , err => console.error('💥 Uncaught exception', err));

// ─────────────────────────── BOOTSTRAP ────────────────────────────
(async () => {
  try {
    linkStore = await selectBackend();
    const commandList = loadCommands();

    client.once('ready', async () => {
      console.log(`🤖 Logged in as ${client.user.tag}`);
      try { await registerCommands(commandList); }
      catch (e) { console.error('Failed registering commands', e); }
    });

    await client.login(DISCORD_TOKEN);
  } catch (e) {
    console.error('Fatal startup error', e);
    process.exit(1);
  }
})();
