const { safeExec } = require('../utils/exec');
const logger = require('../utils/logger');

async function getTemperatures() {
  const result = {
    cpu: { package: null, cores: [] },
    drives: [],
    available: false,
  };

  // ── CPU temperatures via lm-sensors ──
  const sensorsJson = await safeExec('sensors', ['-j']);
  if (sensorsJson.success) {
    try {
      const data = JSON.parse(sensorsJson.stdout);
      result.available = true;

      for (const [chip, sensors] of Object.entries(data)) {
        if (!chip.includes('coretemp') && !chip.includes('k10temp') && !chip.includes('cpu')) continue;

        for (const [label, values] of Object.entries(sensors)) {
          if (typeof values !== 'object' || values === null) continue;

          for (const [key, val] of Object.entries(values)) {
            if (typeof val !== 'object' || val === null) continue;

            for (const [subKey, temp] of Object.entries(val)) {
              if (!subKey.endsWith('_input')) continue;

              if (label.toLowerCase().includes('package') || label.toLowerCase().includes('tctl')) {
                result.cpu.package = temp;
              } else if (label.toLowerCase().includes('core')) {
                result.cpu.cores.push({ label, temp });
              }
            }
          }
        }
      }
    } catch {
      // Fallback: parse plain text output
      await parseSensorsPlainText(result);
    }
  } else {
    await parseSensorsPlainText(result);
  }

  // ── Drive temperatures via smartctl ──
  result.drives = await getDriveTemps();

  return result;
}

async function parseSensorsPlainText(result) {
  const fallback = await safeExec('sensors');
  if (!fallback.success) return;

  const lines = fallback.stdout.split('\n');
  for (const line of lines) {
    const match = line.match(/^(.*?):\s+\+?([\d.]+)°C/);
    if (!match) continue;

    const label = match[1].trim();
    const temp = parseFloat(match[2]);
    result.available = true;

    if (label.toLowerCase().includes('package')) {
      result.cpu.package = temp;
    } else if (label.toLowerCase().includes('core')) {
      result.cpu.cores.push({ label, temp });
    }
  }
}

async function getDriveTemps() {
  const drives = [];

  const { stdout, success } = await safeExec('lsblk', ['-dno', 'NAME,TYPE']);
  if (!success) return drives;

  const lines = stdout.trim().split('\n');
  for (const line of lines) {
    const [name, type] = line.trim().split(/\s+/);
    if (type !== 'disk') continue;

    const device = `/dev/${name}`;

    // Try smartctl (JSON mode)
    const smart = await safeExec('sudo', ['smartctl', '-A', device, '--json=c'], { timeout: 5000 });
    if (smart.success) {
      try {
        const data = JSON.parse(smart.stdout);
        // SATA/HDD: attribute 194 or 190
        const tempAttr = data.ata_smart_attributes?.table?.find((a) => a.id === 194 || a.id === 190);
        if (tempAttr) {
          // raw.string often has "35" or "35 (Min/Max 20/42)"
          let temp = null;
          if (tempAttr.raw?.string) {
            const strMatch = tempAttr.raw.string.match(/^(\d+)/);
            if (strMatch) temp = parseInt(strMatch[1]);
          }
          // Fallback to raw.value, but only if it's a sane temperature
          if (temp === null && tempAttr.raw?.value !== undefined) {
            const rawVal = tempAttr.raw.value % 256; // Temperature is usually in the lowest byte
            if (rawVal > 0 && rawVal < 120) temp = rawVal;
          }
          if (temp !== null && temp > 0 && temp < 120) {
            drives.push({ device: name, temp, type: 'HDD/SSD' });
            continue;
          }
        }
        // NVMe
        if (data.temperature?.current) {
          drives.push({ device: name, temp: data.temperature.current, type: 'NVMe' });
          continue;
        }
      } catch {
        /* fall through */
      }
    }

    // Fallback: plain smartctl
    const smartPlain = await safeExec('sudo', ['smartctl', '-A', device], { timeout: 5000 });
    if (smartPlain.success) {
      const match = smartPlain.stdout.match(/Temperature_Celsius.*?(\d+)/);
      if (match) {
        drives.push({ device: name, temp: parseInt(match[1]), type: 'HDD/SSD' });
        continue;
      }
    }

    // Fallback: hddtemp
    const hdd = await safeExec('sudo', ['hddtemp', '-n', device], { timeout: 5000 });
    if (hdd.success && hdd.stdout.trim()) {
      const temp = parseInt(hdd.stdout.trim());
      if (!isNaN(temp)) {
        drives.push({ device: name, temp, type: 'HDD/SSD' });
      }
    }
  }

  return drives;
}

module.exports = { getTemperatures };
