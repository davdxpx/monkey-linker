// commands/unlink.js – Unlink your Roblox account (final)
// 🐒 Removes database entry, role, and sends confirmation embed
// © StillBrokeStudios 2025 · @davdxpx

const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('unlink')
    .setDescription('Completely remove your linked Roblox account'),

  async execute(interaction, db, cfg) {
    await interaction.deferReply({ ephemeral: true });

    db.get('SELECT * FROM links WHERE discord = ? AND verified = 1', [interaction.user.id], (err, row) => {
      if (err) {
        console.error(err);
        return interaction.editReply('❌ Database error. Try again later.');
      }

      if (!row) {
        return interaction.editReply('🚫 No verified link found for your account.');
      }

      // Delete the DB row
      db.run('DELETE FROM links WHERE discord = ?', [interaction.user.id], async err => {
        if (err) {
          console.error(err);
          return interaction.editReply('❌ Could not unlink due to an internal error.');
        }

        // Remove Verified role if set
        if (cfg.VERIFIED_ROLE_ID) {
          try {
            const guild = await interaction.client.guilds.fetch(cfg.GUILD_ID);
            const member = await guild.members.fetch(interaction.user.id);
            await member.roles.remove(cfg.VERIFIED_ROLE_ID);
          } catch (e) {
            console.error('Role removal failed:', e);
          }
        }

        const embed = new EmbedBuilder()
          .setColor(0xe53935)
          .setTitle('🔗 Link removed')
          .setDescription('Your Discord account is no longer connected to Roblox.')
          .setFooter({ text: 'You can /connect again any time.' });

        interaction.editReply({ embeds: [embed] });
      });
    });
  }
};
