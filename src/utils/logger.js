const pino = require('pino');
const config = require('../../config');

const level = process.env.LOG_LEVEL || (process.env.DEBUG === 'true' ? 'debug' : 'info');

const transport =
  process.env.NODE_ENV === 'production'
    ? undefined
    : {
        target: 'pino-pretty',
        options: {
          colorize: true,
          translateTime: `SYS:standard`,
          ignore: 'pid,hostname',
        },
      };

const logger = pino({
  level,
  ...(transport ? { transport } : {}),
  timestamp: () => `,"time":"${new Date().toLocaleString('en-US', { timeZone: config.TIMEZONE, hour12: false })}"`,
  formatters: {
    level(label) {
      return { level: label.toUpperCase() };
    },
  },
});

module.exports = logger;
