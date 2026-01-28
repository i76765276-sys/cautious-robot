require("dotenv").config();
const {
  Client,
  GatewayIntentBits,
  ChannelType,
  PermissionFlagsBits,
  Events
} = require("discord.js");
const { insertInto } = require("../database");

const {randomUUID} = require('crypto')

const token = process.env.DISCORD_TOKEN;
if (!token) {
  console.error("Missing DISCORD_TOKEN in .env");
  process.exit(1);
}

const client = new Client({
  intents: [GatewayIntentBits.Guilds]
});

function normalizeOverwrites(overwritesManagerOrCollection) {
  // Returns a stable array of {id, type, allow, deny} where allow/deny are bigint.
  const arr = [];
  const cache = overwritesManagerOrCollection?.cache ?? overwritesManagerOrCollection;
  if (!cache) return arr;

  for (const ow of cache.values()) {
    const allow =
      typeof ow.allow?.bitfield === "bigint"
        ? ow.allow.bitfield
        : BigInt(ow.allow?.bitfield ?? ow.allow ?? 0);
    const deny =
      typeof ow.deny?.bitfield === "bigint"
        ? ow.deny.bitfield
        : BigInt(ow.deny?.bitfield ?? ow.deny ?? 0);

    arr.push({ id: ow.id, type: ow.type, allow, deny });
  }

  arr.sort((a, b) => {
    if (a.id === b.id) return String(a.type).localeCompare(String(b.type));
    return a.id.localeCompare(b.id);
  });

  return arr;
}

function overwritesEqual(aList, bList) {
  if (aList.length !== bList.length) return false;
  for (let i = 0; i < aList.length; i++) {
    const a = aList[i];
    const b = bList[i];
    if (a.id !== b.id) return false;
    if (a.type !== b.type) return false;
    if (a.allow !== b.allow) return false;
    if (a.deny !== b.deny) return false;
  }
  return true;
}

function mergeOverwrites(channelList, categoryList) {
  // For every overwrite in categoryList: add it if missing, or replace allow/deny if present.
  // Keep extra channel overwrites that aren't on the category.
  const map = new Map();
  for (const ow of channelList) map.set(`${ow.type}:${ow.id}`, { ...ow });
  for (const ow of categoryList) map.set(`${ow.type}:${ow.id}`, { ...ow });

  const merged = [...map.values()];
  merged.sort((a, b) => {
    if (a.id === b.id) return String(a.type).localeCompare(String(b.type));
    return a.id.localeCompare(b.id);
  });
  return merged;
}

function isEditableGuildChannel(ch) {
  if (!ch) return false;
  if (!("permissionOverwrites" in ch)) return false;

  // Exclude threads (they inherit, and editing overwrites is not the same)
  if (
    ch.type === ChannelType.PublicThread ||
    ch.type === ChannelType.PrivateThread ||
    ch.type === ChannelType.AnnouncementThread
  ) {
    return false;
  }

  // Categories are editable, but we are syncing children, not the category itself
  if (ch.type === ChannelType.GuildCategory) return true;

  // Text/Voice/Forum/Stage/Announcement are all fine
  return true;
}

function channelLabel(ch) {
  try {
    return `#${ch.name} (${ch.id})`;
  } catch {
    return `(unknown channel)`;
  }
}

async function applyOverwritesToChannel({ channel, desired, dryRun }) {
  const current = normalizeOverwrites(channel.permissionOverwrites);

  if (overwritesEqual(current, desired)) {
    return { changed: false, reason: "already_matches" };
  }

  if (dryRun) {
    return { changed: true, reason: "would_change" };
  }

  // discord.js accepts bigint allow/deny
  await channel.permissionOverwrites.set(
    desired.map((ow) => ({
      id: ow.id,
      type: ow.type,
      allow: ow.allow,
      deny: ow.deny
    }))
  );

  return { changed: true, reason: "updated" };
}

function getCategoryChildren(guild, categoryId) {
  return guild.channels.cache
    .filter((ch) => ch.parentId === categoryId)
    .sort((a, b) => (a.rawPosition ?? 0) - (b.rawPosition ?? 0));
}

function hasPerms(member, perms) {
  try {
    return member.permissions.has(perms);
  } catch {
    return false;
  }
}

