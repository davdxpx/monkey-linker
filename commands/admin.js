const { SlashCommandBuilder, EmbedBuilder, PermissionFlagsBits } = require('discord.js');
const axios = require('axios'); // For Roblox ID resolution

// Helper function to resolve Roblox ID (similar to connect.js)
async function resolveRobloxId(input) {
  if (/^\d+$/.test(input)) return Number(input);
  try {
    const { data } = await axios.post('https://users.roblox.com/v1/usernames/users', {
      usernames: [input],
      excludeBannedUsers: true
    }, { timeout: 5000 });
    if (!data?.data?.length) throw new Error('Roblox user not found.');
    return data.data[0].id;
  } catch (error) {
    console.error('Roblox API error in admin command:', error.message);
    throw new Error('Could not resolve Roblox username. API might be down or username is invalid.');
  }
}

// Helper function to check admin permissions
function isAdmin(interaction, adminRolesEnv) {
  const member = interaction.member;
  if (member.permissions.has(PermissionFlagsBits.Administrator)) {
    return true;
  }
  const roles = adminRolesEnv ? adminRolesEnv.split(',').map(r => r.trim()) : [];
  return member.roles.cache.some(role => roles.includes(role.name) || roles.includes(role.id));
}

module.exports = {
  data: new SlashCommandBuilder()
    .setName('admin')
    .setDescription('Administrative commands for bot management.')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator) // Recommended default permission
    .addSubcommand(subcommand =>
      subcommand
        .setName('link')
        .setDescription('Manually link a Discord user to a Roblox account.')
        .addUserOption(option =>
          option.setName('discorduser')
            .setDescription('The Discord user to link.')
            .setRequired(true))
        .addStringOption(option =>
          option.setName('robloxid_or_username')
            .setDescription('The Roblox ID or username to link.')
            .setRequired(true))
    ),

  async execute(interaction, linkStore, envConfig) {
    if (!isAdmin(interaction, envConfig.ADMIN_ROLES)) {
      const noPermsEmbed = new EmbedBuilder()
        .setColor(0xE53935) // ERROR_COLOR
        .setTitle('🚫 Permission Denied')
        .setDescription('You do not have the required permissions to use this admin command.');
      return interaction.reply({ embeds: [noPermsEmbed], ephemeral: true });
    }

    const subcommand = interaction.options.getSubcommand();

    if (subcommand === 'link') {
      await interaction.deferReply({ ephemeral: true });

      const targetUser = interaction.options.getUser('discorduser');
      const robloxInput = interaction.options.getString('robloxid_or_username');
      // Use GUILD_ID from envConfig, VERIFIED_ROLE_ID will be fetched or fallback to env
      const { GUILD_ID } = envConfig;
      let verifiedRoleIdToAssign = envConfig.VERIFIED_ROLE_ID; // Fallback to .env

      try {
        // Attempt to get VERIFIED_ROLE from DB config
        if (linkStore && typeof linkStore.getRoleConfig === 'function' && GUILD_ID) {
            const dbRoleConf = await linkStore.getRoleConfig(GUILD_ID, 'VERIFIED_ROLE');
            if (dbRoleConf && dbRoleConf.role_id) {
                verifiedRoleIdToAssign = dbRoleConf.role_id;
                console.log(`AdminLink: Using VERIFIED_ROLE from DB config: ${verifiedRoleIdToAssign}`);
            } else {
                console.log(`AdminLink: VERIFIED_ROLE not in DB, using .env fallback: ${verifiedRoleIdToAssign}`);
            }
        } else {
            console.warn('AdminLink: linkStore or getRoleConfig not available, or GUILD_ID missing. Falling back to .env for VERIFIED_ROLE_ID.');
        }

        const robloxId = await resolveRobloxId(robloxInput);

        // Check if Discord user is already linked
        const existingDiscordLink = await linkStore.get(targetUser.id);
        if (existingDiscordLink && existingDiscordLink.verified) {
          const alreadyLinkedEmbed = new EmbedBuilder()
            .setColor(0xFFC107) // WARN_COLOR
            .setTitle('⚠️ Already Linked')
            .setDescription(`Discord user ${targetUser.tag} (\`${targetUser.id}\`) is already linked to Roblox ID \`${existingDiscordLink.roblox}\`.`);
          return interaction.editReply({ embeds: [alreadyLinkedEmbed] });
        }

        // Check if Roblox ID is already linked to someone else
        const existingRobloxLink = await linkStore.getByRb(robloxId);
        if (existingRobloxLink && existingRobloxLink.discord !== targetUser.id && existingRobloxLink.verified) {
          const robloxTakenEmbed = new EmbedBuilder()
            .setColor(0xFFC107) // WARN_COLOR
            .setTitle('⚠️ Roblox Account In Use')
            .setDescription(`Roblox ID \`${robloxId}\` is already linked to another Discord user (<@${existingRobloxLink.discord}>).`);
          return interaction.editReply({ embeds: [robloxTakenEmbed] });
        }

        // Proceed with linking
        const linkData = {
          discord: targetUser.id,
          roblox: robloxId,
          code: 'MANUALLY_LINKED_BY_ADMIN', // Or a random code
          verified: 1, // Mark as verified immediately
          attempts: 0,
          lastAttempt: 0,
          created: Math.floor(Date.now() / 1000),
        };

        await linkStore.upsert(linkData);
        // Ensure verification status is set if upsert doesn't handle it fully for existing unverified.
        // Most linkStore.upsert implementations would set verified to 0 by default.
        // So, explicitly calling verify is safer.
        await linkStore.verify(targetUser.id);


        // Assign role
        let roleAssignedInfo = '';
        if (verifiedRoleIdToAssign && GUILD_ID) { // Use the potentially DB-configured role ID
          try {
            const guild = await interaction.client.guilds.fetch(GUILD_ID);
            const member = await guild.members.fetch(targetUser.id);
            await member.roles.add(verifiedRoleIdToAssign);
            roleAssignedInfo = `The <@&${verifiedRoleIdToAssign}> role has been assigned.`;
          } catch (roleError) {
            console.error(`AdminLink: Failed to assign role ${verifiedRoleIdToAssign} to ${targetUser.id}:`, roleError);
            roleAssignedInfo = `Failed to assign the verified role (<@&${verifiedRoleIdToAssign}>). Please check bot permissions.`;
          }
        }

        const successEmbed = new EmbedBuilder()
          .setColor(0x4CAF50) // SUCCESS_COLOR
          .setTitle('✅ Manual Link Successful')
          .setDescription(`Successfully linked Discord user ${targetUser.tag} (\`${targetUser.id}\`) to Roblox ID \`${robloxId}\`.\n${roleAssignedInfo}`)
          .setTimestamp();
        await interaction.editReply({ embeds: [successEmbed] });

        // Optionally DM the user
        try {
            const dmEmbed = new EmbedBuilder()
                .setColor(0x00BCD4)
                .setTitle('🔗 Account Linked by Admin')
                .setDescription(`An administrator has linked your Discord account to the Roblox ID \`${robloxId}\`.\n${roleAssignedInfo.includes("Failed") ? "There was an issue assigning your role, please contact an admin." : "" }`);
            await targetUser.send({ embeds: [dmEmbed] });
        } catch (dmError) {
            // Silently fail if DM cannot be sent
            console.warn(`AdminLink: Could not DM user ${targetUser.id} about manual link.`);
        }

      } catch (error) {
        console.error('Admin link error:', error);
        const errorEmbed = new EmbedBuilder()
          .setColor(0xE53935) // ERROR_COLOR
          .setTitle('❌ Manual Link Failed')
          .setDescription(error.message || 'An unexpected error occurred.');
        if (!interaction.deferred) await interaction.deferReply({ephemeral: true}); // ensure deferred if error is early
        await interaction.editReply({ embeds: [errorEmbed] });
      }
    }
  },
};
