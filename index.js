// ╔═══════════════════════════════════════════════════════════════════╗
// ║  index.js – Monkey Linker Bot · FINAL LTS                        ║
// ║  Discord ⇆ Roblox account linking & event commands               ║
// ║                                                                 ║
// ║  ▸ Dual DB‑Backend (SQLite ⟷ Mongo multi‑cluster)                ║
// ║  ▸ Slash‑command autoloader & hot‑reload                         ║
// ║  ▸ Robust interaction / reaction verification flow               ║
// ║  ▸ Optional Roblox OpenCloud stats DM                            ║
// ║  ▸ Express keep‑alive (+ /healthz /stats) & self‑ping            ║
// ║                                                                 ║
// ║  StillBrokeStudios © 2025 · Author @davdxpx                      ║
// ╚═══════════════════════════════════════════════════════════════════╝

//-------------------------------------------------------------------
// 1 · ENV & CONFIG
//-------------------------------------------------------------------
require('dotenv').config();
const {
  DISCORD_TOKEN,
  CLIENT_ID,
  GUILD_ID,
  VERIFIED_ROLE_ID,
  ADMIN_ROLES = '',

  // DB backend
  DB_PATH = './links.db',
  MONGO_DB_NAME,
  MONGO_URI_1,
  MONGO_URI_2,
  MONGO_URI_3,
  MONGO_URI_4,

  // Roblox OpenCloud
  UNIVERSE_ID,
  OC_KEY,

  // Hosting
  PORT = 8080,
  KEEPALIVE_URL,

  // Debug
  DEBUG_LINKER = '0',
  DEBUG_MONGO  = '0',
} = process.env;

const DBG  = DEBUG_LINKER === '1';
const log  = (...m) => DBG && console.log('[DBG]', ...m);
const warn = (...m) => console.warn('[WARN]', ...m);

//-------------------------------------------------------------------
// 2 · DEPENDENCIES
//-------------------------------------------------------------------
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

//-------------------------------------------------------------------
// 3 · CLIENT SETUP
//-------------------------------------------------------------------
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

//-------------------------------------------------------------------
// 4 · BACKEND IMPLEMENTATIONS
//-------------------------------------------------------------------
function wrapSql(db) {
  const get = (q, p=[]) => new Promise((res, rej) => db.get(q, p, (e,r)=>e?rej(e):res(r)));
  const run = (q, p=[]) => new Promise((res, rej) => db.run(q, p, e=>e?rej(e):res()));
  return { get, run };
}

async function initSqlite() {
  return new Promise((resolve, reject) => {
    const db = new sqlite3.Database(DB_PATH, err => err ? reject(err) : log('SQLite opened:', DB_PATH));

    db.exec(`CREATE TABLE IF NOT EXISTS links (
      discord   TEXT    PRIMARY KEY,
      roblox    INTEGER UNIQUE NOT NULL,
      code      TEXT,
      attempts  INTEGER DEFAULT 0,
      verified  INTEGER DEFAULT 0,
      created   INTEGER DEFAULT (strftime('%s','now'))
    )`, err => err && warn('SQLite init', err));

    const sql = wrapSql(db);
    const api = {
      get:        d => sql.get('SELECT * FROM links WHERE discord=?', [d]),
      getByRb:    r => sql.get('SELECT * FROM links WHERE roblox=?',  [r]),
      upsertLink: ({ discord, roblox, code, attempts=0 }) => sql.run(
        'INSERT OR REPLACE INTO links (discord, roblox, code, attempts, verified, created) VALUES (?,?,?,?,0,strftime("%s","now"))',
        [discord, roblox, code, attempts],
      ),
      setAttempts: (d,a) => sql.run('UPDATE links SET attempts=? WHERE discord=?', [a,d]),
      verify:     d => sql.run('UPDATE links SET verified=1 WHERE discord=?', [d]),
      cleanupExpired: s => sql.run('DELETE FROM links WHERE verified=0 AND (strftime("%s","now")-created) > ?', [s]),
    };
    setInterval(() => api.cleanupExpired(900).catch(()=>{}), 5*60_000);
    resolve(api);
  });
}

async function initMongoBackend() {
  const { initMongo } = require('./db/mongo');
  return (await initMongo({
    MONGO_DB_NAME,
    MONGO_URI_1, MONGO_URI_2, MONGO_URI_3, MONGO_URI_4,
    debug: DEBUG_MONGO === '1',
  })).links;
}

async function selectBackend() {
  if (MONGO_URI_1 && MONGO_DB_NAME) {
    try {
      log('Mongo backend enabled');
      return await initMongoBackend();
    } catch (e) {
      console.error('❌ Mongo init failed, falling back to SQLite', e.message);
    }
  }
  log('SQLite backend in use');
  return await initSqlite();
}

//-------------------------------------------------------------------
// 5 · COMMAND LOADING + REGISTRATION
//-------------------------------------------------------------------
function loadCommands() {
  const files = fs.readdirSync('./commands').filter(f => f.endsWith('.js'));
  const list = [];
  for (const f of files) {
    const filePath = path.join(__dirname, 'commands', f);
    delete require.cache[require.resolve(filePath)];
    const cmd = require(filePath);
    if (!cmd?.data || !cmd?.execute) { warn('Invalid command', f); continue; }
    client.commands.set(cmd.data.name, cmd);
    list.push(cmd.data.toJSON());
    log('Command loaded', cmd.data.name);
  }
  return list;
}