async function syncCategory({ interaction, category, mode, dryRun }) {
  const guild = interaction.guild;
  if (!guild) throw new Error("This command can only be used in a server.");

  const categoryOverwrites = normalizeOverwrites(category.permissionOverwrites);

  const children = getCategoryChildren(guild, category.id);
  const results = {
    total: children.size ?? children.length ?? 0,
    updated: 0,
    unchanged: 0,
    failed: 0,
    skipped: 0
  };

  const failures = [];

  // Small delay between edits to reduce rate-limit pressure
  const DELAY_MS = 250;

  for (const ch of children.values ? children.values() : children) {
    if (!isEditableGuildChannel(ch) || ch.type === ChannelType.GuildCategory) {
      results.skipped++;
      continue;
    }

    try {
      const current = normalizeOverwrites(ch.permissionOverwrites);
      const desired =
        mode === "merge" ? mergeOverwrites(current, categoryOverwrites) : categoryOverwrites;

      const r = await applyOverwritesToChannel({ channel: ch, desired, dryRun });
      if (!r.changed) results.unchanged++;
      else results.updated++;

      await new Promise((r2) => setTimeout(r2, DELAY_MS));
    } catch (err) {
      results.failed++;
      failures.push(`${channelLabel(ch)}: ${err?.message || String(err)}`);
    }
  }

  return { results, failures };
}

async function syncSingleChannel({ interaction, channel, mode, dryRun }) {
  const guild = interaction.guild;
  if (!guild) throw new Error("This command can only be used in a server.");
  if (!channel) throw new Error("Channel not found.");
  if (!isEditableGuildChannel(channel)) throw new Error("That channel type cannot be synced.");
  if (!channel.parentId) throw new Error("That channel is not inside a category.");

  const category = guild.channels.cache.get(channel.parentId);
  if (!category || category.type !== ChannelType.GuildCategory) {
    throw new Error("Parent category not found.");
  }

  const categoryOverwrites = normalizeOverwrites(category.permissionOverwrites);
  const current = normalizeOverwrites(channel.permissionOverwrites);
  const desired = mode === "merge" ? mergeOverwrites(current, categoryOverwrites) : categoryOverwrites;

  const r = await applyOverwritesToChannel({ channel, desired, dryRun });
  return { changed: r.changed, category, channel };
}



