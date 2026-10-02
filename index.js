require("dotenv").config();

const {
  Client,
  GatewayIntentBits,
  Partials,
  EmbedBuilder,
} = require("discord.js");

const TOKEN = process.env.DISCORD_TOKEN;
const REPORT_CHANNEL_ID = process.env.REPORT_CHANNEL_ID;
const STORE_ID = process.env.STORE_ID || "61";
const TIMEZONE = process.env.TIMEZONE || "Europe/Zagreb";

if (!TOKEN) {
  console.error("Nedostaje DISCORD_TOKEN u .env");
  process.exit(1);
}

if (!REPORT_CHANNEL_ID) {
  console.error("Nedostaje REPORT_CHANNEL_ID u .env");
  process.exit(1);
}

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
  partials: [Partials.Channel],
});

function normalizeName(name) {
  return String(name || "")
    .replace(/\s+/g, " ")
    .trim();
}

function addCount(map, item, amount) {
  item = normalizeName(item);
  amount = Number(amount);
  if (!item || !Number.isFinite(amount)) return;
  map.set(item, (map.get(item) || 0) + amount);
}

function parseDateDMY(value, endOfDay = false) {
  const match = String(value || "").trim().match(
    /^(\\d{1,2})[.\\/-](\\d{1,2})[.\\/-](\\d{4})$/
  );

  if (!match) return null;

  const day = Number(match[1]);
  const month = Number(match[2]);
  const year = Number(match[3]);

  if (
    !Number.isInteger(day) ||
    !Number.isInteger(month) ||
    !Number.isInteger(year) ||
    month < 1 || month > 12 || day < 1 || day > 31
  ) {
    return null;
  }

  // Interpret the date as local Zagreb time, then convert to an absolute Date.
  const isoTime = endOfDay ? "23:59:59.999" : "00:00:00.000";
  const iso = `${year.toString().padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}T${isoTime}+02:00`;
  const date = new Date(iso);

  if (Number.isNaN(date.getTime())) return null;
  return date;
}

