function getTimestamp() {
  return new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' });
}

module.exports = {
  info: (...args) => console.log(`[${getTimestamp()}] [INFO]`, ...args),
  warn: (...args) => console.warn(`[${getTimestamp()}] [WARN]`, ...args),
  error: (...args) => console.error(`[${getTimestamp()}] [ERROR]`, ...args),
  debug: (...args) => {
    if (process.env.DEBUG === 'true') {
      console.debug(`[${getTimestamp()}] [DEBUG]`, ...args);
    }
  },
};
