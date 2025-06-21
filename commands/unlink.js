// commands/unlink.js – Unlink your Roblox account (v2)
// 🐒 2025 © StillBrokeStudios · @davdxpx

const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('unlink')
    .setDescription('Completely remove your linked Roblox account'),

  /** @param {import('discord.js').ChatInputCommandInteraction} interaction
   *  @param {Object} linkStore – unified DB API (get, upsert, verify, …)
   *  @param {Object} cfg        – env constants (VERIFIED_ROLE_ID, GUILD_ID, …)
   */
  async execute(interaction, linkStore, cfg) {
    await interaction.deferReply({ ephemeral: true });

    try {
      // 1️⃣ Datensatz holen
      const row = await linkStore.get(interaction.user.id);

      if (!row || !row.verified) {
        return interaction.editReply('🚫 No verified Roblox link found for your account.');
      }

      // 2️⃣ DB‐Eintrag löschen
      await linkStore.cleanupExpired(0);                // safety: clean unverified first
      await linkStore.upsert({ ...row, verified: 0 });  // mark unverified
      await linkStore.verify(interaction.user.id);      // or remove entry if you prefer
      await linkStore.setAttempts(interaction.user.id, 0);

      // ⚠️  Alternativ komplett entfernen:
      // await linkStore.remove(interaction.user.id);   // ← implement in both back-ends if desired

      // 3️⃣ Role entfernen (optional)
      if (cfg.VERIFIED_ROLE_ID && cfg.GUILD_ID) {
        try {
          const guild  = await interaction.client.guilds.fetch(cfg.GUILD_ID);
          const member = await guild.members.fetch(interaction.user.id);
          await member.roles.remove(cfg.VERIFIED_ROLE_ID);
        } catch (err) {
          console.warn('Role removal failed:', err);
        }
      }

      // 4️⃣ Bestätigungs-Embed schicken
      const embed = new EmbedBuilder()
        .setColor(0xe53935)
        .setTitle('🔗 Link removed')
        .setDescription('Your Discord account is no longer connected to Roblox.')
        .setFooter({ text: 'You can /connect again any time.' });

      await interaction.editReply({ embeds: [embed] });
    } catch (err) {
      console.error('unlink.js error:', err);
      await interaction.editReply('❌ Internal error, please try again later.');
    }
  }
};
