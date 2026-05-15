/**
 * Builds the Discord mention string for alerts/pings.
 * Supports user mention, role mention, or both.
 * At least one of ALERT_USER_ID or ALERT_ROLE_ID must be set.
 */

const config = require('../../config');

/**
 * Returns the mention string for alert pings.
 * Examples:
 *   - User only:  "<@123456>"
 *   - Role only:  "<@&789012>"
 *   - Both:       "<@123456> <@&789012>"
 */
function alertMention() {
  const parts = [];
  if (config.ALERT_USER_ID) parts.push(`<@${config.ALERT_USER_ID}>`);
  if (config.ALERT_ROLE_ID) parts.push(`<@&${config.ALERT_ROLE_ID}>`);
  return parts.join(' ');
}

/**
 * Validates that at least one alert target is configured.
 * Call at startup.
 */
function validateAlertConfig() {
  if (!config.ALERT_USER_ID && !config.ALERT_ROLE_ID) {
    return 'At least one of ALERT_USER_ID or ALERT_ROLE_ID must be set in .env';
  }
  return null;
}

module.exports = { alertMention, validateAlertConfig };
