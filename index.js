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

const fs = require("fs");
const path = require("path");

// =========================
// CLIENT
// =========================

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

// =========================
// READY
// =========================

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
    console.log(`🧠 Sending to AI: ${text}`);

    const response = await openai.responses.create({
      model: "gpt-5.6-luna",
      input: [
        {
          role: "system",
          content:
            "You are a friendly Discord voice assistant. " +
            "Reply naturally and briefly because your response will be spoken aloud. " +
            "Do not use markdown, emojis, or long paragraphs.",
        },
        {
          role: "user",
          content: text,
        },
      ],
    });

    const reply =
      response.output_text?.trim() ||
      "I didn't catch that.";

    console.log(`🤖 AI replied: ${reply}`);

    return reply;
  } catch (error) {
    console.error("❌ OpenAI response error:", error);

    return "Sorry, I couldn't process that.";
  }
}

// =========================
// OPENAI TEXT TO SPEECH
// =========================

async function createSpeechFile(text) {
  const filePath = path.join(
    __dirname,
    `tts-${Date.now()}-${Math.random()
      .toString(36)
      .slice(2)}.mp3`
  );

  try {
    console.log("🔊 Generating AI voice...");

    const speech = await openai.audio.speech.create({
      model: "gpt-4o-mini-tts",
      voice: "alloy",
      input: text,
      response_format: "mp3",
    });

    const buffer = Buffer.from(
      await speech.arrayBuffer()
    );

    await fs.promises.writeFile(
      filePath,
      buffer
    );

    console.log("✅ Voice file created.");

    return filePath;
  } catch (error) {
    console.error(
      "❌ OpenAI TTS error:",
      error
    );

    try {
      if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
      }
    } catch {}

    return null;
  }
}

// =========================
// LISTEN TO USER
// =========================

function listenToUser(state, userId) {
  if (!state) return;

  if (state.listeningUsers.has(userId)) {
    return;
  }

  const guildId =
    state.connection.joinConfig.guildId;

  const guild =
    client.guilds.cache.get(guildId);

  const member =
    guild?.members.cache.get(userId);

  // Ignore bots
  if (member?.user?.bot) {
    return;
  }

  state.listeningUsers.add(userId);

  console.log(
    `🎤 Voice detected from user ${userId}`
  );

  let audioStream;

  try {
    audioStream =
      state.connection.receiver.subscribe(
        userId,
        {
          end: {
            behavior:
              EndBehaviorType.AfterSilence,
            duration: 1000,
          },
        }
      );
  } catch (error) {
    console.error(
      "❌ Could not subscribe to voice:",
      error
    );

    state.listeningUsers.delete(userId);
    return;
  }

  const decoder = new prism.opus.Decoder({
    rate: 48000,
    channels: 2,
    frameSize: 960,
  });

  const pcmChunks = [];

  audioStream.on("error", (error) => {
    console.error(
      "❌ Discord audio stream error:",
      error
    );
  });

  decoder.on("error", (error) => {
    console.error(
      "❌ Opus decoder error:",
      error
    );

    state.listeningUsers.delete(userId);
  });

  audioStream.pipe(decoder);

  decoder.on("data", (chunk) => {
    pcmChunks.push(chunk);
  });

  decoder.on("end", async () => {
    state.listeningUsers.delete(userId);

    console.log(
      `🎤 Finished listening to ${userId}`
    );

    if (pcmChunks.length === 0) {
      console.log("⚠️ No audio received.");
      return;
    }

    const pcmData =
      Buffer.concat(pcmChunks);

    if (pcmData.length < 5000) {
      console.log(
        "⚠️ Voice recording was too short."
      );
      return;
    }

    const wavData =
      createWavBuffer(pcmData);

    const filePath = path.join(
      __dirname,
      `voice-${Date.now()}-${Math.random()
        .toString(36)
        .slice(2)}.wav`
    );

    try {
      await fs.promises.writeFile(
        filePath,
        wavData
      );

      console.log(
        "🧠 Transcribing voice..."
      );

      const transcription =
        await openai.audio.transcriptions.create(
          {
            file:
              fs.createReadStream(
                filePath
              ),
            model:
              "gpt-4o-mini-transcribe",
          }
        );

      const text =
        transcription.text?.trim();

      if (!text) {
        console.log(
          "⚠️ No speech detected."
        );

        await fs.promises.unlink(
          filePath
        );

        return;
      }

      console.log(
        `👤 User said: ${text}`
      );

      // =========================
      // AI RESPONSE
      // =========================

      const reply =
        await getAIResponse(text);

      // =========================
      // CREATE AI VOICE
      // =========================

      const speechFile =
        await createSpeechFile(
          reply
        );

      if (!speechFile) {
        await fs.promises.unlink(
          filePath
        );

        return;
      }

      // =========================
      // ADD TO QUEUE
      // =========================

      state.queue.push({
        filePath: speechFile,
        text: reply,
      });

      console.log(
        `📋 Added AI reply to voice queue. Queue: ${state.queue.length}`
      );

      speakNext(guildId);

      // Remove input WAV
      try {
        await fs.promises.unlink(
          filePath
        );
      } catch {}

    } catch (error) {
      console.error(
        "❌ Voice processing error:",
        error
      );

      try {
        if (fs.existsSync(filePath)) {
          await fs.promises.unlink(
            filePath
          );
        }
      } catch {}
    }
  });
}

// =========================
// CREATE VOICE STATE
// =========================