function formatDate(date) {
  return new Intl.DateTimeFormat("hr-HR", {
    timeZone: TIMEZONE,
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

function mapToSortedArray(map) {
  return [...map.entries()].sort((a, b) =>
    a[0].localeCompare(b[0], "hr", { sensitivity: "base" })
  );
}

function parseEventFromMessage(message) {
  // Bot messages from the shop are expected to contain one of these embed titles.
  const embeds = message.embeds || [];
  if (!embeds.length) return null;

  for (const embed of embeds) {
    const title = normalizeName(embed.title);
    const description = normalizeName(embed.description);
    const text = `${title} ${description}`;

    let type = null;
    if (/^Purchase Made$/i.test(title) || /Purchase Made/i.test(text)) {
      type = "sold";
    } else if (/^New Item Listed$/i.test(title) || /New Item Listed/i.test(text)) {
      type = "listed";
    } else if (/^Item Removed$/i.test(title) || /Item Removed/i.test(text)) {
      type = "removed";
    }

    if (!type) continue;

    // Examples supported:
    // "Franklin Smith (...) bought Kaubojska Kobasica x3 for $13.50 from store ID 61."
    // "Lucija Crow (...) listed Sok Od Jabuke x1 for $9.00 in store ID 61."
    // "Lucija Crow (...) removed Kaubojska Corba x5 from store ID 61."
    const combined = `${description} ${embed.fields?.map(f => `${f.name} ${f.value}`).join(" ") || ""}`
      .replace(/\s+/g, " ")
      .trim();

    const storeMatch = combined.match(/store ID\\s*([A-Za-z0-9_-]+)/i);
    if (storeMatch && String(storeMatch[1]) !== String(STORE_ID)) {
      return null;
    }

    let match = null;
    if (type === "sold") {
      match = combined.match(/\\bbought\\s+(.+?)\\s+x(\\d+)\\s+for\\s+\\$([\\d.,]+)/i);
    } else if (type === "listed") {
      match = combined.match(/\\blisted\\s+(.+?)\\s+x(\\d+)\\s+for\\s+\\$([\\d.,]+)/i);
    } else if (type === "removed") {
      match = combined.match(/\\bremoved\\s+(.+?)\\s+x(\\d+)\\s+from\\s+store/i);
    }

    if (!match) return null;

    return {
      type,
      item: normalizeName(match[1]),
      quantity: Number(match[2]),
      price: type === "removed" ? null : Number(String(match[3]).replace(",", ".")),
      createdAt: message.createdAt,
      messageId: message.id,
    };
  }

  return null;
}

async function fetchMessagesInRange(channel, from, to) {
  const events = [];
  let before;

  while (true) {
    const options = { limit: 100 };
    if (before) options.before = before;

    const batch = await channel.messages.fetch(options);
    if (!batch.size) break;

    let reachedOlderThanRange = false;

    for (const message of batch.values()) {
      if (message.createdAt < from) {
        reachedOlderThanRange = true;
        continue;
      }

      if (message.createdAt <= to) {
        const event = parseEventFromMessage(message);
        if (event) events.push(event);
      }
    }

    const oldest = batch.last();
    if (!oldest) break;

    before = oldest.id;

    if (reachedOlderThanRange || oldest.createdAt < from) {
      break;
    }
  }

  return events;
}

function section(title, map) {
  const entries = mapToSortedArray(map);
  if (!entries.length) return `**${title}:**\\nNema zapisa.`;

  const lines = entries.map(([item, qty]) => `• **${item}** — x${qty}`);
  return `**${title}:**\\n${lines.join("\\n")}`;
}

function buildReport(events, from, to) {
  const sold = new Map();
  const listed = new Map();
  const removed = new Map();

  for (const event of events) {
    if (event.type === "sold") addCount(sold, event.item, event.quantity);
    if (event.type === "listed") addCount(listed, event.item, event.quantity);
    if (event.type === "removed") addCount(removed, event.item, event.quantity);
  }

  const report = [
    `📊 **SABERI — Store ID ${STORE_ID}**`,
    `🗓️ **Period:** ${formatDate(from)} → ${formatDate(to)}`,
    "",
    section("🛒 PRODANO", sold),
    "",
    section("📦 NAPRAVLJENO / STAVLJENO NA TEZGU", listed),
    "",
    section("🗑️ SKINUTO S TEZGE", removed),
    "",
    `Ukupno zapisa: **${events.length}**`,
  ].join("\\n");

  return report;
}

function parseCommandArgs(content) {
  // Supports:
  // !saberi 01.10.2026 10.10.2026
  // !saberi 01.10.2026 do 10.10.2026
  const args = content.trim().split(/\\s+/).slice(1);
  const dates = args.filter(x => /^\\d{1,2}[.\\/-]\\d{1,2}[.\\/-]\\d{4}$/.test(x));

  if (dates.length < 2) return null;

  const from = parseDateDMY(dates[0], false);
  const to = parseDateDMY(dates[1], true);

  if (!from || !to || from > to) return null;
  return { from, to };
}

client.once("ready", () => {
  console.log(`Bot je online kao ${client.user.tag}`);
});

client.on("messageCreate", async (message) => {
  try {
    if (message.author.bot && message.author.id === client.user.id) return;
    if (!message.content?.toLowerCase().startsWith("!saberi")) return;

    const parsed = parseCommandArgs(message.content);

    if (!parsed) {
      await message.reply(
        "❌ Format: `!saberi DD.MM.GGGG DD.MM.GGGG`\\n" +
        "Primjer: `!saberi 01.10.2026 10.10.2026`"
      );
      return;
    }

    const channel = await client.channels.fetch(REPORT_CHANNEL_ID);

    if (!channel || !channel.isTextBased() || !channel.messages) {
      await message.reply("❌ REPORT_CHANNEL_ID nije valjan tekstualni kanal.");
      return;
    }

    await message.reply("⏳ Računam podatke iz zadanog perioda...");

    const events = await fetchMessagesInRange(channel, parsed.from, parsed.to);
    const report = buildReport(events, parsed.from, parsed.to);

    // Discord message limit je 2000 znakova.
    if (report.length <= 2000) {
      await message.reply(report);
      return;
    }

    const chunks = [];
    let current = "";

    for (const line of report.split("\\n")) {
      if ((current + line + "\\n").length > 1900) {
        chunks.push(current);
        current = "";
      }
      current += line + "\\n";
    }
    if (current) chunks.push(current);

    for (const chunk of chunks) {
      await message.channel.send(chunk.trim());
    }
  } catch (error) {
    console.error(error);
    await message.reply("❌ Dogodila se greška. Provjeri konzolu bota.");
  }
});

client.login(TOKEN);
