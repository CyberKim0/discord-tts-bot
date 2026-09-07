const {
  REST,
  Routes,
  SlashCommandBuilder,
} = require("discord.js");

const commands = [
  new SlashCommandBuilder()
    .setName("say")
    .setDescription("Make the bot speak in your voice channel")
    .addStringOption(option =>
      option
        .setName("text")
        .setDescription("What should the bot say?")
        .setRequired(true)
        .setMaxLength(500)
    ),

  new SlashCommandBuilder()
    .setName("join")
    .setDescription("Make the bot join your voice channel"),

  new SlashCommandBuilder()
    .setName("leave")
    .setDescription("Make the bot leave the voice channel"),

  new SlashCommandBuilder()
    .setName("stop")
    .setDescription("Stop speaking and clear the queue"),
].map(command => command.toJSON());

const rest = new REST({ version: "10" }).setToken(
  process.env.DISCORD_TOKEN
);

(async () => {
  try {
    console.log("🔄 Registering slash commands...");

    await rest.put(
      Routes.applicationGuildCommands(
  process.env.CLIENT_ID,
  process.env.GUILD_ID
)
      { body: commands }
    );

    console.log("✅ Slash commands registered!");
  } catch (error) {
    console.error(error);
  }
})();