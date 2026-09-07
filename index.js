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
  EndBehaviorType,
} = require("@discordjs/voice");

const prism = require("prism-media");
const OpenAI = require("openai");
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
// OPENAI
// =========================

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

// =========================
// VOICE SERVERS
// =========================

const servers = new Map();

client.once("clientReady", () => {
  console.log(`✅ Logged in as ${client.user.tag}`);
});

// =========================
// WAV HEADER
// =========================

function createWavBuffer(pcmData) {
  const sampleRate = 48000;
  const channels = 2;
  const bitsPerSample = 16;

  const header = Buffer.alloc(44);

  header.write("RIFF", 0);
  header.writeUInt32LE(36 + pcmData.length, 4);
  header.write("WAVE", 8);

  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);

  const byteRate =
    sampleRate * channels * (bitsPerSample / 8);

  header.writeUInt32LE(byteRate, 28);

  const blockAlign =
    channels * (bitsPerSample / 8);

  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(bitsPerSample, 34);

  header.write("data", 36);
  header.writeUInt32LE(pcmData.length, 40);

  return Buffer.concat([header, pcmData]);
}

// =========================
// AI RESPONSE
// =========================

async function getAIResponse(text) {
  try {
    const response = await openai.responses.create({
      model: "gpt-5.6-luna",
      input: [
        {
          role: "system",
          content:
            "You are a friendly Discord voice assistant. " +
            "Keep your replies short and natural because they will be spoken aloud.",
        },
        {
          role: "user",
          content: text,
        },
      ],
    });

    return response.output_text?.trim() || "I didn't catch that.";
  } catch (error) {
    console.error("❌ OpenAI error:", error);
    return "Sorry, I couldn't process that.";
  }
}

// =========================
// LISTEN TO USER
// =========================

function listenToUser(state, userId) {
  if (!state || state.listeningUsers.has(userId)) {
    return;
  }

  const guild = state.connection.joinConfig.guildId
    ? client.guilds.cache.get(
        state.connection.joinConfig.guildId
      )
    : null;

  const member = guild?.members.cache.get(userId);

  // Don't listen to bots
  if (member?.user?.bot) {
    return;
  }

  state.listeningUsers.add(userId);

  console.log(`🎤 Listening to ${userId}`);

  const audioStream = state.connection.receiver.subscribe(
    userId,
    {
      end: {
        behavior: EndBehaviorType.AfterSilence,
        duration: 1000,
      },
    }
  );

  const decoder = new prism.opus.Decoder({
    rate: 48000,
    channels: 2,
    frameSize: 960,
  });

  const pcmChunks = [];

  audioStream.pipe(decoder);

  decoder.on("data", (chunk) => {
    pcmChunks.push(chunk);
  });

  decoder.on("end", async () => {
    state.listeningUsers.delete(userId);

    if (pcmChunks.length === 0) {
      return;
    }

    const pcmData = Buffer.concat(pcmChunks);

    // Ignore extremely short audio
    if (pcmData.length < 5000) {
      return;
    }

    const wavData = createWavBuffer(pcmData);

    const filePath = path.join(
      __dirname,
      `voice-${Date.now()}-${Math.random()
        .toString(36)
        .slice(2)}.wav`
    );

    try {
      fs.writeFileSync(filePath, wavData);

      console.log("🧠 Transcribing speech...");

      const transcription =
        await openai.audio.transcriptions.create({
          file: fs.createReadStream(filePath),
          model: "gpt-4o-mini-transcribe",
        });

      const text = transcription.text?.trim();

      if (!text) {
        fs.unlinkSync(filePath);
        return;
      }

      console.log(`👤 User said: ${text}`);

      // =========================
      // AI RESPONSE
      // =========================

      const reply = await getAIResponse(text);

      console.log(`🤖 AI: ${reply}`);

      // =========================
      // SPEAK AI RESPONSE
      // =========================

      state.queue.push({
        text: reply,
        language: "en",
      });

      speakNext(
        state.connection.joinConfig.guildId
      );

      fs.unlinkSync(filePath);

    } catch (error) {
      console.error(
        "❌ Voice processing error:",
        error
      );

      try {
        if (fs.existsSync(filePath)) {
          fs.unlinkSync(filePath);
        }
      } catch {}
    }
  });

  decoder.on("error", (error) => {
    console.error("❌ Audio decoder error:", error);
    state.listeningUsers.delete(userId);
  });
}

// =========================
// CREATE VOICE STATE
// =========================

