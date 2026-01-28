require("dotenv").config();
const { REST, Routes, SlashCommandBuilder, ChannelType } = require("discord.js");

const token = process.env.DISCORD_TOKEN;
const clientId = process.env.DISCORD_CLIENT_ID;
const guildId = process.env.GUILD_ID;

if (!token || !clientId) {
  console.error("Missing DISCORD_TOKEN or CLIENT_ID in .env");
  process.exit(1);
}

const dumpids = new SlashCommandBuilder()
    .setName("dumpids")
    .setDescription("Dump all guild member user IDs to files on disk (owner-only).")
    .addBooleanOption((o) =>
      o
        .setName("include_bots")
        .setDescription("Include bot accounts (default: false)")
        .setRequired(false)
    );

const syncCategoryCmd = new SlashCommandBuilder()
  .setName("sync-category-perms")
  .setDescription("Sync all child channels under a category to match the category permission overwrites")
  .addChannelOption((opt) =>
    opt
      .setName("category")
      .setDescription("Category to sync from")
      .addChannelTypes(ChannelType.GuildCategory)
      .setRequired(true)
  )
  .addStringOption((opt) =>
    opt
      .setName("mode")
      .setDescription("How to apply overwrites")
      .addChoices(
        { name: "replace (exact match)", value: "replace" },
        { name: "merge (update/add only)", value: "merge" }
      )
      .setRequired(false)
  )
  .addBooleanOption((opt) =>
    opt
      .setName("dry_run")
      .setDescription("If true, shows what would change without applying")
      .setRequired(false)
  );

const syncChannelCmd = new SlashCommandBuilder()
  .setName("sync-channel-perms")
  .setDescription("Sync ONE channel to match its parent category permission overwrites")
  .addChannelOption((opt) =>
    opt
      .setName("channel")
      .setDescription("Channel to sync (defaults to current channel)")
      .setRequired(false)
  )
  .addStringOption((opt) =>
    opt
      .setName("mode")
      .setDescription("How to apply overwrites")
      .addChoices(
        { name: "replace (exact match)", value: "replace" },
        { name: "merge (update/add only)", value: "merge" }
      )
      .setRequired(false)
  )
  .addBooleanOption((opt) =>
    opt
      .setName("dry_run")
      .setDescription("If true, shows what would change without applying")
      .setRequired(false)
  );

const commands = [syncCategoryCmd.toJSON(), syncChannelCmd.toJSON(), dumpids.toJSON()];
const rest = new REST({ version: "10" }).setToken(token);

(async () => {
  try {
    if (guildId) {
      console.log("Deploying guild commands...");
      await rest.put(Routes.applicationGuildCommands(clientId, guildId), { body: commands });
      console.log("Guild commands deployed.");
    } else {
      console.log("Deploying global commands...");
      await rest.put(Routes.applicationCommands(clientId), { body: commands });
      console.log("Global commands deployed. (Can take up to ~1 hour to appear everywhere.)");
    }
  } catch (err) {
    console.error(err);
    process.exit(1);
  }
})();
