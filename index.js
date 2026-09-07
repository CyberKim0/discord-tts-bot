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

// =========================
// VOICE SERVERS
// =========================

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

        if (fs.existsSync(filePath)) {
          fs.unlinkSync(filePath);
        }

        state.speaking = false;
        speakNext(guildId);
        return;
      }

      try {
        const resource = createAudioResource(filePath);

        state.player.play(resource);

        console.log(`🔊 Speaking: ${item.text}`);

        const cleanup = () => {
          if (fs.existsSync(filePath)) {
            fs.unlinkSync(filePath);
          }

          state.speaking = false;
          speakNext(guildId);
        };

        state.player.once(
          AudioPlayerStatus.Idle,
          cleanup
        );

        state.player.once("error", (err) => {
          console.error("❌ Audio error:", err);
          cleanup();
        });

      } catch (err) {
        console.error("❌ Playback error:", err);

        if (fs.existsSync(filePath)) {
          fs.unlinkSync(filePath);
        }

        state.speaking = false;
        speakNext(guildId);
      }
    });

  } catch (error) {
    console.error("❌ TTS error:", error);

    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
    }

    state.speaking = false;
    speakNext(guildId);
  }
}

// =========================
// PREFIX COMMANDS
// =========================

client.on("messageCreate", async (message) => {
  if (message.author.bot) return;

  const content = message.content.trim();
  const guildId = message.guild?.id;

  if (!guildId) return;

  // =========================
  // !join
  // =========================

  if (content === "!join") {
    const voiceChannel = message.member?.voice?.channel;

    if (!voiceChannel) {
      return message.reply(
        "❌ Join a voice channel first."
      );
    }

    if (servers.get(guildId)) {
      return message.reply(
        "✅ I'm already in a voice channel."
      );
    }

    createVoiceState(voiceChannel);

    return message.reply(
      `🔊 Joined **${voiceChannel.name}**.`
    );
  }

  // =========================
  // !leave
  // =========================

  if (content === "!leave") {
    const state = servers.get(guildId);

    if (!state) {
      return message.reply(
        "❌ I'm not in a voice channel."
      );
    }

    state.queue = [];
    state.player.stop();
    state.speaking = false;

    try {
      state.connection.destroy();
    } catch {}

    servers.delete(guildId);

    return message.reply(
      "👋 Left the voice channel."
    );
  }

  // =========================
  // !stop
  // =========================

  if (content === "!stop") {
    const state = servers.get(guildId);

    if (!state) {
      return message.reply(
        "❌ I'm not in a voice channel."
      );
    }

    state.queue = [];
    state.player.stop();
    state.speaking = false;

    return message.reply(
      "🛑 Speech stopped and queue cleared."
    );
  }

  // =========================
  // !pause
  // =========================

  if (content === "!pause") {
    const state = servers.get(guildId);

    if (!state) {
      return message.reply(
        "❌ I'm not in a voice channel."
      );
    }

    if (!state.speaking) {
      return message.reply(
        "❌ Nothing is currently playing."
      );
    }

    if (state.player.state.status === AudioPlayerStatus.Paused) {
      return message.reply(
        "⏸️ Speech is already paused."
      );
    }

    state.player.pause();

    return message.reply(
      "⏸️ Speech paused."
    );
  }

  // =========================
  // !play
  // =========================

  if (content === "!play") {
    const state = servers.get(guildId);

    if (!state) {
      return message.reply(
        "❌ I'm not in a voice channel."
      );
    }

    if (state.player.state.status !== AudioPlayerStatus.Paused) {
      return message.reply(
        "▶️ Nothing is paused."
      );
    }

    state.player.unpause();

    return message.reply(
      "▶️ Speech resumed."
    );
  }

  // =========================
  // !say
  // =========================

  if (content.startsWith("!say ")) {
    const text = content.slice(5).trim();

    if (!text) {
      return message.reply(
        "❌ Give me something to say."
      );
    }

    // 2,000 character limit
    if (text.length > 2000) {
      return message.reply(
        "❌ Keep the message under 2000 characters."
      );
    }

    let state = servers.get(guildId);

    // Automatically join user's VC
    if (!state) {
      const voiceChannel = message.member?.voice?.channel;

      if (!voiceChannel) {
        return message.reply(
          "❌ Join a voice channel first, or use `!join`."
        );
      }

      state = createVoiceState(voiceChannel);
    }

    state.queue.push({
      text,
      language: "en",
    });

    const position =
      state.queue.length +
      (state.speaking ? 1 : 0);

    await message.reply(
      `📋 Added to speech queue. Position: **${position}**`
    );

    speakNext(guildId);
  }
});

// =========================
// LOGIN
// =========================

client.login(process.env.DISCORD_TOKEN);