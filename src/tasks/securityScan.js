const { safeExec } = require('../utils/exec');
const { alertMention, alertAllowedMentions } = require('../utils/alert');
const config = require('../../config');
const logger = require('../utils/logger');
const { codeBlock, sendNoMentions } = require('../utils/discord');

let resources = null;

function init(res) {
  resources = res;
}

async function runRkhunter() {
  if (!resources) return;
  const thread = resources.threads['logs-security'];
  if (!thread) return;

  logger.info('Starting rkhunter scan...');

  const { stdout, stderr, success } = await safeExec(
    'sudo',
    ['rkhunter', '--check', '--skip-keypress', '--report-warnings-only'],
    { timeout: 300000 } // 5 min timeout
  );

  // rkhunter often exits with a non-zero code when warnings are found.
  // safeExec returns stdout even on failure, so we should check if we got output before assuming a crash.
  const output = stdout.trim();

  if (!success && !output) {
    if (stderr.includes('not found') || stderr.includes('No such file')) {
      logger.info('rkhunter not installed, skipping.');
      return;
    }
    await sendNoMentions(thread, `🔍 **rkhunter scan failed:**\n${codeBlock(stderr, 1800)}`);
    return;
  }

  if (output) {
    await sendNoMentions(thread, `🔍 **rkhunter scan - warnings found:**\n${codeBlock(output, 1800)}`);

    if (output.toLowerCase().includes('rootkit')) {
      await thread.send({
        content: `🔴 ${alertMention()} **CRITICAL: Potential rootkit detected!**`,
        allowedMentions: alertAllowedMentions(),
      });
    }
  } else {
    await sendNoMentions(thread, '🔍 **rkhunter scan:** No warnings. System clean.');
  }

  logger.info('rkhunter scan complete.');
}

async function runClamAVScan() {
  if (!resources) return;
  const thread = resources.threads['logs-security'];
  if (!thread) return;

  // Check if ClamAV is installed
  const { success: installed } = await safeExec('which', ['clamscan'], { timeout: 3000 });
  if (!installed) {
    logger.info('ClamAV not installed, skipping.');
    return;
  }

  logger.info('Starting ClamAV scan on critical directories...');

  // Scan /tmp, /var/tmp, /home — common malware locations
  const scanPaths = ['/tmp', '/var/tmp'];
  if (config.PM2_USER && /^[a-z_][a-z0-9_-]*[$]?$/i.test(config.PM2_USER)) {
    scanPaths.push(`/home/${config.PM2_USER}`);
  }

  const { stdout } = await safeExec('clamscan', ['-r', '--no-summary', '--infected', ...scanPaths], {
    timeout: 600000,
  });

  const infected = stdout
    .split('\n')
    .filter((l) => l.includes('FOUND'))
    .map((l) => l.trim());

  const state = require('../utils/storage').getState();
  const infectedHash = infected.join('|');

  if (infected.length > 0) {
    if (state.lastClamAVInfected !== infectedHash) {
      const alertMsg = `🦠 **ClamAV scan - ${infected.length} INFECTED file(s) found!**\n${alertMention()}\n${codeBlock(infected.slice(0, 20).join('\n'), 1500)}`;
      await thread.send({ content: alertMsg.substring(0, 2000), allowedMentions: alertAllowedMentions() });

      await require('../utils/storage').updateState((s) => {
        s.lastClamAVInfected = infectedHash;
      });
    }
  } else {
    await sendNoMentions(thread, '🦠 **ClamAV scan:** No infected files found.');
    if (state.lastClamAVInfected) {
      await require('../utils/storage').updateState((s) => {
        s.lastClamAVInfected = null;
      });
    }
  }

  logger.info('ClamAV scan complete.');
}

async function runAll() {
  await runRkhunter();
  await runClamAVScan();
}

module.exports = { init, runAll, runRkhunter, runClamAVScan };
