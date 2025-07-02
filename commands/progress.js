// commands/progress.js – FULL Progress Inspector
// Shows an extensive overview of the player profile pulled from Roblox Open Cloud
// © StillBrokeStudios 2025 · @davdxpx

const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const axios = require('axios');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('progress')
    .setDescription('Show a full overview of your Monkey Simulator account'),

  async execute(interaction, db, cfg) {
    await interaction.deferReply({ ephemeral: true });

    // 1️⃣  Get verified row
    const row = await db.get(interaction.user.id); // Use linkStore.get()

    // Check if linked and verified
    if (!row || !row.verified) {
      const notLinkedEmbed = new EmbedBuilder()
        .setColor(0xFFC107) // WARN_COLOR
        .setTitle('🚫 Not Linked or Verified')
        .setDescription('You must link your Roblox account and verify it using `/connect` before checking your progress.');
      return interaction.editReply({ embeds: [notLinkedEmbed] });
    }

    // 2️⃣  Guard Open‑Cloud
    if (!cfg.UNIVERSE_ID || !cfg.OC_KEY) {
      const notConfiguredEmbed = new EmbedBuilder()
        .setColor(0xFFC107) // WARN_COLOR
        .setTitle('⚠️ Feature Not Configured')
        .setDescription('Progress lookup via OpenCloud is not configured for this bot. Please contact an administrator.');
      return interaction.editReply({ embeds: [notConfiguredEmbed] });
    }

    try {
      // 3️⃣  Fetch DataStore blob
      const entryKey = `Player_${row.roblox}`;
      const { data: oc } = await axios.get(
        `https://apis.roblox.com/datastores/v1/universes/${cfg.UNIVERSE_ID}/standard-datastores/datastore/entries/entry`,
        {
          params: { datastoreName: 'MainDataStore', entryKey },
          headers: { 'x-api-key': cfg.OC_KEY },
          timeout: 8_000
        }
      );
      const profile = JSON.parse(oc.data);
      const P = profile?.PlayerData ?? {};
      const fmt = n => (n === undefined ? '❔' : String(n));

      // 4️⃣  Build Embed
      const embed = new EmbedBuilder()
        .setColor(0x4caf50)
        .setTitle(`📊  Progress for ${row.roblox}`)
        .setThumbnail('https://tr.rbxcdn.com/21c076d1c29e62a8935117cd3f3d40e0/150/150/AvatarHeadshot/Png')
        .addFields(
          { name: 'Level', value: fmt(P.Progress?.Level), inline: true },
          { name: 'XP', value: fmt(P.Progress?.XP), inline: true },
          { name: 'Statues', value: `${fmt(P.Progress?.Statues)}/42`, inline: true },
          { name: '\u200B', value: '\u200B', inline: true },
          { name: 'Current Island', value: P.World?.CurrentIsland ?? '❔', inline: true },
          { name: 'Current Area', value: P.World?.CurrentArea ?? '❔', inline: true },
          { name: 'Unlocked Areas', value: fmt(P.Progress?.UnlockedAreas?.length), inline: true },
          { name: '\u200B', value: '\u200B', inline: true },
          { name: 'Bananas', value: fmt(P.Stats?.TotalCoinanas), inline: true },
          { name: 'Diananas', value: fmt(P.Stats?.TotalDiananas), inline: true },
          { name: 'Total Collected', value: fmt(P.Stats?.TotalCollected), inline: true },
          { name: '\u200B', value: '\u200B', inline: true },
          { name: 'Backpack Size', value: fmt(P.Backpack?.Size ?? P.BackpackMaxSlots), inline: true },
          { name: 'Items in Backpack', value: fmt(P.Backpack?.Items?.length), inline: true },
          { name: 'Monkeys Owned', value: fmt(P.Monkeys?.length), inline: true },
          { name: '\u200B', value: '\u200B', inline: true },
          { name: 'Playtime (min)', value: fmt(P.Meta?.TotalPlayTime), inline: true },
          { name: 'Join Date', value: P.Meta?.JoinTime ?? '❔', inline: true },
          { name: 'Last Login', value: P.Meta?.LastLogin ?? '❔', inline: true }
        )
        .setFooter({ text: 'StillBroke Studios • Monkey Simulator' });

      interaction.editReply({ embeds: [embed] });
    } catch (err) {
      console.error(err);
      const fetchErrorEmbed = new EmbedBuilder()
        .setColor(0xE53935) // ERROR_COLOR
        .setTitle('❌ Failed to Fetch Progress')
        .setDescription('An error occurred while trying to fetch your progress from Roblox. Please try again later.');
      interaction.editReply({ embeds: [fetchErrorEmbed] });
    }
  }
};
