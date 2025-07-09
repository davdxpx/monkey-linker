const axios = require('axios');

/**
 * Resolves a Roblox username to a Roblox ID, or validates a Roblox ID.
 * @param {string} input - Roblox username or ID.
 * @returns {Promise<number>} The Roblox ID.
 * @throws {Error} If the Roblox user is not found or if there's an API error.
 */
async function resolveRobloxId(input) {
  if (/^\d+$/.test(input)) return Number(input); // Already an ID
  try {
    const { data } = await axios.post('https://users.roblox.com/v1/usernames/users', {
      usernames: [input],
      excludeBannedUsers: true
    }, { timeout: 5000 }); // Added a timeout
    if (!data?.data?.length) throw new Error('Roblox user not found or name is invalid.');
    return data.data[0].id;
  } catch (error) {
    // Log the full error for more details if it's an Axios error or similar
    if (error.isAxiosError) {
        console.error('Roblox API (resolveRobloxId) Axios error:', error.toJSON());
    } else {
        console.error('Roblox API (resolveRobloxId) error:', error.message);
    }
    // Provide a more generic error to the user-facing part
    throw new Error('Could not resolve Roblox username. The Roblox API might be temporarily unavailable or the username is invalid.');
  }
}

module.exports = {
  resolveRobloxId,
};
