'use strict';

const crypto = require('crypto');

/**
 * Generates a random 6-character string consisting of uppercase letters (A-Z) and digits (0-9).
 * This is a simple generator; for guaranteed uniqueness across a very large number of events,
 * a check against the database would be needed, or a larger ID space.
 * For now, it generates a random ID. Collisions are statistically unlikely for moderate use.
 * @returns {string} A 6-character random alphanumeric ID.
 */
function generateEventId() {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  let result = '';
  // crypto.randomBytes is preferred for more secure random numbers if available and appropriate
  // For simplicity and given the character set, Math.random is often sufficient for non-critical IDs.
  // However, to improve randomness quality:
  const randomBytes = crypto.randomBytes(6);
  for (let i = 0; i < 6; i++) {
    result += chars[randomBytes[i] % chars.length];
  }
  return result;
}

module.exports = {
  generateEventId,
};
