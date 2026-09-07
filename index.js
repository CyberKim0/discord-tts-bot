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
// SLASH COMMANDS
// =========================

client.on("interactionCreate", async (interaction) => {
  if (!interaction.isChatInputCommand()) return;

  const guildId = interaction.guild?.id;

  if (!guildId) {
    return interaction.reply({
      content: "❌ This command can only be used inside a server.",
      ephemeral: true,
    });
  }

  // =========================
  // /join
  // =========================

  if (interaction.commandName === "join") {
    const voiceChannel = interaction.member?.voice?.channel;

    if (!voiceChannel) {
      return interaction.reply(
        "❌ Join a voice channel first."
      );
    }

    const existing = servers.get(guildId);

    if (existing?.connection) {
      return interaction.reply(
        "✅ I'm already in a voice channel."
      );
    }

    createVoiceState(voiceChannel);

    return interaction.reply(
      `🔊 Joined **${voiceChannel.name}**.`
    );
  }

  // =========================
  // /leave
  // =========================

  if (interaction.commandName === "leave") {
    const state = servers.get(guildId);

    if (!state) {
      return interaction.reply(
        "❌ I'm not in a voice channel."
      );
    }

    state.queue = [];
    state.player.stop();

    try {
      state.connection.destroy();
    } catch {}

    servers.delete(guildId);

    return interaction.reply(
      "👋 Left the voice channel."
    );
  }

  // =========================
  // /stop
  // =========================

  if (interaction.commandName === "stop") {
    const state = servers.get(guildId);

    if (!state) {
      return interaction.reply(
        "❌ I'm not in a voice channel."
      );
    }

    state.queue = [];
    state.player.stop();
    state.speaking = false;

    return interaction.reply(
      "🛑 Speech stopped and queue cleared."
    );
  }

  // =========================
  // /say
  // =========================

  if (interaction.commandName === "say") {
    const text = interaction.options
      .getString("message")
      ?.trim();

    if (!text) {
      return interaction.reply(
        "❌ Give me something to say."
      );
    }

    if (text.length > 2000) {
      return interaction.reply(
        "❌ Keep the message under 2000 characters."
      );
    }

    let state = servers.get(guildId);

    // Automatically join user's VC
    if (!state) {
      const voiceChannel = interaction.member?.voice?.channel;

      if (!voiceChannel) {
        return interaction.reply(
          "❌ Join a voice channel first, or use `/join`."
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

    await interaction.reply(
      `📋 Added to speech queue. Position: **${position}**`
    );

    speakNext(guildId);
  }
});

// =========================
// OLD PREFIX COMMANDS
// =========================

client.on("messageCreate", async (message) => {
  if (message.author.bot) return;

  const content = message.content.trim();
  const guildId = message.guild?.id;

  if (!guildId) return;

  // !join
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

  // !leave
  if (content === "!leave") {
    const state = servers.get(guildId);

    if (!state) {
      return message.reply(
        "❌ I'm not in a voice channel."
      );
    }

    state.queue = [];
    state.player.stop();

    try {
      state.connection.destroy();
    } catch {}

    servers.delete(guildId);

    return message.reply(
      "👋 Left the voice channel."
    );
  }

  // !stop
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

  // !say
  if (content.startsWith("!say ")) {
    const text = content.slice(5).trim();

    if (!text) {
      return message.reply(
        "❌ Give me something to say."
      );
    }

    if (text.length > 500) {
      return message.reply(
        "❌ Keep the message under 500 characters."
      );
    }

    let state = servers.get(guildId);

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