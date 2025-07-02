const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('help')
    .setDescription('Displays a list of available commands and their descriptions.'),
  async execute(interaction) {
    await interaction.deferReply({ ephemeral: true });

    const commands = interaction.client.commands;

    const helpEmbed = new EmbedBuilder()
      .setColor(0x00BCD4) // INFO_COLOR
      .setTitle('🤖 Bot Commands Help')
      .setDescription('Here is a list of available commands:');

    if (commands.size === 0) {
      helpEmbed.setDescription('No commands are currently available.');
    } else {
      commands.forEach(command => {
        if (command.data.name === 'help' && command.data.description === this.data.description) return; // Skip self if loaded

        let description = command.data.description || 'No description provided.';
        // Check for subcommands - basic version
        if (command.data.options && command.data.options.some(opt => opt.type === 1 || opt.type === 2)) { // 1 = SUB_COMMAND, 2 = SUB_COMMAND_GROUP
          description += '\n*This command has subcommands.*';
        }
        helpEmbed.addFields({ name: `/${command.data.name}`, value: description });
      });
    }

    // Ensure the embed is not too large (max 25 fields)
    if (helpEmbed.data.fields && helpEmbed.data.fields.length > 25) {
        helpEmbed.spliceFields(24, helpEmbed.data.fields.length - 24); // Keep first 24
        helpEmbed.addFields({ name: '...and more!', value: 'Too many commands to list them all here.'});
    }

    try {
      await interaction.editReply({ embeds: [helpEmbed] });
    } catch (error) {
      console.error('Error sending help embed:', error);
      // Fallback if embed fails for some reason (e.g. too large even after splice)
      await interaction.editReply({ content: 'Could not display help information due to an error.', ephemeral: true });
    }
  },
};
