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
const { GoogleGenAI } = require("@google/genai");
const gTTS = require("gtts");

const fs = require("fs");
const path = require("path");

// ==================================================
// GEMINI
// ==================================================

const gemini = new GoogleGenAI({
  apiKey: process.env.GEMINI_API_KEY,
});

const AI_MODEL = "gemini-3.8-flash";
const TRANSCRIBE_MODEL = "gemini-3.5-transcribe";

// ==================================================
// DISCORD CLIENT
// ==================================================

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildVoiceStates,
  ],
});

// ==================================================
// VOICE SERVERS
// ==================================================

const servers = new Map();

client.once("clientReady", () => {
  console.log(`✅ Logged in as ${client.user.tag}`);
  console.log("🧠 Gemini AI enabled");
});

// ==================================================
// WAV HEADER
// ==================================================

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

// ==================================================
// GEMINI TRANSCRIPTION
// ==================================================

async function transcribeAudio(filePath) {
  try {
    console.log("🧠 Uploading audio to Gemini...");

    const audioFile = await gemini.files.upload({
      file: filePath,
      config: {
        mimeType: "audio/wav",
      },
    });

    console.log("🧠 Transcribing with Gemini...");

    const response =
      await gemini.models.generateContent({
        model: TRANSCRIBE_MODEL,

        contents: [
          {
            fileData: {
              fileUri: audioFile.uri,
              mimeType: audioFile.mimeType || "audio/wav",
            },
          },
        ],

        config: {
          systemInstruction:
            "Transcribe the speech accurately. " +
            "Return only the words that were spoken. " +
            "Do not explain anything.",

          temperature: 0,
        },
      });

    const text =
      response.text?.trim();

    if (!text) {
      return null;
    }

    return text;

  } catch (error) {
    console.error(
      "❌ Gemini transcription error:",
      error.status || "",
      error.message || error
    );

    return null;
  }
}

// ==================================================
// GEMINI AI RESPONSE
// ==================================================

async function getAIResponse(text) {
  try {
    console.log("🤖 Asking Gemini...");

    const response =
      await gemini.models.generateContent({
        model: AI_MODEL,

        contents: text,

        config: {
          systemInstruction:
            "You are a fast and friendly Discord voice assistant " +
            "specialized in cybersecurity, ethical hacking, " +
            "Linux, networking, programming and CTFs. " +

            "Answer normal cybersecurity and ethical-hacking " +
            "questions directly and clearly. " +

            "For hacking questions, focus on authorized testing, " +
            "CTFs, labs, defensive security and systems the user " +
            "owns or has permission to test. " +

            "Do not unnecessarily refuse harmless educational " +
            "cybersecurity questions. " +

            "Keep spoken answers short and natural, usually " +
            "one to four sentences. " +

            "Do not use markdown, emojis, bullet points, " +
            "or long explanations.",

          temperature: 0.3,

          maxOutputTokens: 250,
        },
      });

    return (
      response.text?.trim() ||
      "I don't have an answer for that."
    );

  } catch (error) {
    console.error(
      "❌ Gemini response error:",
      error.status || "",
      error.message || error
    );

    if (error.status === 429) {
      return "Gemini is temporarily rate limited. Try again in a moment.";
    }

    return "I couldn't process that right now.";
  }
}

// ==================================================
// LISTEN TO USER
// ==================================================

function listenToUser(state, userId) {
  if (
    !state ||
    state.listeningUsers.has(userId) ||
    state.processing
  ) {
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
            duration: 800,
          },
        }
      );
  } catch (error) {
    console.error(
      "❌ Voice receiver error:",
      error.message || error
    );

    state.listeningUsers.delete(userId);

    return;
  }

  const decoder =
    new prism.opus.Decoder({
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

    console.log(
      `🎤 Finished listening to ${userId}`
    );

    if (pcmChunks.length === 0) {
      return;
    }

    const pcmData =
      Buffer.concat(pcmChunks);

    // Ignore extremely short audio
    if (pcmData.length < 12000) {
      console.log("⚠️ Audio too short.");
      return;
    }

    const wavData =
      createWavBuffer(pcmData);

    const filePath =
      path.join(
        __dirname,
        `voice-${Date.now()}-${Math.random()
          .toString(36)
          .slice(2)}.wav`
      );

    try {
      fs.writeFileSync(
        filePath,
        wavData
      );

      state.processing = true;

      // ------------------------------------------
      // TRANSCRIPTION
      // ------------------------------------------

      const text =
        await transcribeAudio(filePath);

      if (!text) {
        console.log(
          "⚠️ No speech detected."
        );

        state.processing = false;

        if (fs.existsSync(filePath)) {
          fs.unlinkSync(filePath);
        }

        return;
      }

      console.log(
        `👤 User said: ${text}`
      );

      // ------------------------------------------
      // AI RESPONSE
      // ------------------------------------------

      const reply =
        await getAIResponse(text);

      console.log(
        `🤖 Gemini: ${reply}`
      );

      state.processing = false;

      // ------------------------------------------
      // SPEECH QUEUE
      // ------------------------------------------

      state.queue.push({
        text: reply,
        language: "en",
      });

      speakNext(guildId);

      // ------------------------------------------
      // DELETE TEMP FILE
      // ------------------------------------------

      if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
      }

    } catch (error) {
      state.processing = false;

      console.error(
        "❌ Voice processing error:",
        error.message || error
      );

      try {
        if (fs.existsSync(filePath)) {
          fs.unlinkSync(filePath);
        }
      } catch {}
    }
  });

  decoder.on("error", (error) => {
    console.error(
      "❌ Audio decoder error:",
      error.message || error
    );

    state.listeningUsers.delete(userId);
    state.processing = false;
  });
}

