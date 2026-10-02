require("dotenv").config();

const {
  Client,
  GatewayIntentBits,
  Partials,
} = require("discord.js");

// ======================================================
// POSTAVKE
// ======================================================

const TOKEN = process.env.DISCORD_TOKEN;
const REPORT_CHANNEL_ID = process.env.REPORT_CHANNEL_ID;
const STORE_ID = process.env.STORE_ID || "61";
const TIMEZONE = process.env.TIMEZONE || "Europe/Zagreb";

if (!TOKEN) {
  console.error("❌ Nedostaje DISCORD_TOKEN.");
  process.exit(1);
}

if (!REPORT_CHANNEL_ID) {
  console.error("❌ Nedostaje REPORT_CHANNEL_ID.");
  process.exit(1);
}

// ======================================================
// DISCORD CLIENT
// ======================================================

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
  partials: [Partials.Channel],
});

// ======================================================
// POMOĆNE FUNKCIJE
// ======================================================

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

function mapToSortedArray(map) {
  return [...map.entries()].sort((a, b) =>
    a[0].localeCompare(b[0], "hr", {
      sensitivity: "base",
    })
  );
}

// ======================================================
// TIMEZONE - EUROPE/ZAGREB
// ======================================================

function getTimeZoneOffset(date, timeZone) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);

  const values = {};

  for (const part of parts) {
    if (part.type !== "literal") {
      values[part.type] = part.value;
    }
  }

  const asUTC = Date.UTC(
    Number(values.year),
    Number(values.month) - 1,
    Number(values.day),
    Number(values.hour),
    Number(values.minute),
    Number(values.second)
  );

  return asUTC - date.getTime();
}

function zagrebDateToUTC(
  year,
  month,
  day,
  hour = 0,
  minute = 0,
  second = 0,
  millisecond = 0
) {
  const utc = new Date(
    Date.UTC(
      year,
      month - 1,
      day,
      hour,
      minute,
      second,
      millisecond
    )
  );

  let offset = getTimeZoneOffset(utc, TIMEZONE);

  let result = new Date(
    utc.getTime() - offset
  );

  const secondOffset = getTimeZoneOffset(
    result,
    TIMEZONE
  );

  if (secondOffset !== offset) {
    result = new Date(
      utc.getTime() - secondOffset
    );
  }

  return result;
}

// ======================================================
// DATUM DD.MM.GGGG
// ======================================================

function parseDateDMY(value, endOfDay = false) {
  const match = String(value || "")
    .trim()
    .match(
      /^(\d{1,2})[.\/-](\d{1,2})[.\/-](\d{4})$/
    );

  if (!match) return null;

  const day = Number(match[1]);
  const month = Number(match[2]);
  const year = Number(match[3]);

  // Provjeri postoji li stvarno taj datum
  const test = new Date(
    Date.UTC(year, month - 1, day)
  );

  if (
    test.getUTCFullYear() !== year ||
    test.getUTCMonth() !== month - 1 ||
    test.getUTCDate() !== day
  ) {
    return null;
  }

  // DO datum = do kraja dana
  if (endOfDay) {
    return zagrebDateToUTC(
      year,
      month,
      day,
      23,
      59,
      59,
      999
    );
  }

  // OD datum = od početka dana
  return zagrebDateToUTC(
    year,
    month,
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
    hourCycle: "h23",
  }).format(date);
}

// ======================================================
// ČITANJE SHOP EMBEDA
// ======================================================

