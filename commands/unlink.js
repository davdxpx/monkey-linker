// commands/unlink.js – Remove your Roblox link (v3-EN)
// 🐒 StillBrokeStudios · © 2025 @davdxpx

const { SlashCommandBuilder, EmbedBuilder, time } = require('discord.js');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('unlink')
    .setDescription('Remove the link between your Discord and Roblox account'),

  /**
   * @param {import('discord.js').ChatInputCommandInteraction} interaction
   * @param {Object} linkStore   Unified DB API (get, remove, setAttempts …)
   * @param {Object} cfg         Environment constants (VERIFIED_ROLE_ID, GUILD_ID …)
   */
  async execute(interaction, linkStore, cfg) {
    await interaction.deferReply({ ephemeral: true });

    try {
      /* 1️⃣  Look up existing link ----------------------------------------- */
      const row = await linkStore.get(interaction.user.id);

      if (!row || !row.verified) {
        return interaction.editReply({
          embeds: [
            new EmbedBuilder()
              .setColor(0xffc107)
              .setTitle('🚫 No linked account')
              .setDescription('Your Discord account is **not** linked to Roblox.')
          ]
        });
      }

      /* 2️⃣  Remove or flag the record ------------------------------------- */
      if (typeof linkStore.remove === 'function') {
        await linkStore.remove(interaction.user.id);
        console.log(`[unlink] Removed link for ${interaction.user.id}`);
      } else {
        // Fallback when .remove() is not implemented in the backend
        await linkStore.upsert({ ...row, verified: 0 });
        console.warn(
          '[unlink] Backend has no .remove(); record marked as unverified instead'
        );
      }
      await linkStore.setAttempts?.(interaction.user.id, 0).catch(() => {});

      /* 3️⃣  Remove “Verified” role (optional) ------------------------------ */
      if (cfg.VERIFIED_ROLE_ID && cfg.GUILD_ID) {
        try {
          const guild  = await interaction.client.guilds.fetch(cfg.GUILD_ID);
          const member = await guild.members.fetch(interaction.user.id);
          await member.roles.remove(cfg.VERIFIED_ROLE_ID);
        } catch (e) {
          console.warn('[unlink] Could not remove role:', e.message);
        }
      }

      /* 4️⃣  Confirmation embed -------------------------------------------- */
      const embed = new EmbedBuilder()
        .setColor(0xe53935)
        .setTitle('🔗 Link removed')
        .setDescription(
          `Your Roblox account **\`${row.roblox}\`** is no longer linked to Discord.`
        )
        .addFields(
          { name: 'Roblox user ID', value: String(row.roblox), inline: true },
          { name: 'Linked since', value: time(new Date(row.created * 1000), 'R'), inline: true }
        )
        .setFooter({ text: 'You can link again at any time with /connect.' });

      await interaction.editReply({ embeds: [embed] });
    } catch (err) {
      console.error('[unlink] Fatal error:', err);

      await interaction.editReply({
        embeds: [
          new EmbedBuilder()
            .setColor(0xe74c3c)
            .setTitle('❌ Internal error')
            .setDescription('Something went wrong. Please try again later.')
        ]
      });
    }
  }
};
