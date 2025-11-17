// src/utils/helpers.js

/**
 * Pequeños helpers comunes
 */

/**
 * Pausa async
 * @param {number} ms
 * @returns {Promise<void>}
 */
async function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

module.exports = {
  sleep,
};
