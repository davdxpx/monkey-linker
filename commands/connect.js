// commands/connect.js – /connect <RobloxUser>
// ------------------------------------------------
// Creates or updates a pending link between the invoking Discord user and a
// Roblox account.
//
// • Max ATTEMPTS (default 3) before temporary block (15 min)
// • Generates 6‑char HEX code → user pastes into Roblox profile About section
// • Sends DM with instructions + ✅ reaction trigger handled globally
// • Works with pluggable linkStore (Mongo or SQLite) – expects the same API
//   that index.js passes to every command:
//       execute(interaction, linkStore, env)
//
// © StillBrokeStudios 2025 · @davdxpx

const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const axios = require('axios');
const crypto = require('node:crypto');

// ENV overrides
const ATTEMPT_LIMIT = parseInt(process.env.LINK_ATTEMPT_LIMIT ?? '3', 10);
const PENDING_TIMEOUT = parseInt(process.env.LINK_PENDING_TIMEOUT ?? `${15 * 60}`, 10); // sec
const DEBUG = process.env.DEBUG_CONNECT === '1';

module.exports = {
  data: new SlashCommandBuilder()
    .setName('connect')
    .setDescription('Link your Roblox account to Monkey Simulator')
    .addStringOption(opt =>
      opt.setName('robloxuser')
        .setDescription('Exact Roblox username (case‑sensitive)')
        .setRequired(true)
    ),

  /**
   * @param {import('discord.js').ChatInputCommandInteraction} i
   * @param {import('../db/types').LinkStore} linkStore – injected by index.js
   * @param {object} env – env vars forwarded by index.js (not used here)
   */
  async execute(i, linkStore) {
    const robloxUser = i.options.getString('robloxuser', true).trim();
    await i.deferReply({ ephemeral: true });

    // 1️⃣ Roblox Username → userId lookup ---------------------------------------------------
    let userId;
    try {
      const { data } = await axios.post(
        'https://users.roblox.com/v1/usernames/users',
        { usernames: [robloxUser], excludeBannedUsers: true },
        { timeout: 6_000 }
      );
      userId = data?.data?.[0]?.id;
    } catch (err) {
      console.error('[connect] Roblox API error', err);
      return i.editReply('⚠️ Roblox API error – please try again later.');
    }

    if (!userId) {
      return i.editReply('🚫 **Roblox user not found** – check spelling and try again.');
    }

    // 2️⃣ Check existing link or pending request -------------------------------------------
    const existing = await linkStore.get(i.user.id);

    if (existing?.verified) {
      return i.editReply(`✅ **Already linked** to Roblox ID \`${existing.roblox}\``);
    }

    // Attempt limitation logic -------------------------------------------------------------
    const nowSec = Math.floor(Date.now() / 1000);
    let attempts = existing?.attempts ?? 0;

    if (existing && !existing.verified) {
      // pending link exists – check time window & attempts
      const age = nowSec - (existing.created ?? nowSec);
      if (attempts >= ATTEMPT_LIMIT && age < PENDING_TIMEOUT) {
        const waitMin = Math.ceil((PENDING_TIMEOUT - age) / 60);
        return i.editReply(`⏳ You reached the maximum of **${ATTEMPT_LIMIT}** attempts. ` +
          `Please wait **${waitMin} min** before trying again.`);
      }
      // Otherwise: we allow another attempt (regenerate code)
    }

    attempts += 1;

    // 3️⃣ Generate fresh verification code --------------------------------------------------
    const code = crypto.randomBytes(3).toString('hex').toUpperCase(); // 6‑char HEX eg E4A1B9

    // 4️⃣ Upsert pending link in DB ---------------------------------------------------------
    await linkStore.upsert({
      discord: i.user.id,
      roblox: userId,
      code,
      verified: 0,
      created: nowSec,
      attempts
    });

    if (DEBUG) console.log(`[connect] Upsert link row →`, i.user.id, userId, code, attempts);

    // 5️⃣ DM instructions ------------------------------------------------------------------
    const embed = new EmbedBuilder()
      .setColor(0xffc107)
      .setTitle('🔗 Final Step – Verify your account')
      .setDescription(
        `1. **Copy** the code below and paste it into your Roblox profile _About_ section.
` +
        `2. **React** with ✅ to this DM within **${PENDING_TIMEOUT / 60} minutes**.
` +
        `3. You can **remove** the code after verification.

` +
        `​`
      )
      .addFields({ name: 'Code', value: `\`${code}\`` })
      .setFooter({ text: `Attempt ${attempts}/${ATTEMPT_LIMIT}` });

    try {
      const dm = await i.user.send({ embeds: [embed] });
      await dm.react('✅');
      await i.editReply('📩 Check your DMs – follow the instructions to finish linking!');
    } catch {
      return i.editReply('❌ Could not send you a DM. Please enable private messages and try again.');
    }
  }
};
