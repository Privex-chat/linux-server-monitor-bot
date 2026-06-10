function escapeCodeBlock(text) {
  return String(text || '')
    .replace(/```/g, '`\u200b``')
    .replace(/@/g, '@\u200b');
}

function codeBlock(text, maxLength = 1900) {
  const safe = escapeCodeBlock(text).substring(0, maxLength);
  return `\`\`\`\n${safe}\n\`\`\``;
}

function noMentions() {
  return { parse: [] };
}

function withNoMentions(payload) {
  if (typeof payload === 'string') {
    return { content: payload, allowedMentions: noMentions() };
  }
  return { ...payload, allowedMentions: payload.allowedMentions || noMentions() };
}

async function sendNoMentions(target, payload) {
  return target.send(withNoMentions(payload));
}

module.exports = { escapeCodeBlock, codeBlock, noMentions, withNoMentions, sendNoMentions };
