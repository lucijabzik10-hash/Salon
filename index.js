require("dotenv").config();

const {
  Client,
  GatewayIntentBits,
  Partials,
} = require("discord.js");

// ==========================================
// POSTAVKE
// ==========================================

const TOKEN = process.env.DISCORD_TOKEN;
const REPORT_CHANNEL_ID = process.env.REPORT_CHANNEL_ID;
const STORE_ID = process.env.STORE_ID || "61";
const TIMEZONE = process.env.TIMEZONE || "Europe/Zagreb";

if (!TOKEN) {
  console.error("❌ Nedostaje DISCORD_TOKEN u environment variables.");
  process.exit(1);
}

if (!REPORT_CHANNEL_ID) {
  console.error("❌ Nedostaje REPORT_CHANNEL_ID u environment variables.");
  process.exit(1);
}

// ==========================================
// DISCORD CLIENT
// ==========================================

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
  partials: [Partials.Channel],
});

// ==========================================
// POMOĆNE FUNKCIJE
// ==========================================

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

// ==========================================
// DATUM
// ==========================================

function parseDateDMY(value, endOfDay = false) {
  const match = String(value || "")
    .trim()
    .match(/^(\d{1,2})[.\/-](\d{1,2})[.\/-](\d{4})$/);

  if (!match) return null;

  const day = Number(match[1]);
  const month = Number(match[2]);
  const year = Number(match[3]);

  // Provjera postoji li stvarno taj datum
  const testDate = new Date(year, month - 1, day);

  if (
    testDate.getFullYear() !== year ||
    testDate.getMonth() !== month - 1 ||
    testDate.getDate() !== day
  ) {
    return null;
  }

  if (endOfDay) {
    return new Date(
      year,
      month - 1,
      day,
      23,
      59,
      59,
      999
    );
  }

  return new Date(
    year,
    month - 1,
    day,
    0,
    0,
    0,
    0
  );
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

// ==========================================
// SORTIRANJE
// ==========================================

function mapToSortedArray(map) {
  return [...map.entries()].sort((a, b) =>
    a[0].localeCompare(
      b[0],
      "hr",
      { sensitivity: "base" }
    )
  );
}

// ==========================================
// ČITANJE SHOP PORUKA
// ==========================================

function parseEventFromMessage(message) {
  const embeds = message.embeds || [];

  if (!embeds.length) return null;

  for (const embed of embeds) {
    const title = normalizeName(embed.title);
    const description = normalizeName(embed.description);

    const fieldsText =
      embed.fields
        ?.map((field) => `${field.name} ${field.value}`)
        .join(" ") || "";

    const text = `${title} ${description} ${fieldsText}`
      .replace(/\s+/g, " ")
      .trim();

    let type = null;

    // PRODANO
    if (
      /^Purchase Made$/i.test(title) ||
      /Purchase Made/i.test(text)
    ) {
      type = "sold";
    }

    // STAVLJENO NA TEZGU
    else if (
      /^New Item Listed$/i.test(title) ||
      /New Item Listed/i.test(text)
    ) {
      type = "listed";
    }

    // SKINUTO S TEZGE
    else if (
      /^Item Removed$/i.test(title) ||
      /Item Removed/i.test(text)
    ) {
      type = "removed";
    }

    if (!type) continue;

    // ======================================
    // PROVJERA STORE ID
    // ======================================

    const storeMatch = text.match(
      /store ID\s*[:#-]?\s*([A-Za-z0-9_-]+)/i
    );

    if (
      storeMatch &&
      String(storeMatch[1]) !== String(STORE_ID)
    ) {
      continue;
    }

    let match = null;

    // ======================================
    // PURCHASE MADE
    // ======================================

    if (type === "sold") {
      match = text.match(
        /\bbought\s+(.+?)\s+x(\d+)\s+for\s+\$([\d.,]+)/i
      );
    }

    // ======================================
    // NEW ITEM LISTED
    // ======================================

    else if (type === "listed") {
      match = text.match(
        /\blisted\s+(.+?)\s+x(\d+)\s+for\s+\$([\d.,]+)/i
      );
    }

    // ======================================
    // ITEM REMOVED
    // ======================================

    else if (type === "removed") {
      match = text.match(
        /\bremoved\s+(.+?)\s+x(\d+)\s+from\s+store/i
      );
    }

    if (!match) continue;

    return {
      type: type,
      item: normalizeName(match[1]),
      quantity: Number(match[2]),

      price:
        type === "removed"
          ? null
          : Number(
              String(match[3]).replace(",", ".")
            ),

      createdAt: message.createdAt,
      messageId: message.id,
    };
  }

  return null;
}

// ==========================================
// DOHVATI SVE PORUKE IZ PERIODA
// ==========================================

async function fetchMessagesInRange(channel, from, to) {
  const events = [];

  let before = undefined;

  while (true) {
    const options = {
      limit: 100,
    };

    if (before) {
      options.before = before;
    }

    const batch = await channel.messages.fetch(options);

    if (!batch.size) {
      break;
    }

    let reachedOlderThanRange = false;

    for (const message of batch.values()) {

      // Poruka je starija od početnog datuma
      if (message.createdAt < from) {
        reachedOlderThanRange = true;
        continue;
      }

      // Poruka je unutar zadanog perioda
      if (
        message.createdAt >= from &&
        message.createdAt <= to
      ) {
        const event = parseEventFromMessage(message);

        if (event) {
          events.push(event);
        }
      }
    }

    const oldest = batch.last();

    if (!oldest) {
      break;
    }

    before = oldest.id;

    if (
      reachedOlderThanRange ||
      oldest.createdAt < from
    ) {
      break;
    }
  }

  return events;
}

// ==========================================
// SEKCIJE IZVJEŠTAJA
// ==========================================

function section(title, map) {
  const entries = mapToSortedArray(map);

  if (!entries.length) {
    return `**${title}:**\nNema zapisa.`;
  }

  const lines = entries.map(
    ([item, qty]) =>
      `• **${item}** — x${qty}`
  );

  return `**${title}:**\n${lines.join("\n")}`;
}

// ==========================================
// IZVJEŠTAJ
// ==========================================

function buildReport(events, from, to) {
  const sold = new Map();
  const listed = new Map();
  const removed = new Map();

  for (const event of events) {

    if (event.type === "sold") {
      addCount(
        sold,
        event.item,
        event.quantity
      );
    }

    if (event.type === "listed") {
      addCount(
        listed,
        event.item,
        event.quantity
      );
    }

    if (event.type === "removed") {
      addCount(
        removed,
        event.item,
        event.quantity
      );
    }
  }

  return [
    `📊 **SABERI — Store ID ${STORE_ID}**`,

    `🗓️ **Period:** ${formatDate(from)} → ${formatDate(to)}`,

    "",

    section(
      "🛒 PRODANO",
      sold
    ),

    "",

    section(
      "📦 NAPRAVLJENO / STAVLJENO NA TEZGU",
      listed
    ),

    "",

    section(
      "🗑️ SKINUTO S TEZGE",
      removed
    ),

    "",

    `📋 Ukupno pronađenih zapisa: **${events.length}**`,
  ].join("\n");
}

// ==========================================
// ČITANJE !SABERI KOMANDE
// ==========================================

function parseCommandArgs(content) {

  /*
    PODRŽANO:

    !saberi 01.10.2026 10.10.2026

    !saberi 01.10.2026 do 10.10.2026

    !saberi 01/10/2026 10/10/2026

    !saberi 01-10-2026 10-10-2026

    Može i isti dan:

    !saberi 02.10.2026 02.10.2026
  */

  const args = content
    .trim()
    .split(/\s+/)
    .slice(1);

  const dates = args.filter((x) =>
    /^\d{1,2}[.\/-]\d{1,2}[.\/-]\d{4}$/.test(x)
  );

  if (dates.length !== 2) {
    return null;
  }

  const from = parseDateDMY(
    dates[0],
    false
  );

  const to = parseDateDMY(
    dates[1],
    true
  );

  if (!from || !to) {
    return null;
  }

  if (from > to) {
    return null;
  }

  return {
    from,
    to,
  };
}

// ==========================================
// BOT ONLINE
// ==========================================

client.once("ready", () => {
  console.log(
    `✅ Bot je online kao ${client.user.tag}`
  );

  console.log(
    `🏪 Store ID: ${STORE_ID}`
  );

  console.log(
    `📊 Report channel: ${REPORT_CHANNEL_ID}`
  );
});

// ==========================================
// !SABERI
// ==========================================

client.on("messageCreate", async (message) => {
  try {

    // Ignoriraj vlastite poruke bota
    if (
      message.author.bot &&
      message.author.id === client.user.id
    ) {
      return;
    }

    if (
      !message.content
        ?.toLowerCase()
        .startsWith("!saberi")
    ) {
      return;
    }

    // ======================================
    // DATUMI
    // ======================================

    const parsed =
      parseCommandArgs(message.content);

    if (!parsed) {
      await message.reply(
        "❌ **Pogrešan format.**\n\n" +
        "Koristi:\n" +
        "`!saberi DD.MM.GGGG DD.MM.GGGG`\n\n" +
        "Primjer:\n" +
        "`!saberi 01.10.2026 10.10.2026`\n\n" +
        "Može i:\n" +
        "`!saberi 01.10.2026 do 10.10.2026`"
      );

      return;
    }

    // ======================================
    // REPORT CHANNEL
    // ======================================

    const channel =
      await client.channels.fetch(
        REPORT_CHANNEL_ID
      );

    if (
      !channel ||
      !channel.isTextBased() ||
      !channel.messages
    ) {
      await message.reply(
        "❌ REPORT_CHANNEL_ID nije valjan tekstualni kanal."
      );

      return;
    }

    // ======================================
    // POČETAK RAČUNANJA
    // ======================================

    const loadingMessage =
      await message.reply(
        `⏳ Računam podatke za period:\n` +
        `**${formatDate(parsed.from)} → ${formatDate(parsed.to)}**`
      );

    // ======================================
    // DOHVATI PORUKE
    // ======================================

    const events =
      await fetchMessagesInRange(
        channel,
        parsed.from,
        parsed.to
      );

    // ======================================
    // NAPRAVI IZVJEŠTAJ
    // ======================================

    const report =
      buildReport(
        events,
        parsed.from,
        parsed.to
      );

    // Makni loading poruku
    try {
      await loadingMessage.delete();
    } catch (_) {}

    // ======================================
    // AKO JE ISPOD 2000 ZNAKOVA
    // ======================================

    if (report.length <= 2000) {
      await message.reply(report);
      return;
    }

    // ======================================
    // AKO JE IZVJEŠTAJ PREVELIK
    // PODIJELI GA U VIŠE PORUKA
    // ======================================

    const chunks = [];

    let current = "";

    for (const line of report.split("\n")) {

      if (
        (current + line + "\n").length >
        1900
      ) {
        if (current.trim()) {
          chunks.push(current.trim());
        }

        current = "";
      }

      current += line + "\n";
    }

    if (current.trim()) {
      chunks.push(current.trim());
    }

    // ======================================
    // POŠALJI SVE DIJELOVE
    // ======================================

    for (const chunk of chunks) {
      await message.channel.send(chunk);
    }

  } catch (error) {

    console.error(
      "❌ Greška kod !saberi:",
      error
    );

    try {
      await message.reply(
        "❌ Dogodila se greška. Provjeri Railway log."
      );
    } catch (_) {}
  }
});

// ==========================================
// LOGIN
// ==========================================

client.login(TOKEN);
