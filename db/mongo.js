// db/mongo.js – MongoDB Connector (multi‑cluster)
// -------------------------------------------------
// Supports up to 4 Mongo URIs. Uses first URI as READ/WRITE primary and 
// replicates each mutating operation (insert/update/delete) to the remaining
// clusters on a best‑effort basis (fire‑and‑forget).
//
// © StillBrokeStudios 2025 · @davdxpx

const { MongoClient } = require('mongodb');
const DEBUG = process.env.DEBUG_MONGO === '1';

//──────────────────────────────────────────────────────────────────────────────
// Helper – simple logger
//──────────────────────────────────────────────────────────────────────────────
function log(...args) {
  if (DEBUG) console.log('🌿 [Mongo]', ...args);
}

//──────────────────────────────────────────────────────────────────────────────
// Collect cluster URIs from env (MONGO_URI_1 … _4) – filter falsy
//──────────────────────────────────────────────────────────────────────────────
const URIs = [
  process.env.MONGO_URI_1,
  process.env.MONGO_URI_2,
  process.env.MONGO_URI_3,
  process.env.MONGO_URI_4
].filter(Boolean);

const DB_NAME = process.env.MONGO_DB_NAME || 'monkeylinker';

//──────────────────────────────────────────────────────────────────────────────
// Exported init function
//──────────────────────────────────────────────────────────────────────────────
async function initMongo() {
  if (!URIs.length) throw new Error('No MONGO_URI_1 provided');

  // ── Connect primary
  const primaryClient = new MongoClient(URIs[0]);
  await primaryClient.connect();
  log('Connected to PRIMARY cluster');
  const primaryDb = primaryClient.db(DB_NAME);
  const linksColl = primaryDb.collection('links');

  // Indexes
  await linksColl.createIndex({ discord: 1 }, { unique: true });
  await linksColl.createIndex({ roblox: 1 }, { unique: true });

  // ── Connect secondary clusters (optional)
  const secondaryClients = [];
  if (URIs.length > 1) {
    for (const uri of URIs.slice(1)) {
      try {
        const c = new MongoClient(uri);
        await c.connect();
        secondaryClients.push(c);
        log('Connected to SECONDARY cluster');
      } catch (err) {
        console.warn('⚠️  [Mongo] Secondary connect failed', err.message);
      }
    }
  }

  // Helper to replicate writes
  function replicate(fn) {
    if (!secondaryClients.length) return;
    for (const client of secondaryClients) {
      try {
        fn(client.db(DB_NAME).collection('links'))
          .catch(err => console.warn('⚠️  Replication error', err.message));
      } catch (e) {
        console.warn('⚠️  Replication exception', e.message);
      }
    }
  }

  //──────────────────────────────────────────
  // Public API – linkStore compatible
  //──────────────────────────────────────────
  const store = {
    /**
     * Fetch by Discord‑ID
     */
    async get(discord) {
      return linksColl.findOne({ discord });
    },

    /**
     * Fetch by Roblox‑ID
     */
    async getByRoblox(roblox) {
      return linksColl.findOne({ roblox });
    },

    /**
     * Insert or update a link (verified defaults to false)
     */
    async upsert({ discord, roblox, code }) {
      const doc = {
        discord,
        roblox,
        code,
        verified: 0,
        created: Math.floor(Date.now() / 1000)
      };
      await linksColl.updateOne({ discord }, { $set: doc }, { upsert: true });
      replicate(coll => coll.updateOne({ discord }, { $set: doc }, { upsert: true }));
    },

    /**
     * Mark as verified
     */
    async verify(discord) {
      await linksColl.updateOne({ discord }, { $set: { verified: 1 } });
      replicate(coll => coll.updateOne({ discord }, { $set: { verified: 1 } }));
    },

    /**
     * Remove link completely
     */
    async remove(discord) {
      await linksColl.deleteOne({ discord });
      replicate(coll => coll.deleteOne({ discord }));
    },

    /**
     * Delete unverified links older than `ageSeconds`
     */
    async cleanupExpired(ageSeconds) {
      const threshold = Math.floor(Date.now() / 1000) - ageSeconds;
      await linksColl.deleteMany({ verified: 0, created: { $lt: threshold } });
      replicate(coll => coll.deleteMany({ verified: 0, created: { $lt: threshold } }));
    },

    /**
     * Close all connections (if the bot shuts down)
     */
    async close() {
      await primaryClient.close();
      for (const c of secondaryClients) await c.close();
    }
  };

  return store;
}

module.exports = { initMongo };
