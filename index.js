require("dotenv").config();

const fs = require("fs");

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

const STATE_FILE = "./saberi-state.json";
const EARNINGS_STATE_FILE = "./zarada-state.json";

const TIME_ZONE = "Europe/Zagreb";

// Ako nije postavljen poseban kanal za zaradu,
// automatski report ide u REPORT_CHANNEL_ID.
const DAILY_EARNINGS_CHANNEL_ID =
  process.env.DAILY_EARNINGS_CHANNEL_ID ||
  REPORT_CHANNEL_ID;

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
// NORMALIZACIJA
// ======================================================

function normalizeName(name) {
  return String(name || "")
    .replace(/\s+/g, " ")
    .trim();
}

function stockKey(name) {
  return String(name || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function addCount(map, item, amount) {
  item = normalizeName(item);
  amount = Number(amount);

  if (!item || !Number.isFinite(amount)) {
    return;
  }

  map.set(
    item,
    (map.get(item) || 0) + amount
  );
}

// ======================================================
// !SABERI STATE
// ======================================================

function loadState() {
  try {
    if (!fs.existsSync(STATE_FILE)) {
      return {
        lastMessageId: null,
      };
    }

    const data = fs.readFileSync(
      STATE_FILE,
      "utf8"
    );

    const parsed = JSON.parse(data);

    return {
      lastMessageId:
        parsed.lastMessageId || null,
    };

  } catch (error) {
    console.error(
      "❌ Greška kod čitanja saberi-state.json:",
      error
    );

    return {
      lastMessageId: null,
    };
  }
}

function saveState(lastMessageId) {
  try {
    fs.writeFileSync(
      STATE_FILE,
      JSON.stringify(
        {
          lastMessageId,
        },
        null,
        2
      )
    );
  } catch (error) {
    console.error(
      "❌ Greška kod spremanja saberi-state.json:",
      error
    );
  }
}

// ======================================================
// ZARADA STATE
// ======================================================

function loadEarningsState() {
  try {
    if (!fs.existsSync(EARNINGS_STATE_FILE)) {
      return {
        lastDailyReportDate: null,
      };
    }

    const data = fs.readFileSync(
      EARNINGS_STATE_FILE,
      "utf8"
    );

    const parsed = JSON.parse(data);

    return {
      lastDailyReportDate:
        parsed.lastDailyReportDate || null,
    };

  } catch (error) {
    console.error(
      "❌ Greška kod čitanja zarada-state.json:",
      error
    );

    return {
      lastDailyReportDate: null,
    };
  }
}

function saveEarningsState(dateKey) {
  try {
    fs.writeFileSync(
      EARNINGS_STATE_FILE,
      JSON.stringify(
        {
          lastDailyReportDate: dateKey,
        },
        null,
        2
      )
    );
  } catch (error) {
    console.error(
      "❌ Greška kod spremanja zarada-state.json:",
      error
    );
  }
}

// ======================================================
// PARSIRANJE SHOP EMBEDA
// ======================================================

function parseEventFromMessage(message) {
  const embeds = message.embeds || [];

  if (!embeds.length) {
    return null;
  }

  for (const embed of embeds) {
    const title =
      normalizeName(embed.title);

    const description =
      normalizeName(embed.description);

    const fieldsText =
      embed.fields
        ?.map(
          (field) =>
            `${field.name || ""} ${field.value || ""}`
        )
        .join(" ") || "";

    const text =
      normalizeName(
        `${description} ${fieldsText}`
      );

    const allText =
      normalizeName(
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

    if (!type) {
      continue;
    }

    // ==================================================
    // STORE ID
    // ==================================================

    const storeMatch =
      allText.match(
        /store\s*ID\s*[:#-]?\s*([A-Za-z0-9_-]+)/i
      );

    if (
      storeMatch &&
      String(storeMatch[1]) !==
        String(STORE_ID)
    ) {
      continue;
    }

    let match = null;

    // ==================================================
    // PRODANO
    // ==================================================

    if (type === "sold") {
      match = text.match(
        /\bbought\s+(.+?)\s+x(\d+)\s+for\s+\$([\d.,]+)/i
      );

      if (!match) {
        continue;
      }

      const saleAmount =
        Number(
          String(match[3])
            .replace(/,/g, "")
        );

      return {
        type: "sold",
        item: normalizeName(match[1]),
        quantity: Number(match[2]),

        // Cijeli iznos iz "for $..."
        saleAmount:
          Number.isFinite(saleAmount)
            ? saleAmount
            : 0,

        messageId: message.id,

        createdTimestamp:
          message.createdTimestamp,
      };
    }

    // ==================================================
    // STAVLJENO
    // ==================================================

    if (type === "listed") {
      match = text.match(
        /\blisted\s+(.+?)\s+x(\d+)\s+for\s+\$[\d.,]+/i
      );

      if (!match) {
        match = text.match(
          /\blisted\s+(.+?)\s+x(\d+)(?:\s+in|\s+to|\s+store|$)/i
        );
      }

      if (!match) {
        continue;
      }

      return {
        type: "listed",
        item: normalizeName(match[1]),
        quantity: Number(match[2]),
        messageId: message.id,
        createdTimestamp:
          message.createdTimestamp,
      };
    }

    // ==================================================
    // SKINUTO
    // ==================================================

    if (type === "removed") {
      match = text.match(
        /\bremoved\s+(.+?)\s+x(\d+)\s+from\s+(?:the\s+)?store/i
      );

      if (!match) {
        continue;
      }

      return {
        type: "removed",
        item: normalizeName(match[1]),
        quantity: Number(match[2]),
        messageId: message.id,
        createdTimestamp:
          message.createdTimestamp,
      };
    }
  }

  return null;
}

// ======================================================
// NAJNOVIJA PORUKA
// ======================================================

async function getNewestMessage(channel) {
  const batch =
    await channel.messages.fetch({
      limit: 1,
    });

  if (!batch.size) {
    return null;
  }

  return batch.first();
}

// ======================================================
// PORUKE OD PROŠLOG !SABERI
// ======================================================

async function fetchNewMessages(
  channel,
  lastMessageId,
  newestMessageId
) {
  const messages = [];

  if (!lastMessageId) {
    return messages;
  }

  let after = lastMessageId;

  while (true) {
    const batch =
      await channel.messages.fetch({
        limit: 100,
        after,
      });

    if (!batch.size) {
      break;
    }

    const sorted =
      [...batch.values()].sort(
        (a, b) =>
          a.createdTimestamp -
          b.createdTimestamp
      );

    for (const message of sorted) {
      if (
        BigInt(message.id) >
        BigInt(newestMessageId)
      ) {
        continue;
      }

      messages.push(message);
    }

    const newestInBatch =
      sorted[sorted.length - 1];

    if (!newestInBatch) {
      break;
    }

    after = newestInBatch.id;

    if (
      BigInt(after) >=
      BigInt(newestMessageId)
    ) {
      break;
    }

    if (batch.size < 100) {
      break;
    }
  }

  return messages;
}

// ======================================================
// SORTIRANJE MAPA
// ======================================================

function mapToSortedArray(map) {
  return [...map.entries()].sort(
    (a, b) =>
      a[0].localeCompare(
        b[0],
        "hr",
        {
          sensitivity: "base",
        }
      )
  );
}

// ======================================================
// SPOJI ISTE ARTIKLE
// ======================================================

function combineMap(map) {
  const result = new Map();
  const names = new Map();

  for (const [item, qty] of map.entries()) {
    const key =
      stockKey(item);

    result.set(
      key,
      (result.get(key) || 0) +
        Number(qty)
    );

    if (!names.has(key)) {
      names.set(
        key,
        normalizeName(item)
      );
    }
  }

  const finalMap =
    new Map();

  for (const [key, qty] of result.entries()) {
    finalMap.set(
      names.get(key) || key,
      qty
    );
  }

  return finalMap;
}

// ======================================================
// SEKCIJA
// ======================================================

function section(title, map) {
  const combined =
    combineMap(map);

  const entries =
    mapToSortedArray(combined);

  if (!entries.length) {
    return (
      `**${title}:**\n` +
      `Nema novih zapisa.`
    );
  }

  const lines =
    entries.map(
      ([item, qty]) =>
        `• **${item}** — x${qty}`
    );

  return (
    `**${title}:**\n` +
    lines.join("\n")
  );
}

// ======================================================
// IZRAČUN PROMJENE STANJA
// ======================================================

function calculateChange(
  listed,
  sold,
  removed
) {
  const result =
    new Map();

  const displayNames =
    new Map();

  function processMap(
    map,
    multiplier
  ) {
    for (const [item, qty] of map.entries()) {
      const key =
        stockKey(item);

      if (!displayNames.has(key)) {
        displayNames.set(
          key,
          normalizeName(item)
        );
      }

      result.set(
        key,
        (result.get(key) || 0) +
          Number(qty) *
            multiplier
      );
    }
  }

  processMap(listed, 1);
  processMap(sold, -1);
  processMap(removed, -1);

  const finalMap =
    new Map();

  for (const [key, qty] of result.entries()) {
    finalMap.set(
      displayNames.get(key) || key,
      qty
    );
  }

  return finalMap;
}

// ======================================================
// SEKCIJA PROMJENE
// ======================================================

function changeSection(title, map) {
  const entries =
    mapToSortedArray(map);

  if (!entries.length) {
    return (
      `**${title}:**\n` +
      `Nema promjena.`
    );
  }

  const lines =
    entries.map(
      ([item, qty]) => {
        if (qty > 0) {
          return (
            `• **${item}** — +${qty}`
          );
        }

        if (qty < 0) {
          return (
            `• **${item}** — ${qty}`
          );
        }

        return (
          `• **${item}** — 0`
        );
      }
    );

  return (
    `**${title}:**\n` +
    lines.join("\n")
  );
}

// ======================================================
// !SABERI REPORT
// ======================================================

function buildReport(events) {
  const sold =
    new Map();

  const listed =
    new Map();

  const removed =
    new Map();

  for (const event of events) {
    if (
      event.type === "sold"
    ) {
      addCount(
        sold,
        event.item,
        event.quantity
      );
    }

    if (
      event.type === "listed"
    ) {
      addCount(
        listed,
        event.item,
        event.quantity
      );
    }

    if (
      event.type === "removed"
    ) {
      addCount(
        removed,
        event.item,
        event.quantity
      );
    }
  }

  const change =
    calculateChange(
      listed,
      sold,
      removed
    );

  return [
    `📊 **SABERI — Store ID ${STORE_ID}**`,

    `⏱️ **Od prošlog !saberi do sada**`,

    "",

    section(
      "🛒 NOVO PRODANO",
      sold
    ),

    "",

    section(
      "📦 NOVO NAPRAVLJENO / STAVLJENO NA TEZGU",
      listed
    ),

    "",

    section(
      "🗑️ NOVO SKINUTO S TEZGE",
      removed
    ),

    "",

    "━━━━━━━━━━━━━━━━━━━━",

    "",

    changeSection(
      "📊 PROMJENA STANJA OD PROŠLOG !SABERI",
      change
    ),

    "",

    `📋 Novih zapisa: **${events.length}**`,
  ].join("\n");
}

// ======================================================
// POŠALJI !SABERI REPORT
// ======================================================

async function sendReport(
  message,
  report
) {
  if (
    report.length <= 2000
  ) {
    await message.reply(
      report
    );

    return;
  }

  const chunks = [];

  let current = "";

  for (
    const line
    of report.split("\n")
  ) {
    if (
      (
        current +
        line +
        "\n"
      ).length > 1900
    ) {
      if (
        current.trim()
      ) {
        chunks.push(
          current.trim()
        );
      }

      current = "";
    }

    current +=
      line + "\n";
  }

  if (
    current.trim()
  ) {
    chunks.push(
      current.trim()
    );
  }

  for (
    const chunk
    of chunks
  ) {
    await message.channel.send(
      chunk
    );
  }
}

// ======================================================
// DATUM — EUROPE/ZAGREB
// ======================================================

function getZagrebDateParts(
  timestamp = Date.now()
) {
  const formatter =
    new Intl.DateTimeFormat(
      "en-CA",
      {
        timeZone: TIME_ZONE,
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
      }
    );

  const parts =
    formatter.formatToParts(
      new Date(timestamp)
    );

  const values = {};

  for (const part of parts) {
    if (
      part.type !== "literal"
    ) {
      values[part.type] =
        part.value;
    }
  }

  const key =
    `${values.year}-${values.month}-${values.day}`;

  return {
    year: Number(values.year),
    month: Number(values.month),
    day: Number(values.day),
    key,
  };
}

// ======================================================
// POMAK DATUMA
// ======================================================

function shiftCalendarDate(
  dateKey,
  days
) {
  const [
    year,
    month,
    day
  ] =
    dateKey
      .split("-")
      .map(Number);

  const date =
    new Date(
      Date.UTC(
        year,
        month - 1,
        day
      )
    );

  date.setUTCDate(
    date.getUTCDate() + days
  );

  return [
    date.getUTCFullYear(),

    String(
      date.getUTCMonth() + 1
    ).padStart(2, "0"),

    String(
      date.getUTCDate()
    ).padStart(2, "0"),
  ].join("-");
}

// ======================================================
// DATUM ZA PRIKAZ
// ======================================================

function displayDateKey(dateKey) {
  const [
    year,
    month,
    day
  ] =
    dateKey.split("-");

  return (
    `${day}.${month}.${year}.`
  );
}

// ======================================================
// FORMAT NOVCA
// ======================================================

function formatMoney(amount) {
  return Number(
    amount || 0
  ).toFixed(2);
}

// ======================================================
// PORUKE ZA ODREĐENI DAN
// ======================================================

async function fetchMessagesForDate(
  channel,
  dateKey
) {
  const messages = [];

  let before = null;
  let finished = false;

  while (!finished) {
    const options = {
      limit: 100,
    };

    if (before) {
      options.before = before;
    }

    const batch =
      await channel.messages.fetch(
        options
      );

    if (!batch.size) {
      break;
    }

    const sortedNewestFirst =
      [...batch.values()].sort(
        (a, b) =>
          b.createdTimestamp -
          a.createdTimestamp
      );

    for (
      const msg
      of sortedNewestFirst
    ) {
      const msgDateKey =
        getZagrebDateParts(
          msg.createdTimestamp
        ).key;

      if (
        msgDateKey === dateKey
      ) {
        messages.push(msg);

      } else if (
        msgDateKey < dateKey
      ) {
        finished = true;
        break;
      }
    }

    const oldest =
      sortedNewestFirst[
        sortedNewestFirst.length - 1
      ];

    if (
      !oldest ||
      finished ||
      batch.size < 100
    ) {
      break;
    }

    before = oldest.id;
  }

  return messages;
}

// ======================================================
// IZRAČUN ZARADE ZA DAN
// ======================================================

async function calculateEarningsForDate(
  dateKey
) {
  const channel =
    await client.channels.fetch(
      REPORT_CHANNEL_ID
    );

  if (
    !channel ||
    !channel.isTextBased() ||
    !channel.messages
  ) {
    throw new Error(
      "REPORT_CHANNEL_ID nije valjan tekstualni kanal."
    );
  }

  const messages =
    await fetchMessagesForDate(
      channel,
      dateKey
    );

  const soldEvents = [];

  for (
    const shopMessage
    of messages
  ) {
    const event =
      parseEventFromMessage(
        shopMessage
      );

    if (
      event &&
      event.type === "sold"
    ) {
      soldEvents.push(
        event
      );
    }
  }

  let totalMoney = 0;
  let totalQuantity = 0;

  const byItem =
    new Map();

  for (
    const event
    of soldEvents
  ) {
    totalMoney +=
      Number(
        event.saleAmount || 0
      );

    totalQuantity +=
      Number(
        event.quantity || 0
      );

    const key =
      stockKey(event.item);

    const current =
      byItem.get(key) || {
        name: event.item,
        quantity: 0,
        money: 0,
      };

    current.quantity +=
      Number(
        event.quantity || 0
      );

    current.money +=
      Number(
        event.saleAmount || 0
      );

    byItem.set(
      key,
      current
    );
  }

  return {
    dateKey,

    saleCount:
      soldEvents.length,

    totalQuantity,

    totalMoney,

    byItem:
      [...byItem.values()].sort(
        (a, b) =>
          a.name.localeCompare(
            b.name,
            "hr",
            {
              sensitivity: "base",
            }
          )
      ),
  };
}

// ======================================================
// REPORT ZARADE
// ======================================================

function buildEarningsReport(
  data,
  finalReport = false
) {
  const title =
    finalReport
      ? `💰 **DNEVNA ZARADA — ${displayDateKey(data.dateKey)}**`
      : `💰 **ZARADA DANAS — ${displayDateKey(data.dateKey)}**`;

  const itemLines =
    data.byItem.length
      ? data.byItem.map(
          (item) =>
            `• **${item.name}** — x${item.quantity} — **$${formatMoney(item.money)}**`
        )
      : [
          "• Nema prodaje za ovaj dan."
        ];

  return [
    title,

    `🏪 Store ID: **${STORE_ID}**`,

    "",

    ...itemLines,

    "",

    "━━━━━━━━━━━━━━━━━━━━",

    `🧾 Broj kupnji: **${data.saleCount}**`,

    `🛒 Ukupno prodanih komada: **${data.totalQuantity}**`,

    `💵 **UKUPNA ZARADA: $${formatMoney(data.totalMoney)}**`,

    "",

    finalReport
      ? "✅ **Dan zaključen.**"
      : "⏰ Konačni dnevni obračun bot šalje u **00:00**.",
  ].join("\n");
}

// ======================================================
// POŠALJI DUGAČAK TEKST
// ======================================================

async function sendLongText(
  channel,
  text
) {
  if (
    text.length <= 2000
  ) {
    await channel.send(text);
    return;
  }

  let current = "";

  for (
    const line
    of text.split("\n")
  ) {
    if (
      (
        current +
        line +
        "\n"
      ).length > 1900
    ) {
      if (
        current.trim()
      ) {
        await channel.send(
          current.trim()
        );
      }

      current = "";
    }

    current +=
      line + "\n";
  }

  if (
    current.trim()
  ) {
    await channel.send(
      current.trim()
    );
  }
}

// ======================================================
// SVE PORUKE IZ REPORT KANALA
// ZA !ZARADASVE
// ======================================================

async function fetchAllReportMessages(
  channel
) {
  const allMessages = [];

  let before = null;

  console.log(
    "🔎 Čitam cijelu povijest report kanala..."
  );

  while (true) {
    const options = {
      limit: 100,
    };

    if (before) {
      options.before = before;
    }

    const batch =
      await channel.messages.fetch(
        options
      );

    if (!batch.size) {
      break;
    }

    const messages =
      [...batch.values()];

    allMessages.push(
      ...messages
    );

    console.log(
      `📥 Učitano poruka: ${allMessages.length}`
    );

    // Pronađi najstariju poruku
    const oldest =
      messages.reduce(
        (
          oldestMessage,
          currentMessage
        ) => {
          if (
            !oldestMessage ||
            currentMessage.createdTimestamp <
              oldestMessage.createdTimestamp
          ) {
            return currentMessage;
          }

          return oldestMessage;
        },
        null
      );

    if (!oldest) {
      break;
    }

    before =
      oldest.id;

    if (
      batch.size < 100
    ) {
      break;
    }
  }

  console.log(
    `✅ Povijest učitana. Ukupno ${allMessages.length} poruka.`
  );

  return allMessages;
}

// ======================================================
// ZARADA ZA SVE STARE DANE
// ======================================================

function buildAllDaysEarningsReport(
  messages
) {
  const days =
    new Map();

  let totalAllDays = 0;
  let totalAllQuantity = 0;
  let totalPurchases = 0;

  for (
    const shopMessage
    of messages
  ) {
    const event =
      parseEventFromMessage(
        shopMessage
      );

    if (
      !event ||
      event.type !== "sold"
    ) {
      continue;
    }

    const dateKey =
      getZagrebDateParts(
        event.createdTimestamp
      ).key;

    if (
      !days.has(dateKey)
    ) {
      days.set(
        dateKey,
        {
          money: 0,
          quantity: 0,
          purchases: 0,
        }
      );
    }

    const day =
      days.get(dateKey);

    day.money +=
      Number(
        event.saleAmount || 0
      );

    day.quantity +=
      Number(
        event.quantity || 0
      );

    day.purchases += 1;

    totalAllDays +=
      Number(
        event.saleAmount || 0
      );

    totalAllQuantity +=
      Number(
        event.quantity || 0
      );

    totalPurchases += 1;
  }

  // Od najstarijeg prema najnovijem
  const sortedDays =
    [...days.entries()].sort(
      (a, b) =>
        a[0].localeCompare(
          b[0]
        )
    );

  const lines = [
    `💰 **ZARADA PO SVIM DANIMA — Store ID ${STORE_ID}**`,
    "",
  ];

  if (
    !sortedDays.length
  ) {
    lines.push(
      "❌ Nije pronađena nijedna `Purchase Made` prodaja."
    );

    return lines.join("\n");
  }

  for (
    const [dateKey, data]
    of sortedDays
  ) {
    lines.push(
      `📅 **${displayDateKey(dateKey)}**`
    );

    lines.push(
      `🧾 Kupnji: **${data.purchases}**`
    );

    lines.push(
      `🛒 Prodano: **${data.quantity} kom.**`
    );

    lines.push(
      `💵 Zarada: **$${formatMoney(data.money)}**`
    );

    lines.push("");
  }

  lines.push(
    "━━━━━━━━━━━━━━━━━━━━"
  );

  lines.push("");

  lines.push(
    `📆 Broj dana: **${sortedDays.length}**`
  );

  lines.push(
    `🧾 Ukupno kupnji: **${totalPurchases}**`
  );

  lines.push(
    `🛒 Ukupno prodano: **${totalAllQuantity} kom.**`
  );

  lines.push(
    `💰 **UKUPNA ZARADA SVIH DANA: $${formatMoney(totalAllDays)}**`
  );

  return lines.join("\n");
}

// ======================================================
// AUTOMATSKI DNEVNI OBRAČUN
// ======================================================

let dailyCheckRunning = false;

async function checkDailyEarningsReport() {
  if (
    dailyCheckRunning
  ) {
    return;
  }

  dailyCheckRunning = true;

  try {
    const today =
      getZagrebDateParts().key;

    const yesterday =
      shiftCalendarDate(
        today,
        -1
      );

    const state =
      loadEarningsState();

    // Prvo pokretanje:
    // zapamti jučer da ne šalje stare dane automatski.
    if (
      !state.lastDailyReportDate
    ) {
      saveEarningsState(
        yesterday
      );

      return;
    }

    // Već poslan jučerašnji report
    if (
      state.lastDailyReportDate ===
      yesterday
    ) {
      return;
    }

    const data =
      await calculateEarningsForDate(
        yesterday
      );

    const report =
      buildEarningsReport(
        data,
        true
      );

    const outputChannel =
      await client.channels.fetch(
        DAILY_EARNINGS_CHANNEL_ID
      );

    if (
      !outputChannel ||
      !outputChannel.isTextBased()
    ) {
      throw new Error(
        "DAILY_EARNINGS_CHANNEL_ID nije valjan tekstualni kanal."
      );
    }

    await sendLongText(
      outputChannel,
      report
    );

    saveEarningsState(
      yesterday
    );

    console.log(
      `💰 Poslan dnevni obračun za ${yesterday}: $${formatMoney(data.totalMoney)}`
    );

  } catch (error) {
    console.error(
      "❌ Greška kod dnevnog obračuna:",
      error
    );

  } finally {
    dailyCheckRunning = false;
  }
}

// ======================================================
// BOT ONLINE
// ======================================================

client.once(
  "ready",
  () => {
    console.log(
      `✅ Bot je online kao ${client.user.tag}`
    );

    console.log(
      `🏪 Store ID: ${STORE_ID}`
    );

    console.log(
      `📊 Report channel: ${REPORT_CHANNEL_ID}`
    );

    console.log(
      `💾 Saberi state: ${STATE_FILE}`
    );

    console.log(
      `💰 Zarada kanal: ${DAILY_EARNINGS_CHANNEL_ID}`
    );

    console.log(
      `🕛 Vremenska zona: ${TIME_ZONE}`
    );

    // Provjerava svakih 30 sekundi
    // je li potrebno poslati jučerašnji report.
    checkDailyEarningsReport();

    setInterval(
      checkDailyEarningsReport,
      30 * 1000
    );
  }
);

// ======================================================
// KOMANDE
// ======================================================

let calculatingAllEarnings = false;

client.on(
  "messageCreate",

  async (message) => {
    try {
      if (
        message.author.bot
      ) {
        return;
      }

      const command =
        message.content
          ?.trim()
          .toLowerCase();

      // ==================================================
      // !PROVERI
      // ==================================================

      if (
        command === "!proveri"
      ) {
        await message.channel
          .sendTyping()
          .catch(() => {});

        const today =
          getZagrebDateParts().key;

        const data =
          await calculateEarningsForDate(
            today
          );

        const report =
          buildEarningsReport(
            data,
            false
          );

        await sendLongText(
          message.channel,
          report
        );

        return;
      }

      // ==================================================
      // !ZARADASVE
      // ==================================================

      if (
        command === "!zaradasve"
      ) {
        if (
          calculatingAllEarnings
        ) {
          await message.reply(
            "⏳ Već računam staru zaradu. Pričekaj da završim."
          );

          return;
        }

        calculatingAllEarnings = true;

        await message.reply(
          "🔎 **Računam zaradu za sve stare dane...**\n" +
          "Čitam cijelu dostupnu povijest report kanala. Ovo može malo potrajati."
        );

        try {
          const channel =
            await client.channels.fetch(
              REPORT_CHANNEL_ID
            );

          if (
            !channel ||
            !channel.isTextBased() ||
            !channel.messages
          ) {
            throw new Error(
              "REPORT_CHANNEL_ID nije valjan tekstualni kanal."
            );
          }

          const allMessages =
            await fetchAllReportMessages(
              channel
            );

          const report =
            buildAllDaysEarningsReport(
              allMessages
            );

          await sendLongText(
            message.channel,
            report
          );

        } finally {
          calculatingAllEarnings =
            false;
        }

        return;
      }

      // ==================================================
      // !SABERI
      // ==================================================

      if (
        command !== "!saberi"
      ) {
        return;
      }

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

      const newestMessage =
        await getNewestMessage(
          channel
        );

      if (
        !newestMessage
      ) {
        await message.reply(
          "❌ Nema poruka u report kanalu."
        );

        return;
      }

      const state =
        loadState();

      // ==================================================
      // PRVI !SABERI
      // ==================================================

      if (
        !state.lastMessageId
      ) {
        saveState(
          newestMessage.id
        );

        await message.reply(
          "✅ **Početna točka postavljena!**\n\n" +
          "Od sada bot prati sve novo.\n" +
          "Kad sljedeći put napišeš `!saberi`, " +
          "izbacit će samo ono što se dogodilo nakon ove komande."
        );

        return;
      }

      // ==================================================
      // NOVE PORUKE
      // ==================================================

      const newMessages =
        await fetchNewMessages(
          channel,
          state.lastMessageId,
          newestMessage.id
        );

      const events = [];

      for (
        const shopMessage
        of newMessages
      ) {
        const event =
          parseEventFromMessage(
            shopMessage
          );

        if (
          event
        ) {
          events.push(
            event
          );
        }
      }

      // ==================================================
      // REPORT
      // ==================================================

      const report =
        buildReport(
          events
        );

      await sendReport(
        message,
        report
      );

      // Tek nakon uspješnog reporta
      // spremi novu početnu točku.
      saveState(
        newestMessage.id
      );

    } catch (error) {
      console.error(
        "❌ Greška kod komande:",
        error
      );

      calculatingAllEarnings =
        false;

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
