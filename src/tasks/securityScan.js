const { safeExec } = require('../utils/exec');
const config = require('../../config');
const logger = require('../utils/logger');

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

  if (!success) {
    if (stderr.includes('not found') || stderr.includes('No such file')) {
      logger.info('rkhunter not installed, skipping.');
      return;
    }
    await thread.send(`🔍 **rkhunter scan failed:**\n\`\`\`\n${stderr.substring(0, 1800)}\n\`\`\``);
    return;
  }

  const output = stdout.trim();
  if (output) {
    await thread.send(`🔍 **rkhunter scan — warnings found:**\n\`\`\`\n${output.substring(0, 1800)}\n\`\`\``);

    if (output.toLowerCase().includes('rootkit')) {
      await thread.send(`🔴 <@${config.ALERT_USER_ID}> **CRITICAL: Potential rootkit detected!**`);
    }
  } else {
    await thread.send('🔍 **rkhunter scan:** ✅ No warnings. System clean.');
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
  const scanPaths = ['/tmp', '/var/tmp', `/home/${config.PM2_USER}`];
  const scanPath = scanPaths.join(' ');

  const { stdout } = await safeExec(
    'bash',
    ['-c', `clamscan -r --no-summary --infected ${scanPath} 2>/dev/null; echo "---CLAM_EXIT:$?"`],
    { timeout: 600000 } // 10 min timeout
  );

  const infected = stdout
    .split('\n')
    .filter((l) => l.includes('FOUND'))
    .map((l) => l.trim());

  if (infected.length > 0) {
    const alertMsg = `🦠 **ClamAV scan — ${infected.length} INFECTED file(s) found!**\n<@${config.ALERT_USER_ID}>\n\`\`\`\n${infected.slice(0, 20).join('\n')}\n\`\`\``;
    await thread.send(alertMsg.substring(0, 2000));
  } else {
    await thread.send('🦠 **ClamAV scan:** ✅ No infected files found.');
  }

  logger.info('ClamAV scan complete.');
}

async function runAll() {
  await runRkhunter();
  await runClamAVScan();
}

module.exports = { init, runAll, runRkhunter, runClamAVScan };
