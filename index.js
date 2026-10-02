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
// SPREMANJE ZADNJEG !SABERI
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
// ČITANJE SHOP EMBEDA
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
        /\bbought\s+(.+?)\s+x(\d+)\s+for\s+\$[\d.,]+/i
      );

      if (!match) {
        continue;
      }

      return {
        type: "sold",
        item: normalizeName(match[1]),
        quantity: Number(match[2]),
        messageId: message.id,
        createdTimestamp:
          message.createdTimestamp,
      };
    }

    // ==================================================
    // STAVLJENO / NAPRAVLJENO
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
// DOHVATI NAJNOVIJU PORUKU IZ REPORT KANALA
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
// DOHVATI SAMO NOVE PORUKE OD PROŠLOG !SABERI
// ======================================================

async function fetchNewMessages(
  channel,
  lastMessageId,
  newestMessageId
) {
  const messages = [];

  // Ako još nemamo početnu točku,
  // ne želimo povući cijelu staru povijest.
  if (!lastMessageId) {
    return messages;
  }

  let after = lastMessageId;

  while (true) {
    const batch =
      await channel.messages.fetch({
        limit: 100,
        after: after,
      });

    if (!batch.size) {
      break;
    }

    // Discord Collection može doći u različitom redoslijedu.
    // Sortiramo od najstarije prema najnovijoj.
    const sorted = [
      ...batch.values(),
    ].sort(
      (a, b) =>
        a.createdTimestamp -
        b.createdTimestamp
    );

    for (const message of sorted) {
      // Ne idi dalje od poruke koja je bila
      // najnovija u trenutku !saberi komande.
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

  for (
    const [item, qty]
    of map.entries()
  ) {
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

  const finalMap = new Map();

  for (
    const [key, qty]
    of result.entries()
  ) {
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
//
// NOVO STAVLJENO
// - NOVO PRODANO
// - NOVO SKINUTO
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
    for (
      const [item, qty]
      of map.entries()
    ) {
      const key =
        stockKey(item);

      if (
        !displayNames.has(key)
      ) {
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

  // Dodano na tezgu
  processMap(
    listed,
    1
  );

  // Prodano
  processMap(
    sold,
    -1
  );

  // Skinuto
  processMap(
    removed,
    -1
  );

  const finalMap =
    new Map();

  for (
    const [key, qty]
    of result.entries()
  ) {
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

function changeSection(
  title,
  map
) {
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
// NAPRAVI REPORT
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
// PODIJELI REPORT AKO JE PREVELIK
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
      `💾 State file: ${STATE_FILE}`
    );
  }
);

// ======================================================
// !SABERI
// ======================================================

client.on(
  "messageCreate",

  async (message) => {
    try {
      // Ignoriraj vlastite poruke bota
      if (
        message.author.bot &&
        message.author.id ===
          client.user.id
      ) {
        return;
      }

      // Komanda mora biti TOČNO !saberi
      if (
        message.content
          ?.trim()
          .toLowerCase() !==
        "!saberi"
      ) {
        return;
      }

      // ==================================================
      // REPORT CHANNEL
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
      // NAJNOVIJA SHOP PORUKA
      // ==================================================

      const newestMessage =
        await getNewestMessage(
          channel
        );

      if (!newestMessage) {
        await message.reply(
          "❌ Nema poruka u report kanalu."
        );

        return;
      }

      // ==================================================
      // UČITAJ GDJE JE PROŠLI !SABERI STAO
      // ==================================================

      const state =
        loadState();

      // ==================================================
      // PRVI !SABERI
      //
      // Samo postavlja početnu točku.
      // Ne vuče stare poruke.
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
      // UZMI SAMO NOVE PORUKE
      // ==================================================

      const newMessages =
        await fetchNewMessages(
          channel,
          state.lastMessageId,
          newestMessage.id
        );

      // ==================================================
      // PARSIRAJ SAMO SHOP DOGAĐAJE
      // ==================================================

      const events = [];

      for (
        const shopMessage
        of newMessages
      ) {
        const event =
          parseEventFromMessage(
            shopMessage
          );

        if (event) {
          events.push(
            event
          );
        }
      }

      // ==================================================
      // NAPRAVI REPORT
      // ==================================================

      const report =
        buildReport(events);

      // ==================================================
      // POŠALJI REPORT
      // ==================================================

      await sendReport(
        message,
        report
      );

      // ==================================================
      // TEK NAKON USPJEŠNOG REPORTA
      // ZAPAMTI NOVU TOČKU
      //
      // Sljedeći !saberi kreće odavde.
      // ==================================================

      saveState(
        newestMessage.id
      );

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