function isoStamp() {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

function toCsv(rows) {
  const escape = (s) => {
    const v = String(s ?? "");
    if (v.includes('"') || v.includes(",") || v.includes("\n") || v.includes("\r")) {
      return `"${v.replace(/"/g, '""')}"`;
    }
    return v;
  };

  const headers = ["id", "username", "globalName", "isBot"];
  const lines = [headers.join(",")];

  for (const r of rows) {
    lines.push([r.id, r.username, r.globalName, r.isBot].map(escape).join(","));
  }
  return lines.join("\n") + "\n";
}

async function dumpGuildMemberIds({ includeBots }) {
  const guild = await client.guilds.fetch(GUILD_ID);

  // This requires "Server Members Intent" enabled in the Developer Portal for your bot.
  await guild.members.fetch();

  const members = guild.members.cache;

  const ids = [];
  const rows = [];

  for (const [, member] of members) {
    const u = member.user;
    if (!includeBots && u.bot) continue;

    ids.push(u.id);
    rows.push({
      id: u.id,
      username: u.username || "",
      globalName: u.globalName || "",
      isBot: !!u.bot
    });
  }

  ids.sort();

  const stamp = isoStamp();
  const baseName = `guild-${guild.id}-${stamp}${includeBots ? "-with-bots" : ""}`;

  const idsTxtPath = path.join(OUT_DIR, `${baseName}-ids.txt`);
  const jsonPath = path.join(OUT_DIR, `${baseName}-members.json`);
  const csvPath = path.join(OUT_DIR, `${baseName}-members.csv`);

  await ensureDir(OUT_DIR);

  await fsp.writeFile(idsTxtPath, ids.join("\n") + "\n", "utf8");
  await fsp.writeFile(
    jsonPath,
    JSON.stringify(
      {
        guildId: guild.id,
        dumpedAt: new Date().toISOString(),
        includeBots,
        count: rows.length,
        members: rows
      },
      null,
      2
    ),
    "utf8"
  );
  await fsp.writeFile(csvPath, toCsv(rows), "utf8");

  return { guild, idsTxtPath, jsonPath, csvPath, count: rows.length };
}

async function registerCommands() {
  const cmd = new SlashCommandBuilder()
    .setName("dumpids")
    .setDescription("Dump all guild member user IDs to files on disk (owner-only).")
    .addBooleanOption((o) =>
      o
        .setName("include_bots")
        .setDescription("Include bot accounts (default: false)")
        .setRequired(false)
    )
    .toJSON();

  const rest = new REST({ version: "10" }).setToken(BOT_TOKEN);
  const appId = client.user.id;

  await rest.put(Routes.applicationGuildCommands(appId, GUILD_ID), { body: [cmd] });
  console.log(`[cmd] Registered /dumpids in guild ${GUILD_ID}`);
}
client.once(Events.ClientReady, () => {
  console.log(`Logged in as ${client.user.tag}`);
});

client.on("interactionCreate", async (interaction) => {
  if (!interaction.isChatInputCommand()) return;

  try {
    // Permission checks: user + bot need Manage Channels
    const member = interaction.member;
    const me = interaction.guild?.members?.me;

    const userOk = hasPerms(member, PermissionFlagsBits.ManageChannels) || hasPerms(member, PermissionFlagsBits.Administrator);
    if (!userOk) {
      await interaction.reply({
        ephemeral: true,
        content: "You need **Manage Channels** (or **Administrator**) to run this."
      });
      return;
    }

    const botOk = hasPerms(me, PermissionFlagsBits.ManageChannels) || hasPerms(me, PermissionFlagsBits.Administrator);
    if (!botOk) {
      await interaction.reply({
        ephemeral: true,
        content: "I need **Manage Channels** (or **Administrator**) permission to edit overwrites."
      });
      return;
    }

    if (interaction.commandName === "sync-category-perms") {
      const category = interaction.options.getChannel("category", true);
      const mode = interaction.options.getString("mode") || "replace";
      const dryRun = interaction.options.getBoolean("dry_run") || false;

      if (category.type !== ChannelType.GuildCategory) {
        await interaction.reply({ ephemeral: true, content: "That isn't a category." });
        return;
      }

      await interaction.deferReply({ ephemeral: true });

      const { results, failures } = await syncCategory({ interaction, category, mode, dryRun });

      let msg =
        `Category: **${category.name}**\n` +
        `Mode: **${mode}**\n` +
        `Dry run: **${dryRun ? "yes" : "no"}**\n\n` +
        `Total channels: **${results.total}**\n` +
        `Updated: **${results.updated}**\n` +
        `Unchanged: **${results.unchanged}**\n` +
        `Skipped: **${results.skipped}**\n` +
        `Failed: **${results.failed}**`;

      if (failures.length) {
        // Keep within Discord message limits
        const maxLines = 15;
        const shown = failures.slice(0, maxLines);
        msg += `\n\nFailures (showing ${shown.length}${failures.length > shown.length ? ` of ${failures.length}` : ""}):\n- ` + shown.join("\n- ");
      }

      await interaction.editReply({ content: msg });
      return;
    }

    if (interaction.commandName === "sync-channel-perms") {
      const channel = interaction.options.getChannel("channel") || interaction.channel;
      const mode = interaction.options.getString("mode") || "replace";
      const dryRun = interaction.options.getBoolean("dry_run") || false;

      await interaction.deferReply({ ephemeral: true });

      const r = await syncSingleChannel({ interaction, channel, mode, dryRun });
      await interaction.editReply({
        content:
          `Channel: **${channel.name}**\n` +
          `Category: **${r.category.name}**\n` +
          `Mode: **${mode}**\n` +
          `Dry run: **${dryRun ? "yes" : "no"}**\n\n` +
          (r.changed ? "Result: **changed**" : "Result: **already matched**")
      });
      return;
    }

    if(interaction.commandName === "dumpids"){
       const includeBots = interaction.options.getBoolean("include_bots") || false;

  await interaction.reply({
    content: `⏳ Dumping member IDs... (include_bots=${includeBots ? "true" : "false"})`,
    ephemeral: true
  });

    const result = await dumpGuildMemberIds({ includeBots });
    const idsStat = await fsp.stat(result.idsTxtPath);

    // Try attaching IDs file if it's small enough (typical limit is 8MB; keep margin).
    const canAttach = idsStat.size <= 7.5 * 1024 * 1024;

    const lines = [
      `✅ Done.`,
      `Guild: ${result.guild.name} (${result.guild.id})`,
      `Members exported: ${result.count}`,
      `Saved files:`,
      `- ${result.idsTxtPath}`,
      `- ${result.csvPath}`,
      `- ${result.jsonPath}`,
      canAttach ? `Attached: ids.txt` : `IDs file too large to attach (saved to disk).`
    ];

      if (canAttach) {
      const attachment = new AttachmentBuilder(result.idsTxtPath, {
        name: path.basename(result.idsTxtPath)
      });

      await interaction.editReply({
        content: lines.join("\n"),
        files: [attachment]
      });
    } else {
      await interaction.editReply({ content: lines.join("\n") });
    }

  }
  } catch (err) {
    const msg = err?.message || String(err);
    if (interaction.deferred || interaction.replied) {
      await interaction.editReply({ content: `Error: ${msg}` }).catch(() => {});
    } else {
      await interaction.reply({ ephemeral: true, content: `Error: ${msg}` }).catch(() => {});
    }
  }
    });

client.login(token);
