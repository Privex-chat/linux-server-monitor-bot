const securityCollector = require('../collectors/security');
const embeds = require('../formatters/embeds');
const { getState, updateState } = require('../utils/storage');
const { alertMention } = require('../utils/alert');
const config = require('../../config');
const logger = require('../utils/logger');

let resources = null;

function init(res) {
  resources = res;
}

async function run() {
  if (!resources) return;

  try {
    const secData = await securityCollector.getSecurityStatus();
    const secEmbed = embeds.buildSecurityEmbed(secData);

    const state = getState();
    const messageId = state.messageIds.securityStatus;
    if (!messageId) return;

    const msg = await resources.channel.messages.fetch(messageId);
    await msg.edit({ content: null, embeds: [secEmbed] });

    // Alert on WARNING or CRITICAL
    if (secData.shouldAlert && resources.threads['logs-security']) {
      const alertLines = [];
      alertLines.push(`${secData.levelEmoji} **Security Alert: ${secData.level}**`);
      alertLines.push(alertMention());

      if (secData.suspiciousProcs.length > 0) {
        alertLines.push(`\n**Suspicious Processes:**`);
        for (const p of secData.suspiciousProcs) {
          alertLines.push(`• PID \`${p.pid}\` — ${p.reason}: \`${p.command.substring(0, 80)}\``);
        }
      }

      if (secData.ssh.failedCount >= config.SSH_FAIL_WARN_THRESHOLD) {
        alertLines.push(`\n**SSH:** ${secData.ssh.failedCount} failed attempts`);
      }

      const alertMessage = alertLines.join('\n').substring(0, 2000);
      const thread = resources.threads['logs-security'];
      
      // Only send alert if the message is different from the last one
      if (state.lastSecurityAlert !== alertMessage) {
        await thread.send(alertMessage);
        await updateState((s) => {
          s.lastSecurityAlert = alertMessage;
        });
      }
    } else if (!secData.shouldAlert && state.lastSecurityAlert) {
      // Clear alert state if system returns to SECURE
      await updateState((s) => {
        s.lastSecurityAlert = null;
      });
    }

    logger.debug('Security status updated.');
  } catch (err) {
    logger.error(`Security update error: ${err.message}`);
  }
}

module.exports = { init, run };
