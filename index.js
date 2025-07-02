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
  EmbedBuilder, // Already added, but ensure it's here
} = require('discord.js');
const { migrateEventsJsonToDb, EVENTS_JSON_PATH } = require('./utils/migrateEvents.js');

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
// ─── globale Variable ───────────────────────
let linkStore;
const reactionCache = new Map();

//-------------------------------------------------------------------
// 4 · BACKEND IMPLEMENTATIONS
//-------------------------------------------------------------------
const DBSYNC_INT_SEC = 5 * 60;            // ⏰ SQLite-Cleanup alle 5 Minuten
const MONGO_TIMEOUT  = 8_000;             // ⏰ 8 s – danach Fallback auf SQLite

function wrapSql(db) {
  const get = (q, p = []) => new Promise((res, rej) =>
    db.get(q, p, (e, r) => (e ? rej(e) : res(r))));
  const run = (q, p = []) => new Promise((res, rej) =>
    db.run(q, p, e => (e ? rej(e) : res())));
  return { get, run };
}

// ─────────────────────────── SQLite ──────────────────────────────
async function initSqlite(DB_PATH = './links.db') {
  return new Promise((resolve, reject) => {
    const db = new sqlite3.Database(
      DB_PATH,
      err => err ? reject(err) : console.log('🗄️  SQLite opened:', DB_PATH)
    );

    db.serialize(() => { // Serialize to ensure statements run in order
      db.exec(`CREATE TABLE IF NOT EXISTS links (
        discord      TEXT PRIMARY KEY,
        roblox       INTEGER UNIQUE NOT NULL,
        code         TEXT,
        attempts     INTEGER DEFAULT 0,
        lastAttempt  INTEGER DEFAULT 0,
        verified     INTEGER DEFAULT 0,
        created      INTEGER DEFAULT (strftime('%s','now'))
      );`);

      // New Event System Tables
      db.exec(`CREATE TABLE IF NOT EXISTS events (
          event_id INTEGER PRIMARY KEY AUTOINCREMENT,
          title TEXT NOT NULL,
          description TEXT,
          creator_discord_id TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT 'draft', -- draft, published, archived, cancelled, active
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          start_at INTEGER NOT NULL,
          end_at INTEGER,
          island_name TEXT,
          area_name TEXT,
          image_main_url TEXT,
          image_thumbnail_url TEXT,
          capacity INTEGER DEFAULT 0,
          rsvp_count_going INTEGER DEFAULT 0,
          rsvp_count_interested INTEGER DEFAULT 0,
          announcement_message_id TEXT,
          announcement_channel_id TEXT,
          is_recurring INTEGER DEFAULT 0,
          recurrence_rule TEXT,
          template_name TEXT
      );`);

      db.exec(`CREATE TABLE IF NOT EXISTS event_rsvps (
          rsvp_id INTEGER PRIMARY KEY AUTOINCREMENT,
          event_id INTEGER NOT NULL,
          user_discord_id TEXT NOT NULL,
          rsvp_status TEXT NOT NULL, -- 'going', 'interested', 'waitlisted', 'cancelled_rsvp'
          rsvp_at INTEGER NOT NULL,
          FOREIGN KEY (event_id) REFERENCES events(event_id) ON DELETE CASCADE
      );`);

      db.exec(`CREATE TABLE IF NOT EXISTS event_custom_fields (
          custom_field_id INTEGER PRIMARY KEY AUTOINCREMENT,
          event_id INTEGER NOT NULL,
          field_name TEXT NOT NULL,
          field_value TEXT NOT NULL,
          display_order INTEGER DEFAULT 0,
          FOREIGN KEY (event_id) REFERENCES events(event_id) ON DELETE CASCADE
      );`);

      db.exec(`CREATE TABLE IF NOT EXISTS event_templates (
          template_id INTEGER PRIMARY KEY AUTOINCREMENT,
          template_name TEXT NOT NULL UNIQUE,
          creator_discord_id TEXT NOT NULL,
          created_at INTEGER NOT NULL,
          event_data TEXT NOT NULL -- JSON string
      );`);

      // Indexes for events
      db.exec(`CREATE INDEX IF NOT EXISTS idx_events_status ON events(status);`);
      db.exec(`CREATE INDEX IF NOT EXISTS idx_events_start_at ON events(start_at);`);
      db.exec(`CREATE INDEX IF NOT EXISTS idx_event_rsvps_event_id ON event_rsvps(event_id);`);
      db.exec(`CREATE INDEX IF NOT EXISTS idx_event_rsvps_user_id ON event_rsvps(user_discord_id);`);
      db.exec(`CREATE INDEX IF NOT EXISTS idx_event_custom_fields_event_id ON event_custom_fields(event_id);`);
    });

    const sql = wrapSql(db);

    // Define the linkStore API methods
    const linkStoreApi = {
      // Link methods
      get:            d => sql.get('SELECT * FROM links WHERE discord=?', [d]),
      getByRb:        r => sql.get('SELECT * FROM links WHERE roblox=?',  [r]),
      upsert: ({ discord, roblox, code, attempts = 0, lastAttempt = 0, verified = 0 }) =>
        sql.run(
          `INSERT OR REPLACE INTO links
           (discord, roblox, code, attempts, lastAttempt, verified, created)
           VALUES (?,?,?,?,?,?,strftime('%s','now'))`,
          [discord, roblox, code, attempts, lastAttempt, verified]
        ),
      remove:    d => sql.run('DELETE FROM links WHERE discord=?', [d]),
      setAttempts:   (d, a, ts) => ts
        ? sql.run('UPDATE links SET attempts=?, lastAttempt=? WHERE discord=?', [a, ts, d])
        : sql.run('UPDATE links SET attempts=? WHERE discord=?', [a, d]),
      verify:        d      => sql.run('UPDATE links SET verified=1 WHERE discord=?', [d]),
      cleanupExpired:s      => sql.run(
        'DELETE FROM links WHERE verified=0 AND (strftime("%s","now")-created) > ?',
        [s]
      ),

      // Event methods (SQLite implementations)
      createEvent: (eventData) => {
        const { title, description, creator_discord_id, status = 'draft', created_at, updated_at, start_at, end_at, island_name, area_name, image_main_url, image_thumbnail_url, capacity = 0 } = eventData;
        return sql.run(
          `INSERT INTO events (title, description, creator_discord_id, status, created_at, updated_at, start_at, end_at, island_name, area_name, image_main_url, image_thumbnail_url, capacity)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [title, description, creator_discord_id, status, created_at, updated_at, start_at, end_at, island_name, area_name, image_main_url, image_thumbnail_url, capacity]
        ).then(function() { return this.lastID; }); // Return the last inserted ID
      },
      getEventById: (eventId) => sql.get('SELECT * FROM events WHERE event_id = ?', [eventId]),
      getPublishedEvents: (limit = 25) => sql.all('SELECT * FROM events WHERE status = ? ORDER BY start_at ASC LIMIT ?', ['published', limit]),
      updateEventStatus: (eventId, status, updated_at) => sql.run('UPDATE events SET status = ?, updated_at = ? WHERE event_id = ?', [status, updated_at, eventId]),
      deleteEvent: (eventId) => sql.run('DELETE FROM events WHERE event_id = ?', [eventId]),
      updateEvent: (eventId, eventData) => {
        // Construct SET clause dynamically for flexibility, ensure updated_at is always set
        const fields = Object.keys(eventData).filter(k => k !== 'event_id'); // Don't update event_id
        if (fields.length === 0) return Promise.resolve();
        const setClause = fields.map(field => `${field} = ?`).join(', ');
        const values = fields.map(field => eventData[field]);
        values.push(Math.floor(Date.now() / 1000)); // updated_at
        values.push(eventId);
        return sql.run(`UPDATE events SET ${setClause}, updated_at = ? WHERE event_id = ?`, values);
      },
      // Placeholder for RSVP methods - to be implemented in Phase 2
      addRsvp: (eventId, userId, rsvpStatus) => { /* ... */ },
      getRsvpsForEvent: (eventId) => { /* ... */ },
    };

    // ⏰ Periodische Bereinigung: nicht verifizierte Links nach 15 min löschen
    setInterval(() => linkStoreApi.cleanupExpired(900).catch(() => {}),
                DBSYNC_INT_SEC * 1_000);

    // Pass the raw db object for migration before resolving with the API
    resolve({ db, api: linkStoreApi, dbType: 'sqlite' });
  });
}

// ─────────────────────────── MongoDB ─────────────────────────────
async function initMongoBackend(cfg) {
  const { MongoClient } = require('mongodb');
  const uri = [cfg.MONGO_URI_1, cfg.MONGO_URI_2, cfg.MONGO_URI_3, cfg.MONGO_URI_4]
    .filter(Boolean)[0];

  const client = new MongoClient(uri, {
    connectTimeoutMS: MONGO_TIMEOUT, socketTimeoutMS: MONGO_TIMEOUT,
    serverSelectionTimeoutMS: MONGO_TIMEOUT,
  });

  await client.connect();
  console.log('🍃  Mongo connected');

  const db = client.db(cfg.MONGO_DB_NAME);
  const linksCol = db.collection('links');

  // Ensure indexes for new event collections in MongoDB
  const eventsCol = db.collection('events');
  await eventsCol.createIndex({ status: 1 });
  await eventsCol.createIndex({ start_at: 1 });

  const eventRsvpsCol = db.collection('event_rsvps');
  await eventRsvpsCol.createIndex({ event_id: 1 });
  await eventRsvpsCol.createIndex({ user_discord_id: 1 });

  const eventCustomFieldsCol = db.collection('event_custom_fields');
  await eventCustomFieldsCol.createIndex({ event_id: 1 });

  const eventTemplatesCol = db.collection('event_templates');
  await eventTemplatesCol.createIndex({ template_name: 1 }, { unique: true });

  // Note: The linkStore API will need to be expanded to handle these new collections/tables.
  const mongoApi = {
    // Link methods
    get:       d => linksCol.findOne({ discord: d }),
    getByRb:   r => linksCol.findOne({ roblox: r }),
    upsert:    row => linksCol.updateOne({ discord: row.discord }, { $set: row }, { upsert: true }),
    remove:    d => linksCol.deleteOne({ discord: d }),
    setAttempts:(d, a, ts) => {
      const upd = { attempts: a };
      if (ts) upd.lastAttempt = ts;
      return linksCol.updateOne({ discord: d }, { $set: upd });
    },
    verify:    d => linksCol.updateOne({ discord: d }, { $set: { verified: 1 } }),
    cleanupExpired: s =>
      linksCol.deleteMany({ verified: 0, created: { $lt: Math.floor(Date.now() / 1000) - s } }),

    // Event methods (MongoDB implementations)
    createEvent: async (eventData) => {
      const result = await eventsCol.insertOne(eventData);
      return result.insertedId;
    },
    getEventById: (eventId) => eventsCol.findOne({ _id: eventId }), // Assuming eventId is ObjectId for Mongo
    getPublishedEvents: (limit = 25) => eventsCol.find({ status: 'published' }).sort({ start_at: 1 }).limit(limit).toArray(),
    updateEventStatus: (eventId, status, updated_at) => eventsCol.updateOne({ _id: eventId }, { $set: { status, updated_at } }),
    deleteEvent: (eventId) => eventsCol.deleteOne({ _id: eventId }),
    updateEvent: (eventId, eventData) => {
        const updatePayload = { ...eventData };
        delete updatePayload._id; // Cannot update _id
        updatePayload.updated_at = Math.floor(Date.now() / 1000);
        return eventsCol.updateOne({ _id: eventId }, { $set: updatePayload });
    },
    // Placeholder for RSVP methods
    addRsvp: (eventId, userId, rsvpStatus) => { /* ... */ },
    getRsvpsForEvent: (eventId) => { /* ... */ },
  };
  return { db, api: mongoApi, dbType: 'mongo' };
}

// ───────────────────────── Backend-Chooser ───────────────────────
async function selectBackend() {
  const  {
    MONGO_DB_NAME, MONGO_URI_1, MONGO_URI_2, MONGO_URI_3, MONGO_URI_4,
    DEBUG_MONGO
  } = process.env;

  if (MONGO_URI_1 && MONGO_DB_NAME) {
    try {
      console.log('🔍  Trying Mongo backend …');
      return await initMongoBackend({
        MONGO_DB_NAME, MONGO_URI_1, MONGO_URI_2, MONGO_URI_3, MONGO_URI_4,
        debug: DEBUG_MONGO === '1'
      });
    } catch (e) {
      console.error('❌  Mongo init failed – falling back to SQLite:', e.message);
    }
  }

  console.log('🗄️  Falling back to SQLite');
  return await initSqlite(process.env.DB_PATH || './links.db');
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
  // Handle Modal Submissions for Event Creation
  if (interaction.isModalSubmit() && interaction.customId === 'eventCreateModal') {
    try {
      // Defer update as interaction was already deferred by the /events create command
      // await interaction.deferUpdate(); // or deferReply({ephemeral: true}) if the initial defer was not done

      const title = interaction.fields.getTextInputValue('eventTitle');
      const description = interaction.fields.getTextInputValue('eventDescription');
      const dateStr = interaction.fields.getTextInputValue('eventDate');
      const timeStr = interaction.fields.getTextInputValue('eventTime');
      const imageMainUrl = interaction.fields.getTextInputValue('eventImageMainUrl') || null;

      // TODO: Add island/area selection logic. For now, placeholders.
      // This would typically involve another interaction step (select menu) after modal,
      // or more fields in the modal if simple enough.
      // For Phase 1 initial, we'll make them optional or have defaults.
      const island_name = null; // Placeholder - to be properly implemented
      const area_name = null;   // Placeholder

      // Validate date and time (basic)
      if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr) || !/^\d{2}:\d{2}$/.test(timeStr)) {
        return interaction.followUp({ content: 'Invalid date or time format. Please use YYYY-MM-DD and HH:MM (UTC).', ephemeral: true });
      }
      const start_at = Math.floor(new Date(`${dateStr}T${timeStr}:00.000Z`).getTime() / 1000); // Assume UTC
      const now = Math.floor(Date.now() / 1000);

      const eventData = {
        title,
        description,
        creator_discord_id: interaction.user.id,
        status: 'draft',
        created_at: now,
        updated_at: now,
        start_at,
        island_name, // From future selection
        area_name,   // From future selection
        image_main_url: imageMainUrl,
        capacity: 0, // Default, can be updated via /edit
      };

      const eventId = await linkStore.createEvent(eventData);
      const successEmbed = new EmbedBuilder()
        .setColor(0x4CAF50) // SUCCESS_COLOR
        .setTitle('🎉 Event Draft Created!')
        .setDescription(`Your event draft "**${title}**" has been created with ID #${eventId}.`)
        .addFields({ name: 'Next Steps', value: `Use \`/events publish event_id:${eventId}\` to announce it.\nYou can also use \`/events edit event_id:${eventId}\` to further refine details or add location.` })
        .setTimestamp();
      // The initial reply from /events create was deferred. We need to edit that.
      // The interaction object here is for the modal submit.
      // We need to find the original interaction if we want to edit its reply.
      // However, the /events create command itself deferred its reply.
      // It's simpler to send a new ephemeral followup from the modal.
      return interaction.reply({ embeds: [successEmbed], ephemeral: true });

    } catch (modalError) {
      console.error('Error processing eventCreateModal:', modalError);
      return interaction.reply({ content: 'There was an error creating your event draft from the modal. Please try again.', ephemeral: true }).catch(()=>{});
    }
  }


  // Slash Command Handling
  if (!interaction.isChatInputCommand()) return;

  /* ─── Backend bereit? ─────────────────────────────── */
  if (!linkStore) {
    // 3-Sek-Timeout umgehen → direkt antworten
    return interaction.reply({
      content: '⏳ Bot initialisiert noch … bitte gleich noch einmal `/connect` ausführen.',
      ephemeral: true
    }).catch(() => {});
  }

  const cmd = client.commands.get(interaction.commandName);
  if (!cmd) return;

  /* ─── simple 3-Sek-Cooldown pro User+Command ───────── */
  const key = `${interaction.user.id}:${cmd.data.name}`;
  if (client.cooldowns.has(key) &&
      Date.now() - client.cooldowns.get(key) < (cmd.cooldown || 3000)) {
    return interaction.reply({ content: '⏳ Cool-down … try again shortly.', ephemeral: true });
  }
  client.cooldowns.set(key, Date.now());

  /* ─── eigentliche Command-Ausführung ──────────────── */
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
    const errorEmbed = new EmbedBuilder()
      .setColor(0xE53935) // ERROR_COLOR
      .setTitle('⚠️ Internal Error')
      .setDescription('An unexpected error occurred while processing this command. Please try again later. If the issue persists, contact an administrator.');
    respond({ embeds: [errorEmbed], ephemeral: true }).catch(() => {});
  }
});

//-------------------------------------------------------------------
// 7 · ✅ REACTION VERIFIER
//-------------------------------------------------------------------
client.on('messageReactionAdd', async (reaction, user) => {
  if (user.bot || reaction.emoji.name !== '✅') return;
  if (reaction.partial) await reaction.fetch();
  if (reaction.message.author?.id !== client.user.id) return;
  const last = reactionCache.get(user.id) || 0;
  if (Date.now() - last < 1000) return;
  reactionCache.set(user.id, Date.now());
  try {
    const row = await linkStore.get(user.id);
    if (!row || row.verified) return;

    const attempts = (row.attempts || 0) + 1;
    const ts = Math.floor(Date.now() / 1000);
    await linkStore.setAttempts?.(user.id, attempts, ts).catch(()=>{});

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
    const backend = await selectBackend(); // Returns { db, api, dbType } for SQLite, or { db: mongoDbObject, api, dbType: 'mongo'} for Mongo
    linkStore = backend.api; // The API for commands to use

    // 2) Run event migration if needed
    if (fs.existsSync(EVENTS_JSON_PATH)) {
      console.log('[Startup] Found events.json, attempting migration...');
      // For SQLite, backend.db is the sqlite3.Database instance
      // For MongoDB, backend.db is the MongoClient.Db instance
      await migrateEventsJsonToDb(backend.db, backend.dbType);
    } else {
      console.log('[Startup] events.json not found, skipping migration.');
    }

    // 3) Commands von der Disk laden → client.commands wird befüllt
    const cmdList = loadCommands();

    // 3) Nach Discord-Login: Slash-Commands registrieren
    client.once('ready', async () => {
      console.log(`🤖 Logged in as ${client.user.tag}`);
      try {
        await registerCommands(cmdList);
      } catch (e) {
        console.error('🔴 Failed to register commands', e);
      }
    });

    // 4) Discord-Login
    await client.login(DISCORD_TOKEN);
  } catch (fatal) {
    console.error('💀 Fatal startup error – shutting down', fatal);
    process.exit(1);
  }
})();