// ==================================================
// CREATE VOICE STATE
// ==================================================

function createVoiceState(voiceChannel) {
  const guildId =
    voiceChannel.guild.id;

  const connection =
    joinVoiceChannel({
      channelId: voiceChannel.id,
      guildId,

      adapterCreator:
        voiceChannel.guild.voiceAdapterCreator,

      selfDeaf: false,
    });

  const player =
    createAudioPlayer({
      behaviors: {
        noSubscriber:
          NoSubscriberBehavior.Play,
      },
    });

  connection.subscribe(player);

  // Permanent player error listener
  player.on("error", (error) => {
    console.error(
      "❌ Audio player error:",
      error.message || error
    );
  });

  const state = {
    connection,
    player,

    queue: [],

    speaking: false,

    currentFile: null,

    cleanup: null,

    listeningUsers:
      new Set(),

    processing: false,
  };

  servers.set(
    guildId,
    state
  );

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

// ==================================================
// CLEANUP AUDIO
// ==================================================

function cleanupCurrent(guildId) {
  const state =
    servers.get(guildId);

  if (!state) {
    return;
  }

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

  state.currentFile = null;
  state.speaking = false;
  state.cleanup = null;
}

// ==================================================
// TTS QUEUE
// ==================================================

function speakNext(guildId) {
  const state =
    servers.get(guildId);

  if (!state) {
    return;
  }

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
    path.join(
      __dirname,
      `tts-${Date.now()}-${Math.random()
        .toString(36)
        .slice(2)}.mp3`
    );

  state.currentFile =
    filePath;

  try {
    const tts =
      new gTTS(
        item.text,
        item.language || "en"
      );

    tts.save(
      filePath,
      (error) => {
        const currentState =
          servers.get(guildId);

        if (!currentState) {
          try {
            if (fs.existsSync(filePath)) {
              fs.unlinkSync(filePath);
            }
          } catch {}

          return;
        }

        if (error) {
          console.error(
            "❌ TTS error:",
            error.message || error
          );

          cleanupCurrent(guildId);
          speakNext(guildId);

          return;
        }

        try {
          const resource =
            createAudioResource(
              filePath
            );

          currentState.player.play(
            resource
          );

          console.log(
            `🔊 Speaking: ${item.text}`
          );

          const cleanup = () => {
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

            cleanupCurrent(guildId);

            speakNext(guildId);
          };

          currentState.cleanup =
            cleanup;

          currentState.player.once(
            AudioPlayerStatus.Idle,
            cleanup
          );

        } catch (error) {
          console.error(
            "❌ Playback error:",
            error.message || error
          );

          cleanupCurrent(guildId);
          speakNext(guildId);
        }
      }
    );

  } catch (error) {
    console.error(
      "❌ TTS error:",
      error.message || error
    );

    cleanupCurrent(guildId);
    speakNext(guildId);
  }
}

// ==================================================
// PREFIX COMMANDS
// ==================================================

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

    // ==================================================
    // !COMMAND
    // ==================================================

    if (
      content === "!command" ||
      content === "!commands"
    ) {
      return message.reply(
        "🎙️ **GEMINI TTS VOICE BOT**\n\n" +

        "🔊 **VOICE**\n" +
        "`!join` — Join your voice channel\n" +
        "`!leave` — Leave the voice channel\n\n" +

        "🧠 **AI VOICE**\n" +
        "Join a voice channel and talk normally.\n" +
        "Gemini will listen and reply.\n\n" +

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

    // ==================================================
    // !JOIN
    // ==================================================

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
        `🧠 Gemini voice listening is now enabled.`
      );
    }

    // ==================================================
    // !LEAVE
    // ==================================================

    if (content === "!leave") {
      const state =
        servers.get(guildId);

      if (!state) {
        return message.reply(
          "❌ I'm not in a voice channel."
        );
      }

      state.queue = [];
      state.processing = false;
      state.listeningUsers.clear();

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

    // ==================================================
    // !STOP
    // ==================================================

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

    // ==================================================
    // !PAUSE
    // ==================================================

    if (content === "!pause") {
      const state =
        servers.get(guildId);

      if (!state) {
        return message.reply(
          "❌ I'm not in a voice channel."
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

    // ==================================================
    // !PLAY
    // ==================================================

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

    // ==================================================
    // !SKIP
    // ==================================================

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

    // ==================================================
    // !QUEUE
    // ==================================================

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
                ? item.text.slice(0, 100) + "..."
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

    // ==================================================
    // !CLEAR
    // ==================================================

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

    // ==================================================
    // !STATUS
    // ==================================================

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
        `🎙️ **Gemini TTS Status**\n\n` +
        `Status: ${status}\n` +
        `Queue: **${state.queue.length}**\n` +
        `🎤 Voice listener: **ON**\n` +
        `🧠 AI: **Gemini**`
      );
    }

    // ==================================================
    // !SAY
    // ==================================================

    if (content.startsWith("!say ")) {
      const text =
        content
          .slice(5)
          .trim();

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

// ==================================================
// LOGIN
// ==================================================

client.login(
  process.env.DISCORD_TOKEN
);