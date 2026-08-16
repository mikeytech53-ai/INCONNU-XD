const pino = require('pino');

// Baileys is extremely chatty on 'info' — keep it quiet in production logs.
const logger = pino({ level: process.env.LOG_LEVEL || 'silent' });

module.exports = logger;
