# Discord `!saberi` bot

Bot čita shop logove iz jednog Discord kanala i na komandu:

`!saberi 01.10.2026 10.10.2026`

zbraja:

- 🛒 **Prodano** — `Purchase Made`
- 📦 **Napravljeno / stavljeno na tezgu** — `New Item Listed`
- 🗑️ **Skinuto s tezge** — `Item Removed`

Količine se zbrajaju po artiklu, npr. ako je jednom prodano `x3`, a drugi put `x4`, rezultat je `x7`.

## 1. Instalacija

Trebaš Node.js 18.17+.

```bash
npm install
```

## 2. `.env`

Kopiraj `.env.example` u `.env` i upiši:

```env
DISCORD_TOKEN=token_tvojeg_bota
REPORT_CHANNEL_ID=ID_KANALA_U_KOJEM_SU_LOGOVI
STORE_ID=61
TIMEZONE=Europe/Zagreb
```

**Nikad ne stavljaj pravi bot token na GitHub.** `.env` je već u `.gitignore`.

## 3. Discord Developer Portal

Napravi Discord Application/Bot i uključi:

- `MESSAGE CONTENT INTENT`
- bot mora imati pristup kanalu s logovima
- bot mora imati pravo `View Channel`
- `Read Message History`
- `Send Messages`

## 4. Pokretanje

```bash
npm start
```

Ako je sve dobro, konzola će pokazati:

```text
Bot je online kao ImeBota#0000
```

## 5. Komanda

```text
!saberi 01.10.2026 10.10.2026
```

Može i:

```text
!saberi 01.10.2026 do 10.10.2026
```

Datum početka računa od 00:00:00, a datum završetka uključuje cijeli dan do 23:59:59.

## Kako bot prepoznaje logove

Bot očekuje format kao na screenshotovima:

```text
Purchase Made
... bought Kaubojska Kobasica x3 for $13.50 from store ID 61.
```

```text
New Item Listed
... listed Sok Od Jabuke x1 for $9.00 in store ID 61.
```

```text
Item Removed
... removed Kaubojska Corba x5 from store ID 61.
```

Ako je `STORE_ID=61`, drugi store ID se ignorira.

## Primjer rezultata

```text
📊 SABERI — Store ID 61
🗓️ Period: 01.10.2026. 00:00 → 10.10.2026. 23:59

🛒 PRODANO:
• Kaubojska Kobasica — x7
• Pivo — x5
• Rakija Jabuka — x9

📦 NAPRAVLJENO / STAVLJENO NA TEZGU:
• Sok Od Jabuke — x3
• Kutija cigara — x2

🗑️ SKINUTO S TEZGE:
• Kaubojska Corba — x7

Ukupno zapisa: 9
```

## GitHub

Na GitHubu napravi novi repository, npr. `discord-saberi-bot`, pa:

```bash
git init
git add .
git commit -m "Initial Discord saberi bot"
git branch -M main
git remote add origin https://github.com/TVORAC/discord-saberi-bot.git
git push -u origin main
```

Na GitHub **ne uploadati `.env`** i nikad ne objavljivati bot token.
