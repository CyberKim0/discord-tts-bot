const {
  Client,
  GatewayIntentBits,
} = require("discord.js");

const {
  joinVoiceChannel,
  createAudioPlayer,
  createAudioResource,
  AudioPlayerStatus,
  NoSubscriberBehavior,
} = require("@discordjs/voice");

const gTTS = require("gtts");
const fs = require("fs");
const path = require("path");

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildVoiceStates,
  ],
});

// One voice state per server
const servers = new Map();

client.once("clientReady", () => {
  console.log(`✅ Logged in as ${client.user.tag}`);
});

// =========================
// CREATE VOICE STATE
// =========================

function createVoiceState(voiceChannel) {
  const guildId = voiceChannel.guild.id;

  const connection = joinVoiceChannel({
    channelId: voiceChannel.id,
    guildId,
    adapterCreator: voiceChannel.guild.voiceAdapterCreator,
    selfDeaf: false,
  });

  const player = createAudioPlayer({
    behaviors: {
      noSubscriber: NoSubscriberBehavior.Play,
    },
  });

  connection.subscribe(player);

  const state = {
    connection,
    player,
    queue: [],
    speaking: false,
  };

  servers.set(guildId, state);

  return state;
}

// =========================
// TTS QUEUE
// =========================

async function speakNext(guildId) {
  const state = servers.get(guildId);

  if (!state || state.speaking || state.queue.length === 0) {
    return;
  }

  state.speaking = true;

  const item = state.queue.shift();

  const filePath = path.join(
    __dirname,
    `tts-${Date.now()}.mp3`
  );

  try {
    const tts = new gTTS(
      item.text,
      item.language || "en"
    );

    tts.save(filePath, (error) => {
      if (error) {
        console.error("❌ TTS error:", error);

        if (fs.existsSync(filePath))