function parseEventFromMessage(message) {
  const embeds = message.embeds || [];

  if (!embeds.length) return null;

  for (const embed of embeds) {
    const title = normalizeName(embed.title);

    const description = normalizeName(
      embed.description
    );

    const fieldsText =
      embed.fields
        ?.map(
          (field) =>
            `${field.name || ""} ${field.value || ""}`
        )
        .join(" ") || "";

    const text = normalizeName(
      `${description} ${fieldsText}`
    );

    const allText = normalizeName(
      `${title} ${description} ${fieldsText}`
    );

    let type = null;

    // ==================================================
    // PRODANO
    // ==================================================

    if (
      /^Purchase Made$/i.test(title) ||
      /Purchase Made/i.test(allText)
    ) {
      type = "sold";
    }

    // ==================================================
    // STAVLJENO NA TEZGU
    // ==================================================

    else if (
      /^New Item Listed$/i.test(title) ||
      /New Item Listed/i.test(allText)
    ) {
      type = "listed";
    }

    // ==================================================
    // SKINUTO S TEZGE
    // ==================================================

    else if (
      /^Item Removed$/i.test(title) ||
      /Item Removed/i.test(allText)
    ) {
      type = "removed";
    }

    if (!type) continue;

    // ==================================================
    // STORE ID
    // ==================================================

    const storeMatch = allText.match(
      /store\s*ID\s*[:#-]?\s*([A-Za-z0-9_-]+)/i
    );

    if (
      storeMatch &&
      String(storeMatch[1]) !== String(STORE_ID)
    ) {
      continue;
    }

    let match = null;

    // ==================================================
    // PRODANO
    // ==================================================

    if (type === "sold") {
      match = text.match(
        /\bbought\s+(.+?)\s+x(\d+)\s+for\s+\$[\d.,]+/i
      );

      if (!match) continue;

      return {
        type: "sold",
        item: normalizeName(match[1]),
        quantity: Number(match[2]),
        createdAt: message.createdAt,
        messageId: message.id,
      };
    }

    // ==================================================
    // STAVLJENO NA TEZGU
    // ==================================================

    if (type === "listed") {
      match = text.match(
        /\blisted\s+(.+?)\s+x(\d+)\s+for\s+\$[\d.,]+/i
      );

      // Rezervni format
      if (!match) {
        match = text.match(
          /\blisted\s+(.+?)\s+x(\d+)(?:\s+in|\s+to|\s+store|$)/i
        );
      }

      if (!match) continue;

      return {
        type: "listed",
        item: normalizeName(match[1]),
        quantity: Number(match[2]),
        createdAt: message.createdAt,
        messageId: message.id,
      };
    }

    // ==================================================
    // SKINUTO S TEZGE
    // ==================================================

    if (type === "removed") {
      match = text.match(
        /\bremoved\s+(.+?)\s+x(\d+)\s+from\s+(?:the\s+)?store/i
      );

      if (!match) continue;

      return {
        type: "removed",
        item: normalizeName(match[1]),
        quantity: Number(match[2]),
        createdAt: message.createdAt,
        messageId: message.id,
      };
    }
  }

  return null;
}

// ======================================================
// DOHVATI PORUKE IZ PERIODA
// ======================================================

async function fetchMessagesInRange(
  channel,
  from,
  to
) {
  const events = [];

  let before;

  while (true) {
    const options = {
      limit: 100,
    };

    if (before) {
      options.before = before;
    }

    const batch =
      await channel.messages.fetch(options);

    if (!batch.size) {
      break;
    }

    let reachedOlderThanRange = false;

    for (const message of batch.values()) {

      // Poruka starija od OD datuma
      if (message.createdAt < from) {
        reachedOlderThanRange = true;
        continue;
      }

      // Poruka novija od DO datuma
      if (message.createdAt > to) {
        continue;
      }

      const event =
        parseEventFromMessage(message);

      if (event) {
        events.push(event);
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

// ======================================================
// SEKCIJA
// ======================================================

function section(title, map) {
  const entries =
    mapToSortedArray(map);

  if (!entries.length) {
    return `**${title}:**\nNema zapisa.`;
  }

  const lines = entries.map(
    ([item, qty]) =>
      `• **${item}** — x${qty}`
  );

  return (
    `**${title}:**\n` +
    lines.join("\n")
  );
}

// ======================================================
// TRENUTNO STANJE
//
// STAVLJENO - PRODANO - SKINUTO
// ======================================================

function calculateCurrentStock(
  listed,
  sold,
  removed
) {
  const currentStock = new Map();

  const allItems = new Set([
    ...listed.keys(),
    ...sold.keys(),
    ...removed.keys(),
  ]);

  for (const item of allItems) {
    const listedQty =
      listed.get(item) || 0;

    const soldQty =
      sold.get(item) || 0;

    const removedQty =
      removed.get(item) || 0;

    const stock =
      listedQty -
      soldQty -
      removedQty;

    currentStock.set(
      item,
      stock
    );
  }

  return currentStock;
}

// ======================================================
// IZVJEŠTAJ
// ======================================================

function buildReport(events, from, to) {
  const sold = new Map();
  const listed = new Map();
  const removed = new Map();

  // ==================================================
  // ZBROJI SVE
  // ==================================================

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

  // ==================================================
  // IZRAČUNAJ TRENUTNO STANJE
  // ==================================================

  const currentStock =
    calculateCurrentStock(
      listed,
      sold,
      removed
    );

  // ==================================================
  // REPORT
  // ==================================================

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

    "━━━━━━━━━━━━━━━━━━━━",

    "",

    section(
      "🏪 TRENUTNO STANJE NA TEZGI",
      currentStock
    ),

    "",

    "📌 **Računica:** STAVLJENO − PRODANO − SKINUTO",

    "",

    `📋 Ukupno pronađenih zapisa: **${events.length}**`,
  ].join("\n");
}

// ======================================================
// ČITANJE !SABERI KOMANDE
// ======================================================

function parseCommandArgs(content) {

  /*
    PODRŽANO:

    !saberi 02.09.2026 01.10.2026

    !saberi 02.09.2026 do 01.10.2026

    !saberi 02/09/2026 01/10/2026

    !saberi 02-09-2026 01-10-2026

    ISTI DAN:

    !saberi 01.10.2026 do 01.10.2026
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

  const from =
    parseDateDMY(
      dates[0],
      false
    );

  const to =
    parseDateDMY(
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

// ======================================================
// BOT ONLINE
// ======================================================

client.once("ready", () => {

  console.log(
    `✅ Bot je online kao ${client.user.tag}`
  );

  console.log(
    `🏪 Store ID: ${STORE_ID}`
  );

  console.log(
    `📍 Timezone: ${TIMEZONE}`
  );

  console.log(
    `📊 Report channel: ${REPORT_CHANNEL_ID}`
  );
});

// ======================================================
// !SABERI
// ======================================================

client.on(
  "messageCreate",
  async (message) => {

    try {

      // Ignoriraj vlastite poruke
      if (
        message.author.bot &&
        message.author.id === client.user.id
      ) {
        return;
      }

      // Mora početi s !saberi
      if (
        !message.content
          ?.toLowerCase()
          .startsWith("!saberi")
      ) {
        return;
      }

      // ==================================================
      // DATUMI
      // ==================================================

      const parsed =
        parseCommandArgs(
          message.content
        );

      if (!parsed) {

        await message.reply(
          "❌ **Pogrešan format.**\n\n" +

          "Koristi:\n" +
          "`!saberi DD.MM.GGGG do DD.MM.GGGG`\n\n" +

          "Primjer:\n" +
          "`!saberi 02.09.2026 do 01.10.2026`"
        );

        return;
      }

      // ==================================================
      // KANAL
      // ==================================================

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

      // ==================================================
      // LOADING
      // ==================================================

      const loadingMessage =
        await message.reply(
          `⏳ Računam podatke...\n\n` +

          `🗓️ **${formatDate(parsed.from)} → ${formatDate(parsed.to)}**`
        );

      // ==================================================
      // DOHVATI SVE
      // ==================================================

      const events =
        await fetchMessagesInRange(
          channel,
          parsed.from,
          parsed.to
        );

      // ==================================================
      // NAPRAVI REPORT
      // ==================================================

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

      // ==================================================
      // REPORT ISPOD 2000 ZNAKOVA
      // ==================================================

      if (report.length <= 2000) {

        await message.reply(
          report
        );

        return;
      }

      // ==================================================
      // AKO JE REPORT PREVELIK
      // ==================================================

      const chunks = [];

      let current = "";

      for (
        const line of report.split("\n")
      ) {

        if (
          (
            current +
            line +
            "\n"
          ).length > 1900
        ) {

          if (current.trim()) {
            chunks.push(
              current.trim()
            );
          }

          current = "";
        }

        current +=
          line + "\n";
      }

      if (current.trim()) {
        chunks.push(
          current.trim()
        );
      }

      // ==================================================
      // POŠALJI SVE DIJELOVE
      // ==================================================

      for (
        const chunk of chunks
      ) {

        await message.channel.send(
          chunk
        );
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
  }
);

// ======================================================
// LOGIN
// ======================================================

client.login(TOKEN);
