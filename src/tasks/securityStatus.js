const securityCollector = require('../collectors/security');
const embeds = require('../formatters/embeds');
const { getState, updateState } = require('../utils/storage');
const { alertMention, alertAllowedMentions } = require('../utils/alert');
const logger = require('../utils/logger');
const { shouldSendAlert, markAlertSent, clearAlert } = require('../utils/securityState');

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

    if (secData.shouldAlert && resources.threads['logs-security']) {
      await maybeSendSecurityAlert(secData, state, resources.threads['logs-security']);
    } else if (!secData.shouldAlert && state.lastSecurityAlert) {
      await updateState((s) => {
        s.lastSecurityAlert = null;
        clearAlert(s, 'security-status');
      });
    }

    logger.debug('Security status updated.');
  } catch (err) {
    logger.error(`Security update error: ${err.message}`);
  }
}

async function maybeSendSecurityAlert(secData, state, thread) {
  const alertFindings = secData.findings.filter(
    (finding) => finding.level === 'WARNING' || finding.level === 'CRITICAL'
  );
  if (alertFindings.length === 0) return;

  const fingerprint = alertFindings
    .map((finding) => `${finding.level}:${finding.key}`)
    .sort()
    .join('|');

  if (!shouldSendAlert(state, 'security-status', fingerprint, secData.level)) {
    return;
  }

  const alertLines = [];
  alertLines.push(`${secData.levelEmoji} **Security Alert: ${secData.level}**`);
  alertLines.push(alertMention());

  for (const finding of alertFindings.slice(0, 8)) {
    alertLines.push(`\n**${finding.title}**`);
    alertLines.push(finding.detail);
    if (finding.action) alertLines.push(`Action: ${finding.action}`);
  }

  if (alertFindings.length > 8) {
    alertLines.push(`\n...and ${alertFindings.length - 8} more finding(s).`);
  }

  const alertMessage = alertLines.join('\n').substring(0, 2000);
  await thread.send({ content: alertMessage, allowedMentions: alertAllowedMentions() });

  await updateState((s) => {
    s.lastSecurityAlert = alertMessage;
    markAlertSent(s, 'security-status', fingerprint, secData.level);
  });
}

module.exports = { init, run };