function createVoiceState(
  voiceChannel
) {
  const guildId =
    voiceChannel.guild.id;

  const connection =
    joinVoiceChannel({
      channelId:
        voiceChannel.id,

      guildId,

      adapterCreator:
        voiceChannel.guild
          .voiceAdapterCreator,

      selfDeaf: false,
      selfMute: false,
    });

  const player =
    createAudioPlayer({
      behaviors: {
        noSubscriber:
          NoSubscriberBehavior.Play,
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

    listeningUsers: new Set(),
  };

  servers.set(
    guildId,
    state
  );

  // =========================
  // VOICE LISTENER
  // =========================

  connection.receiver.speaking.on(
    "start",
    (userId) => {
      listenToUser(
        state,
        userId
      );
    }
  );

  console.log(
    `🎤 Voice listener enabled for ${voiceChannel.guild.name}`
  );

  return state;
}

// =========================
// CLEANUP CURRENT AUDIO
// =========================

function cleanupCurrent(
  guildId
) {
  const state =
    servers.get(guildId);

  if (!state) return;

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
    } catch (error) {
      console.error(
        "❌ File cleanup error:",
        error
      );
    }
  }

  state.currentFile = null;
  state.speaking = false;
  state.cleanup = null;
}

// =========================
// SPEAK NEXT
// =========================

function speakNext(
  guildId
) {
  const state =
    servers.get(guildId);

  if (!state) return;

  if (state.speaking) {
    return;
  }

  if (state.queue.length === 0) {
    return;
  }

  state.speaking = true;

  const item =
    state.queue.shift();

  const filePath =
    item.filePath;

  state.currentFile =
    filePath;

  try {
    console.log(
      `🔊 Playing AI voice: ${item.text}`
    );

    const resource =
      createAudioResource(
        filePath
      );

    state.player.play(
      resource
    );

    const cleanup =
      () => {
        const latestState =
          servers.get(guildId);

        if (!latestState) {
          try {
            if (
              fs.existsSync(
                filePath
              )
            ) {
              fs.unlinkSync(
                filePath
              );
            }
          } catch {}

          return;
        }

        if (
          latestState.cleanup !==
          cleanup
        ) {
          return;
        }

        cleanupCurrent(
          guildId
        );

        console.log(
          "✅ Finished speaking."
        );

        speakNext(
          guildId
        );
      };

    state.cleanup =
      cleanup;

    state.player.once(
      AudioPlayerStatus.Idle,
      cleanup
    );

    state.player.once(
      "error",
      (error) => {
        console.error(
          "❌ Audio player error:",
          error
        );

        cleanup();
      }
    );

  } catch (error) {
    console.error(
      "❌ Playback error:",
      error
    );

    try {
      if (
        fs.existsSync(
          filePath
        )
      ) {
        fs.unlinkSync(
          filePath
        );
      }
    } catch {}

    cleanupCurrent(
      guildId
    );

    speakNext(
      guildId
    );
  }
}

// =========================
// PREFIX COMMANDS
// =========================

client.on(
  "messageCreate",
  async (message) => {
    if (message.author.bot) {
      return;
    }

    const content =
      message.content.trim();

    const guildId =
      message.guild?.id;

    if (!guildId) {
      return;
    }

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
        "I'll listen, think, and reply with AI.\n\n" +

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

      if (
        servers.get(guildId)
      ) {
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

      // Clean queued audio files
      for (
        const item of state.queue
      ) {
        try {
          if (
            item.filePath &&
            fs.existsSync(
              item.filePath
            )
          ) {
            fs.unlinkSync(
              item.filePath
            );
          }
        } catch {}
      }

      servers.delete(
        guildId
      );

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

      for (
        const item of state.queue
      ) {
        try {
          if (
            item.filePath &&
            fs.existsSync(
              item.filePath
            )
          ) {
            fs.unlinkSync(
              item.filePath
            );
          }
        } catch {}
      }

      state.queue = [];

      try {
        state.player.stop();
      } catch {}

      cleanupCurrent(
        guildId
      );

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

      if (
        state.queue.length > 0
      ) {
        state.queue.forEach(
          (item, index) => {
            const text =
              item.text.length > 100
                ? item.text.slice(
                    0,
                    100
                  ) + "..."
                : item.text;

            response +=
              `**${index + 1}.** ${text}\n`;
          }
        );
      } else {
        response +=
          "No messages waiting.";
      }

      return message.reply(
        response
      );
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

      if (
        state.queue.length === 0
      ) {
        return message.reply(
          "📋 The queue is already empty."
        );
      }

      const amount =
        state.queue.length;

      for (
        const item of state.queue
      ) {
        try {
          if (
            item.filePath &&
            fs.existsSync(
              item.filePath
            )
          ) {
            fs.unlinkSync(
              item.filePath
            );
          }
        } catch {}
      }

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

      let status =
        "⏹️ Idle";

      if (
        state.player.state.status ===
        AudioPlayerStatus.Playing
      ) {
        status =
          "🟢 Playing";
      }

      if (
        state.player.state.status ===
        AudioPlayerStatus.Paused
      ) {
        status =
          "⏸️ Paused";
      }

      return message.reply(
        `🎙️ **TTS + AI Status**\n\n` +
        `Status: ${status}\n` +
        `Queue: **${state.queue.length}**\n` +
        `🎤 Voice listener: **ON**\n` +
        `🧠 AI: **READY**`
      );
    }

    // =========================
    // !say
    // =========================

    if (
      content.startsWith("!say ")
    ) {
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

      const speechFile =
        await createSpeechFile(
          text
        );

      if (!speechFile) {
        return message.reply(
          "❌ I couldn't generate the voice."
        );
      }

      state.queue.push({
        filePath: speechFile,
        text,
      });

      const position =
        state.queue.length +
        (state.speaking ? 1 : 0);

      await message.reply(
        `📋 Added to speech queue. Position: **${position}**`
      );

      speakNext(
        guildId
      );
    }
  }
);

// =========================
// LOGIN
// =========================

client.login(
  process.env.DISCORD_TOKEN
);