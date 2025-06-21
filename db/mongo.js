// db/mongo.js – MongoDB Connector (multi‑cluster)
// -------------------------------------------------
// Supports up to 4 Mongo URIs. Uses first URI as READ/WRITE primary,
// but will replicate each write to every additional cluster (fire‑and‑forget).
// © StillBrokeStudios 2025 · @davdxpx

const { MongoClient } = require('mongodb');
const DEBUG = process.env.DEBUG_MONGO === '1';

// Collect URIs from ENV (MONGO_URI_1 .. MONGO_URI_4)
const mongoURIs = [1, 2, 3, 4]
  .map(i => process.env[`MONGO_URI_${i}`])
  .filter(Boolean);

if (mongoURIs.length === 0) {
  throw new Error('❌ MONGO_URI_x env vars missing – at least one required');
}

const DB_NAME = process.env.MONGO_DB_NAME || 'monkeyLinker';
const COLLECTION = process.env.MONGO_COLLECTION || 'links';

// Keep refs
const clients = [];
let primaryCol; // first cluster collection

async function connect() {
  for (const [idx, uri] of mongoURIs.entries()) {
    const client = new MongoClient(uri, {
      serverSelectionTimeoutMS: 10_000,
      appName: 'MonkeyLinkerBot',
    });
    await client.connect();
    clients.push(client);
    if (DEBUG) console.log(`🔌 Mongo #${idx + 1} connected (${uri.split('@').pop()})`);
    if (idx === 0) primaryCol = client.db(DB_NAME).collection(COLLECTION);
  }
  return module.exports; // allow chaining
}

function col(index = 0) {
  return clients[index].db(DB_NAME).collection(COLLECTION);
}

// Helpers ------------------------------------------------------------
async function replicateWrite(opFn) {
  // execute on primary first, throw if fails
  const res = await opFn(primaryCol);
  // best‑effort replicate to others (skip primary idx 0)
  for (let i = 1; i < clients.length; i++) {
    opFn(col(i)).catch(err => DEBUG && console.warn(`⚠️ Replica ${i} write fail:`, err.message));
  }
  return res;
}

/* CRUD API *****************************************************************/

async function getLink(discordId) {
  return primaryCol.findOne({ _id: discordId });
}

async function upsertLink(doc) {
  // doc must contain _id (discord) AND roblox
  return replicateWrite(c =>
    c.updateOne({ _id: doc._id }, { $set: doc }, { upsert: true })
  );
}

async function verifyLink(discordId) {
  return replicateWrite(c =>
    c.updateOne({ _id: discordId }, { $set: { verified: true } })
  );
}

async function deleteExpired(pendingSeconds = 900) {
  const expiry = new Date(Date.now() - pendingSeconds * 1000);
  return replicateWrite(c =>
    c.deleteMany({ verified: { $ne: true }, created: { $lt: expiry } })
  );
}

module.exports = {
  connect,
  getLink,
  upsertLink,
  verifyLink,
  deleteExpired,
};
