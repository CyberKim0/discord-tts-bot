const { REST, Routes, SlashCommandBuilder } = require("discord.js");

const commands = [
  new SlashCommandBuilder()
    .setName("join")
    .setDescription("Join your current voice channel"),

  new SlashCommandBuilder()
    .setName("leave")
    .setDescription("Leave the voice channel"),

  new SlashCommandBuilder()
    .setName("stop")
    .setDescription("Stop speaking and clear the queue"),

  new SlashCommandBuilder()
    .setName("say")
    .setDescription("Make the bot speak in your voice channel")
    .addStringOption(option =>
      option
        .setName("message")
        .setDescription("What should the bot say?")
        .setRequired(true)
    ),
].map(command => command.toJSON());

const rest = new REST({ version: "10" }).setToken(
  process.env.DISCORD_TOKEN
);

(async () => {
  try {
    console.log("🔄 Registering slash commands...");

    await rest.put(
      Routes.applicationCommands(process.env.CLIENT_ID),
      { body: commands }
    );

    console.log("✅ Slash commands registered!");
  } catch (error) {
    console.error("❌ Failed to register commands:", error);
  }
})();