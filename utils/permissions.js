'use strict';

/**
 * Checks if the given user ID is the Bot Owner.
 * @param {string} userId The user ID to check.
 * @param {string} ownerIdEnv The Owner ID from environment variables.
 * @returns {boolean} True if the user is the Bot Owner, false otherwise.
 */
function isBotOwner(userId, ownerIdEnv) {
  if (!ownerIdEnv) return false; // Owner ID not configured
  return userId === ownerIdEnv;
}

/**
 * Checks if the given member is a Bot Admin (either by Admin Role or by being Bot Owner).
 * @param {Discord.GuildMember} member The GuildMember object to check.
 * @param {string} adminRolesEnv Comma-separated string of Admin Role IDs/names from environment variables.
 * @param {string} ownerIdEnv The Owner ID from environment variables.
 * @returns {boolean} True if the member is a Bot Admin, false otherwise.
 */
function isBotAdmin(member, adminRolesEnv, ownerIdEnv) {
  if (!member) return false;
  if (isBotOwner(member.user.id, ownerIdEnv)) {
    return true;
  }
  if (!adminRolesEnv) return false; // Admin roles not configured

  const adminRolesArray = adminRolesEnv.split(',').map(role => role.trim()).filter(role => role.length > 0);
  if (adminRolesArray.length === 0) return false;

  return member.roles.cache.some(role => adminRolesArray.includes(role.id) || adminRolesArray.includes(role.name));
}

/**
 * Checks if the user is a designated Bot Moderator via database record.
 * This does NOT check for Admin/Owner status by itself.
 * @param {string} userId The user ID to check.
 * @param {object} linkStore The database linkStore object.
 * @returns {Promise<boolean>} True if the user is a Bot Moderator, false otherwise.
 */
async function isUserActuallyBotModerator(userId, linkStore) {
  if (!userId || !linkStore || typeof linkStore.isBotModerator !== 'function') {
    console.error('[permissions.isUserActuallyBotModerator] Invalid arguments or linkStore missing isBotModerator method.');
    return false;
  }
  return await linkStore.isBotModerator(userId);
}

/**
 * Checks if the user from an interaction can manage bot moderators (is Bot Owner or Bot Admin).
 * @param {Discord.Interaction} interaction The interaction object.
 * @param {object} linkStore The database linkStore object (not directly used here but kept for consistency if needed later).
 * @param {object} envConfig The environment configuration object containing OWNER_ID and ADMIN_ROLES.
 * @returns {boolean} True if the user can manage moderators, false otherwise.
 */
function canManageModerators(interaction, linkStore, envConfig) {
  if (!interaction || !interaction.user || !interaction.member || !envConfig) return false;

  // Check if Bot Owner
  if (isBotOwner(interaction.user.id, envConfig.OWNER_ID)) {
    return true;
  }
  // Check if Bot Admin (based on roles)
  if (isBotAdmin(interaction.member, envConfig.ADMIN_ROLES, envConfig.OWNER_ID)) {
    return true;
  }
  return false;
}

module.exports = {
  isBotOwner,
  isBotAdmin,
  isUserActuallyBotModerator,
  canManageModerators,
};
