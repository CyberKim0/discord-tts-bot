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
  StreamType,
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

client.once("clientReady", () => {
  console.log(`✅ Logged in as ${client.user.tag}`);
});

client.on("messageCreate", async (message) => {
  if (message.author.bot) return;

  if (!message.content.startsWith("!say ")) return;

  const text = message.content.slice(5).trim();

  if (!text) {
    return message.reply("❌ Type something after `!say`.");
  }

  if (text.length > 500) {
    return message.reply("❌ Keep the message under 500 characters.");
  }

  const voiceChannel = message.member?.voice?.channel;

  if (!voiceChannel) {
    return message.reply("❌ Join a voice channel first.");
  }

  const filePath = path.join(
    __dirname,
    `tts-${Date.now()}.mp3`
  );

  try {
    await message.reply("🔊 Speaking...");

    const tts = new gTTS(text, "en");

    tts.save(filePath, (error) => {
      if (error) {
        console.error(error);
        return message.channel.send("❌ TTS generation failed.");
      }

      try {
        const connection = joinVoiceChannel({
          channelId: voiceChannel.id,
          guildId: voiceChannel.guild.id,
          adapterCreator: voiceChannel.guild.voiceAdapterCreator,
          selfDeaf: false,
        });

        const player = createAudioPlayer({
          behaviors: {
            noSubscriber: NoSubscriberBehavior.Play,
          },
        });

        const resource = createAudioResource(filePath, {
          inputType: StreamType.Arbitrary,
        });

        connection.subscribe(player);
        player.play(resource);

        console.log(`🔊 Speaking: ${text}`);

        player.on(AudioPlayerStatus.Idle, () => {
          if (fs.existsSync(filePath)) {
            fs.unlinkSync(filePath);
          }

          connection.destroy();
        });

        player.on("error", (error) => {
          console.error("Audio error:", error);

          if (fs.existsSync(filePath)) {
            fs.unlinkSync(filePath);
          }

          connection.destroy();
        });

      } catch (error) {
        console.error(error);

        if (fs.existsSync(filePath)) {
          fs.unlinkSync(filePath);
        }

        message.channel.send("❌ Couldn't play the audio.");
      }
    });

  } catch (error) {
    console.error(error);
    message.channel.send("❌ Something went wrong.");
  }
});

client.login(process.env.DISCORD_TOKEN);