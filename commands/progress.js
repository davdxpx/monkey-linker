// commands/progress.js – View current Monkey Simulator progress
// 🐒 Discord ↔ Roblox linking tool
// © StillBrokeStudios 2025 · @davdxpx

const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const axios = require('axios');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('progress')
    .setDescription('Show your current Monkey Simulator progress'),

  async execute(interaction, db, config) {
    await interaction.deferReply({ ephemeral: true });

    const row = await new Promise(r =>
      db.get('SELECT * FROM links WHERE discord=? AND verified=1', [interaction.user.id], (_, row) => r(row))
    );
    if (!row) return interaction.editReply('🚫 You are not linked yet.');

    if (!config.UNIVERSE_ID || !config.OC_KEY)
      return interaction.editReply('⚠️ Progress lookup not configured.');

    try {
      const entryKey = `Player_${row.roblox}`;
      const oc = await axios.get(
        `https://apis.roblox.com/datastores/v1/universes/${config.UNIVERSE_ID}/standard-datastores/datastore/entries/entry`,
        {
          params: { datastoreName: 'MainDataStore', entryKey },
          headers: { 'x-api-key': config.OC_KEY },
          timeout: 5000
        }
      );

      const data = JSON.parse(oc.data.data);
      const lvl  = data?.PlayerData?.Progress?.Level   ?? '?';
      const stat = data?.PlayerData?.Progress?.Statues ?? '?';

      const embed = new EmbedBuilder()
        .setColor(0xfbc02d)
        .setTitle('🐒 Monkey Progress')
        .setDescription(`Level: **${lvl}**\nStatues: **${stat}/42**`)
        .setFooter({ text: 'StillBroke Studios – Monkey Simulator' });

      interaction.editReply({ embeds: [embed] });

    } catch (e) {
      console.error(e);
      interaction.editReply('⚠️ Failed to fetch your progress. Try again later.');
    }
  }
};
