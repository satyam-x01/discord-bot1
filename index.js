require('dotenv').config();

const fs = require('node:fs');
const path = require('node:path');
const { Client, GatewayIntentBits, Events, PermissionFlagsBits } = require('discord.js');
const { containsProfanity, profanityTermCount } = require('./profanity-filter');
const { containsAiProfanity } = require('./gemini-moderation');

const token = process.env.DISCORD_TOKEN;
if (!token) {
  console.error('Missing DISCORD_TOKEN. Copy .env.example to .env and add your bot token.');
  process.exit(1);
}

const timeouts = [60_000, 5 * 60_000, 30 * 60_000, 2 * 60 * 60_000, 24 * 60 * 60_000];
const timeoutLabels = ['1 minute', '5 minutes', '30 minutes', '2 hours', '24 hours'];
const violationWindow = 30 * 24 * 60 * 60_000;
const dataPath = path.resolve(process.env.DATA_PATH || path.join(__dirname, 'data.json'));

function loadData() {
  try { return JSON.parse(fs.readFileSync(dataPath, 'utf8')); }
  catch (error) {
    if (error.code !== 'ENOENT') console.error('Could not read data.json; starting with empty history.', error);
    return {};
  }
}
let history = loadData();
function saveData() {
  const tempPath = dataPath + '.tmp';
  fs.writeFileSync(tempPath, JSON.stringify(history, null, 2));
  fs.renameSync(tempPath, dataPath);
}

function isImageAttachment(attachment) {
  if (attachment.contentType?.toLowerCase().startsWith('image/')) return true;
  return /\.(avif|bmp|gif|jpe?g|png|tiff?|webp)$/iu.test(attachment.name || attachment.url);
}

function recordIncident(key) {
  const now = Date.now();
  const recent = (history[key] || []).filter((timestamp) => now - timestamp < violationWindow);
  recent.push(now);
  history[key] = recent;
  saveData();
  const level = Math.min(recent.length, timeouts.length) - 1;
  return { count: recent.length, duration: timeouts[level], label: timeoutLabels[level] };
}

const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent] });

client.once(Events.ClientReady, (readyClient) => {
  console.log('Moderation bot ready as ' + readyClient.user.tag);
  console.log('Offline profanity filter ready with ' + profanityTermCount.toLocaleString() + ' entries.');
  console.log(process.env.GEMINI_API_KEY ? 'Gemini spelling/context moderation enabled.' : 'Gemini disabled; add GEMINI_API_KEY to .env to enable AI checks.');
});

client.on(Events.MessageCreate, async (message) => {
  if (!message.guild || message.author.bot) return;
  if (process.env.GUILD_ID && message.guild.id !== process.env.GUILD_ID) return;

  const hasImage = message.attachments.some(isImageAttachment);
  let hasProfanity = containsProfanity(message.content);
  if (!hasProfanity && message.content.trim() && process.env.GEMINI_API_KEY) {
    try {
      hasProfanity = await containsAiProfanity(message.content);
    } catch (error) {
      console.error('Gemini moderation check failed; continuing with offline detection:', error.message);
    }
  }
  if (!hasImage && !hasProfanity) return;

  const me = message.guild.members.me;
  if (hasImage) {
    if (!me?.permissionsIn(message.channel).has(PermissionFlagsBits.ManageMessages)) {
      console.error('Missing Manage Messages permission in ' + message.guild.name);
      return;
    }
    try {
      // Remove the image immediately, including images posted by server admins.
      await message.delete();
    } catch (error) {
      console.error('Could not delete image message from ' + message.author.tag + ':', error);
      return;
    }
  }

  if (hasProfanity) {
    if (!me?.permissionsIn(message.channel).has(PermissionFlagsBits.ManageMessages)) {
      console.error('Missing Manage Messages permission to delete profane message in ' + message.guild.name);
    } else {
      try {
        await message.delete();
      } catch (error) {
        console.error('Could not delete profane message from ' + message.author.tag + ':', error);
      }
    }
  }

  if (hasImage && !me?.permissions.has(PermissionFlagsBits.ModerateMembers)) {
    console.error('Missing Moderate Members permission in ' + message.guild.name);
    return;
  }
  if (hasProfanity && !me?.permissions.has(PermissionFlagsBits.ModerateMembers)) {
    console.error('Missing Moderate Members permission in ' + message.guild.name);
    return;
  }

  // Keep image and profanity escalation histories separate.
  for (const violation of [
    ...(hasImage ? [{ kind: 'image', reason: 'Posting an image is not allowed' }] : []),
    ...(hasProfanity ? [{ kind: 'profanity', reason: 'Profanity detected' }] : []),
  ]) {
    const historyKey = violation.kind === 'profanity'
      ? message.guild.id + ':' + message.author.id
      : 'image:' + message.guild.id + ':' + message.author.id;
    const incident = recordIncident(historyKey);
    try {
      await message.member.timeout(incident.duration, violation.reason + ' (incident ' + incident.count + ')');
      const detail = violation.kind === 'image' ? 'for posting an image' : 'for using prohibited language';
      await message.channel.send({
        content: message.author + ' was timed out for **' + incident.label + '** ' + detail + '. Further incidents can lead to a 24-hour timeout.',
        allowedMentions: { users: [message.author.id] },
      });
    } catch (error) {
      console.error('Could not timeout ' + message.author.tag + ':', error);
      const detail = hasImage ? 'The image was removed, but ' : '';
      await message.channel.send(detail + 'I could not apply the timeout. Check my **Moderate Members** permission, role position, and whether the member has Administrator permission.');
      break;
    }
  }
});

client.login(token).catch((error) => {
  if (error.code === 'TokenInvalid') {
    console.error('Discord rejected DISCORD_TOKEN. Reset the bot token in the Developer Portal, update .env, and try again.');
  } else {
    console.error('Could not connect the bot to Discord:', error.message);
  }
  process.exitCode = 1;
});
