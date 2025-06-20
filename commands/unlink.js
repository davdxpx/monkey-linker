// commands/unlink.js – Remove linked Roblox account
// 🐒 Discord ↔ Roblox unlink command
// © StillBrokeStudios 2025 · @davdxpx

const { SlashCommandBuilder } = require('discord.js');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('unlink')
    .setDescription('Unlink your currently connected Roblox account'),

  async execute(interaction, db, config) {
    await interaction.deferReply({ ephemeral: true });

    const row = await new Promise(r =>
      db.get('SELECT * FROM links WHERE discord=?', [interaction.user.id], (_, row) => r(row))
    );
    if (!row) return interaction.editReply('🚫 You have no linked account.');

    db.run('DELETE FROM links WHERE discord=?', [interaction.user.id]);

    if (config.VERIFIED_ROLE_ID) {
      const guild  = await interaction.client.guilds.fetch(config.GUILD_ID);
      const member = await guild.members.fetch(interaction.user.id).catch(() => null);
      if (member) member.roles.remove(config.VERIFIED_ROLE_ID).catch(console.error);
    }

    interaction.editReply('✅ Your Roblox account has been unlinked.');
  }
};