function createVoiceState(voiceChannel) {
  const guildId = voiceChannel.guild.id;

  const connection = joinVoiceChannel({
    channelId: voiceChannel.id,
    guildId,
    adapterCreator:
      voiceChannel.guild.voiceAdapterCreator,
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
    currentFile: null,
    cleanup: null,

    // NEW
    listeningUsers: new Set(),
  };

  servers.set(guildId, state);

  // =========================
  // VOICE LISTENER
  // =========================

  connection.receiver.speaking.on(
    "start",
    (userId) => {
      listenToUser(state, userId);
    }
  );

  console.log(
    `🎤 Voice listener enabled for ${voiceChannel.guild.name}`
  );

  return state;
}

// =========================
// CLEANUP AUDIO
// =========================

function cleanupCurrent(guildId) {
  const state = servers.get(guildId);

  if (!state) return;

  if (state.currentFile) {
    try {
      if (fs.existsSync(state.currentFile)) {
        fs.unlinkSync(state.currentFile);
      }
    } catch (err) {
      console.error(
        "❌ File cleanup error:",
        err
      );
    }
  }

  state.currentFile = null;
  state.speaking = false;
  state.cleanup = null;
}

// =========================
// TTS QUEUE
// =========================

function speakNext(guildId) {
  const state = servers.get(guildId);

  if (!state) return;

  if (state.speaking) return;

  if (state.queue.length === 0) return;

  state.speaking = true;

  const item = state.queue.shift();

  const filePath = path.join(
    __dirname,
    `tts-${Date.now()}-${Math.random()
      .toString(36)
      .slice(2)}.mp3`
  );

  state.currentFile = filePath;

  try {
    const tts = new gTTS(
      item.text,
      item.language || "en"
    );

    tts.save(filePath, (error) => {
      const currentState = servers.get(guildId);

      if (!currentState) {
        if (fs.existsSync(filePath)) {
          fs.unlinkSync(filePath);
        }

        return;
      }

      if (error) {
        console.error("❌ TTS error:", error);

        cleanupCurrent(guildId);
        speakNext(guildId);

        return;
      }

      try {
        const resource =
          createAudioResource(filePath);

        currentState.player.play(resource);

        console.log(
          `🔊 Speaking: ${item.text}`
        );

        const cleanup = () => {
          const latestState =
            servers.get(guildId);

          if (!latestState) {
            if (fs.existsSync(filePath)) {
              fs.unlinkSync(filePath);
            }

            return;
          }

          if (
            latestState.cleanup !== cleanup
          ) {
            return;
          }

          cleanupCurrent(guildId);

          speakNext(guildId);
        };

        currentState.cleanup = cleanup;

        currentState.player.once(
          AudioPlayerStatus.Idle,
          cleanup
        );

        currentState.player.once(
          "error",
          (err) => {
            console.error(
              "❌ Audio error:",
              err
            );

            cleanup();
          }
        );

      } catch (err) {
        console.error(
          "❌ Playback error:",
          err
        );

        cleanupCurrent(guildId);
        speakNext(guildId);
      }
    });

  } catch (error) {
    console.error("❌ TTS error:", error);

    cleanupCurrent(guildId);
    speakNext(guildId);
  }
}

// =========================
// PREFIX COMMANDS
// =========================

client.on(
  "messageCreate",
  async (message) => {
    if (message.author.bot) return;

    const content =
      message.content.trim();

    const guildId =
      message.guild?.id;

    if (!guildId) return;

    // =========================
    // !command
    // =========================

    if (
      content === "!command" ||
      content === "!commands"
    ) {
      return message.reply(
        "🎙️ **TTS + AI VOICE BOT**\n\n" +

        "🔊 **VOICE**\n" +
        "`!join` — Join your voice channel\n" +
        "`!leave` — Leave the voice channel\n\n" +

        "🧠 **AI VOICE**\n" +
        "Join a voice channel and talk normally.\n" +
        "I'll listen and reply with AI.\n\n" +

        "🗣️ **SPEECH**\n" +
        "`!say <message>` — Make me speak\n" +
        "`!pause` — Pause speech\n" +
        "`!play` — Resume speech\n" +
        "`!skip` — Skip speech\n" +
        "`!stop` — Stop speech\n\n" +

        "📋 **QUEUE**\n" +
        "`!queue` — Show queue\n" +
        "`!clear` — Clear queue\n\n" +

        "📊 **STATUS**\n" +
        "`!status` — Show status"
      );
    }

    // =========================
    // !join
    // =========================

    if (content === "!join") {
      const voiceChannel =
        message.member?.voice?.channel;

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

      createVoiceState(
        voiceChannel
      );

      return message.reply(
        `🎤 Joined **${voiceChannel.name}**.\n` +
        `🧠 AI voice listening is now enabled.`
      );
    }

    // =========================
    // !leave
    // =========================

    if (content === "!leave") {
      const state =
        servers.get(guildId);

      if (!state) {
        return message.reply(
          "❌ I'm not in a voice channel."
        );
      }

      state.queue = [];

      try {
        state.player.stop();
      } catch {}

      try {
        state.connection.destroy();
      } catch {}

      if (state.currentFile) {
        try {
          if (
            fs.existsSync(
              state.currentFile
            )
          ) {
            fs.unlinkSync(
              state.currentFile
            );
          }
        } catch {}
      }

      servers.delete(guildId);

      return message.reply(
        "👋 Left the voice channel."
      );
    }

    // =========================
    // !stop
    // =========================

    if (content === "!stop") {
      const state =
        servers.get(guildId);

      if (!state) {
        return message.reply(
          "❌ I'm not in a voice channel."
        );
      }

      state.queue = [];

      try {
        state.player.stop();
      } catch {}

      cleanupCurrent(guildId);

      return message.reply(
        "🛑 Speech stopped and queue cleared."
      );
    }

    // =========================
    // !pause
    // =========================

    if (content === "!pause") {
      const state =
        servers.get(guildId);

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

      if (
        state.player.state.status ===
        AudioPlayerStatus.Paused
      ) {
        return message.reply(
          "⏸️ Speech is already paused."
        );
      }

      if (
        state.player.state.status !==
        AudioPlayerStatus.Playing
      ) {
        return message.reply(
          "❌ Nothing is currently playing."
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
      const state =
        servers.get(guildId);

      if (!state) {
        return message.reply(
          "❌ I'm not in a voice channel."
        );
      }

      if (
        state.player.state.status !==
        AudioPlayerStatus.Paused
      ) {
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
    // !skip
    // =========================

    if (content === "!skip") {
      const state =
        servers.get(guildId);

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

      state.player.stop();

      return message.reply(
        "⏭️ Skipped current speech."
      );
    }

    // =========================
    // !queue
    // =========================

    if (content === "!queue") {
      const state =
        servers.get(guildId);

      if (!state) {
        return message.reply(
          "❌ I'm not in a voice channel."
        );
      }

      if (
        state.queue.length === 0 &&
        !state.speaking
      ) {
        return message.reply(
          "📋 The speech queue is empty."
        );
      }

      let response =
        "📋 **Speech Queue**\n\n";

      if (state.speaking) {
        response +=
          "🔊 **Currently speaking**\n\n";
      }

      if (state.queue.length > 0) {
        state.queue.forEach(
          (item, index) => {
            const text =
              item.text.length > 100
                ? item.text.slice(0, 100) +
                  "..."
                : item.text;

            response +=
              `**${index + 1}.** ${text}\n`;
          }
        );
      } else {
        response +=
          "No messages waiting.";
      }

      return message.reply(response);
    }

    // =========================
    // !clear
    // =========================

    if (content === "!clear") {
      const state =
        servers.get(guildId);

      if (!state) {
        return message.reply(
          "❌ I'm not in a voice channel."
        );
      }

      if (state.queue.length === 0) {
        return message.reply(
          "📋 The queue is already empty."
        );
      }

      const amount =
        state.queue.length;

      state.queue = [];

      return message.reply(
        `🧹 Cleared **${amount}** queued message(s).`
      );
    }

    // =========================
    // !status
    // =========================

    if (content === "!status") {
      const state =
        servers.get(guildId);

      if (!state) {
        return message.reply(
          "🔴 I'm not in a voice channel."
        );
      }

      let status = "⏹️ Idle";

      if (
        state.player.state.status ===
        AudioPlayerStatus.Playing
      ) {
        status = "🟢 Playing";
      }

      if (
        state.player.state.status ===
        AudioPlayerStatus.Paused
      ) {
        status = "⏸️ Paused";
      }

      return message.reply(
        `🎙️ **TTS Status**\n\n` +
        `Status: ${status}\n` +
        `Queue: **${state.queue.length}**\n` +
        `🎤 Voice listener: **ON**`
      );
    }

    // =========================
    // !say
    // =========================

    if (content.startsWith("!say ")) {
      const text =
        content.slice(5).trim();

      if (!text) {
        return message.reply(
          "❌ Give me something to say."
        );
      }

      if (text.length > 2000) {
        return message.reply(
          "❌ Keep the message under 2000 characters."
        );
      }

      let state =
        servers.get(guildId);

      if (!state) {
        const voiceChannel =
          message.member?.voice?.channel;

        if (!voiceChannel) {
          return message.reply(
            "❌ Join a voice channel first, or use `!join`."
          );
        }

        state =
          createVoiceState(
            voiceChannel
          );
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
  }
);

// =========================
// LOGIN
// =========================

client.login(
  process.env.DISCORD_TOKEN
);