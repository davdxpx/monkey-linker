// commands/connect.js – /connect <RobloxUser>
// -----------------------------------------------------------------------------
//  Creates or updates a *pending* link between the invoking Discord user and a
//  Roblox account. The user must paste a 6‑character code into their Roblox
//  profile "About" section and then react with ✅ (handled globally).
//
//  ▸ Limits the number of attempts (default 3) – afterwards a 15‑minute cooldown
//  ▸ Works with every backend that exposes a `linkStore` interface (get, upsert)
//  ▸ Sends a DM with clear instructions + fallback message if DMs are closed
//  ▸ Immediate `deferReply()` to avoid "Unknown interaction" (code 10062)
//  ▸ Always edits the original reply – never double‑replies (prevents 40060)
//
//  © StillBrokeStudios 2025 · @davdxpx
// -----------------------------------------------------------------------------

const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const axios   = require('axios');

// ENV constants (pulled once)
const ATTEMPT_LIMIT = Number(process.env.LINK_ATTEMPT_LIMIT) || 3;
const COOLDOWN_SEC  = Number(process.env.LINK_COOLDOWN_SEC)  || 900; // 15 min
const DEBUG         = process.env.DEBUG_CONNECT === '1';

function log(...args) { if (DEBUG) console.log('🟡 [connect]', ...args); }

// ───────────────────────────────────────────────────────────────────────────────
module.exports = {
  data: new SlashCommandBuilder()
    .setName('connect')
    .setDescription('Link your Discord account with a Roblox profile')
    .addStringOption(o =>
      o.setName('robloxuser')
       .setDescription('Roblox username or ID you want to link')
       .setRequired(true)),

  /**
   * @param {import('discord.js').ChatInputCommandInteraction} interaction
   * @param {Object} linkStore        Store injected by index.js (Mongo / SQLite)
   */
  async execute(interaction, linkStore) {
    // 1️⃣ ACKNOWLEDGE _IMMEDIATELY_ (ephemeral)
    await interaction.deferReply({ flags: 1 << 6 }); // 64 = EPHEMERAL

    const discordId = interaction.user.id;
    const robloxArg = interaction.options.getString('robloxuser').trim();

    try {
      // 2️⃣ Resolve Roblox ID & DisplayName via Roblox API
      const robloxId = await resolveRobloxId(robloxArg);
      const profile  = await fetchRobloxProfile(robloxId);
      log('Resolved', robloxArg, '→', robloxId, profile.displayName);

      // 3️⃣ Fetch/Analyse link row
      let row = await linkStore.get(discordId);

      // Create skeleton row if none exists
      if (!row) {
        row = {
          discord: discordId,
          roblox:  robloxId,
          code:    null,
          verified:false,
          attempts:0,
          lastAttempt:0,
          created: Math.floor(Date.now() / 1000)
        };
      }

      // Already verified?
      if (row.verified) {
        return interaction.editReply({ content: '✅ Your Discord account is already linked to this Roblox user.' });
      }

      // Cool‑down check
      const now = Math.floor(Date.now() / 1000);
      if (row.attempts >= ATTEMPT_LIMIT && (now - row.lastAttempt) < COOLDOWN_SEC) {
        const waitMin = Math.ceil((COOLDOWN_SEC - (now - row.lastAttempt)) / 60);
        return interaction.editReply({ content: `⏳ Too many attempts. Please wait **${waitMin} min** and try again.` });
      }

      // 4️⃣ Generate new verification code
      const code = generateCode();
      row.code        = code;
      row.roblox      = robloxId;            // allow updating target account
      row.attempts    = row.attempts + 1;
      row.lastAttempt = now;
      row.verified    = false;

      await linkStore.upsert(row);
      log('Saved row', row);

      // 5️⃣ Send DM instructions
      const dmEmbed = new EmbedBuilder()
        .setColor(0x00bcd4)
        .setTitle('🔗 Link your Roblox account')
        .setDescription(
          `1\. Copy the code below → paste it into **your Roblox profile About section**\.
           2\. Come back and react with ✅ under the last bot message\.
           3\. Bot verifies & assigns you the <@&${process.env.VERIFIED_ROLE_ID || 'VerifiedRole'}> role\.`)
        .addFields(
          { name: 'Roblox User', value: `[${profile.displayName}](https://www.roblox.com/users/${robloxId}/profile)`, inline: true },
          { name: 'Code', value: `\`${code}\``, inline: true },
          { name: '\u200b', value: '\u200b' })
        .setThumbnail(`https://thumbnails.roblox.com/v1/users/avatar?userIds=${robloxId}&size=150x150&format=Png&isCircular=true`)
        .setFooter({ text: `Attempt ${row.attempts}/${ATTEMPT_LIMIT}` });

      let dmSuccess = true;
      try {
        await interaction.user.send({ embeds: [dmEmbed] });
      } catch (e) {
        dmSuccess = false;
        log('DM failed – user likely has DMs disabled');
      }

      const publicMsg = dmSuccess
        ? '📨 Check your DMs – follow the instructions to complete verification!'
        : '⚠️ I could not DM you. Please enable DMs and use /connect again.';

      return interaction.editReply({ content: publicMsg });

    } catch (err) {
      console.error('💥 /connect error:', err);
      const msg = typeof err === 'string' ? err : '❌ Failed to create link. Please try again later.';
      return interaction.editReply({ content: msg });
    }
  }
};

// ───────────────────────────────────────────────────────────────────────────────
// Helper functions
// ───────────────────────────────────────────────────────────────────────────────

function generateCode() {
  return Math.random().toString(16).slice(2, 8).toUpperCase(); // 6‑hex chars
}

async function resolveRobloxId(input) {
  // If purely digits treat as ID
  if (/^\d+$/.test(input)) return Number(input);

  // Username lookup → userId
  const { data } = await axios.post('https://users.roblox.com/v1/usernames/users', {
    usernames: [input],
    excludeBannedUsers: true
  }, { timeout: 5000 });

  if (!data?.data?.length) throw '❌ Roblox user not found.';
  return data.data[0].id;
}

async function fetchRobloxProfile(userId) {
  const { data } = await axios.get(`https://users.roblox.com/v1/users/${userId}`, { timeout: 5000 });
  return data;
}