async function registerCommands(list) {
  const rest  = new REST({ version: '10' }).setToken(DISCORD_TOKEN);
  const route = GUILD_ID
    ? Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID)
    : Routes.applicationCommands(CLIENT_ID);
  await rest.put(route, { body: list });
  console.log(`✅ Registered ${list.length} slash commands ${GUILD_ID ? 'in guild' : 'globally'}`);
}

//-------------------------------------------------------------------
// 6 · INTERACTION HANDLER
//-------------------------------------------------------------------
client.on('interactionCreate', async interaction => {
  if (!interaction.isChatInputCommand()) return;
  const cmd = client.commands.get(interaction.commandName);
  if (!cmd) return;

  // simple per‑command cooldown (3 s default)
  const key = `${interaction.user.id}:${cmd.data.name}`;
  if (client.cooldowns.has(key)) {
    const diff = Date.now() - client.cooldowns.get(key);
    if (diff < (cmd.cooldown || 3000)) {
      return interaction.reply({ content: '⏳ Cool‑down … try again shortly.', ephemeral: true });
    }
  }
  client.cooldowns.set(key, Date.now());

  try {
    await cmd.execute(interaction, linkStore, {
      VERIFIED_ROLE_ID,
      ADMIN_ROLES,
      UNIVERSE_ID,
      OC_KEY,
      GUILD_ID,
    });
  } catch (err) {
    console.error('Cmd error', err);
    const respond = interaction.replied || interaction.deferred
      ? interaction.followUp.bind(interaction)
      : interaction.reply.bind(interaction);
    respond({ content: '⚠️ Internal error', ephemeral: true }).catch(()=>{});
  }
});

//-------------------------------------------------------------------
// 7 · ✅ REACTION VERIFIER
//-------------------------------------------------------------------
client.on('messageReactionAdd', async (reaction, user) => {
  if (user.bot || reaction.emoji.name !== '✅') return;
  if (reaction.partial) await reaction.fetch();
  try {
    const row = await linkStore.get(user.id);
    if (!row || row.verified) return;

    const { data: profile } = await axios.get(`https://users.roblox.com/v1/users/${row.roblox}`);
    if (!profile?.description?.includes(row.code))
      return user.send('❌ Code not found – paste into your Roblox bio and react again.');

    await linkStore.verify(user.id);
    await user.send('✅ Linked! You may remove the code.');

    if (VERIFIED_ROLE_ID) {
      const guild = await client.guilds.fetch(GUILD_ID);
      const member = await guild.members.fetch(user.id).catch(()=>null);
      member?.roles.add(VERIFIED_ROLE_ID).catch(console.error);
    }

    if (UNIVERSE_ID && OC_KEY) {
      try {
        const entryKey = `Player_${row.roblox}`;
        const { data } = await axios.get(
          `https://apis.roblox.com/datastores/v1/universes/${UNIVERSE_ID}/standard-datastores/datastore/entries/entry`,
          { params: { datastoreName: 'MainDataStore', entryKey }, headers: { 'x-api-key': OC_KEY } }
        );
        const js = JSON.parse(data?.data ?? '{}');
        const lvl = js?.PlayerData?.Progress?.Level ?? '?';
        const st  = js?.PlayerData?.Progress?.Statues ?? '?';
        await user.send(`📊 Level **${lvl}** · Statues **${st}/42**`);
      } catch (e) { warn('OpenCloud', e.response?.status); }
    }
  } catch (e) {
    console.error('Verify flow', e);
    user.send('⚠️ Verification failed.');
  }
});

//-------------------------------------------------------------------
// 8 · EXPRESS KEEP‑ALIVE
//-------------------------------------------------------------------
const app = express();
app.get('/',        (_, r) => r.send('OK'));
app.get('/healthz', (_, r) => r.json({ ok: true, ts: Date.now() }));
app.get('/stats',   (_, r) => {
  const m = process.memoryUsage();
  r.json({ rss: m.rss, heap: m.heapUsed, uptime: process.uptime() });
});
app.listen(PORT, () => console.log(`🌐 Express keep‑alive on :${PORT}`));
if (KEEPALIVE_URL) setInterval(() => axios.get(KEEPALIVE_URL).catch(()=>{}), 5*60_000);

//-------------------------------------------------------------------
// 9 · GLOBAL ERROR HANDLERS
//-------------------------------------------------------------------
process.on('unhandledRejection', e => console.error('UnhandledRejection', e));
process.on('uncaughtException' , e => console.error('UncaughtException', e));

//-------------------------------------------------------------------
// 10 · BOOTSTRAP
//-------------------------------------------------------------------
(async () => {
  try {
    // 1) Backend wählen und initialisieren
    linkStore = await selectBackend();

    // 2) Commands von der Disk laden
    const cmdList = loadCommands();

    // 3) Discord-Client fertig → Slash-Commands registrieren
    client.once('ready', async () => {
      console.log(`🤖 Logged in as ${client.user.tag}`);
      try {
        await registerCommands(cmdList);
      } catch (e) {
        console.error('🔴 Failed to register commands', e);
      }
    });

    // 4) Login bei Discord
    await client.login(DISCORD_TOKEN);
  } catch (fatal) {
    console.error('💀 Fatal startup error – shutting down', fatal);
    process.exit(1);
  }
})();
