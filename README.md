# QuickListInventoryAI

**Live app:** https://quicklist-inventory-ai.onrender.com

Snap a product photo. QuickListInventoryAI writes the listing, publishes it to your stores and marketplaces, and keeps one stock count across every channel, so a sale on one channel updates all of them.

The free hosting sleeps when it is idle, so the first visit can take up to a minute to load.

## What it does

Small sellers often list the same product on Shopify, Amazon, Flipkart and Meesho, then update stock by hand after every sale. That leads to overselling and wasted time. QuickListInventoryAI does the work for them:

1. **Snap.** Take a photo. The app reads it and writes the title, colour, bullet points, description, search terms, and HSN and GST suggestions.
2. **Finish.** Add only what a photo can't show: sizes, stock and prices. Type them as one line in English, Hindi or Hinglish, or fill in the form.
3. **Publish.** The product is created on Shopify with its photos, one variant per size and the stock for each. Other channels get the same stock.
4. **Sell.** A sale on any channel lowers the one count. A WhatsApp message such as `sold 1 SKU` does the same. Every other channel is updated.

## Features

- **Photo to listing.** Meta's Muse Spark model reads the photo and writes the listing text.
- **Photo tools.** Crop, rotate and brighten a photo. Switch a photo to a white background. Edit a photo with AI by typing the change you want, for example "soft grey studio backdrop". Make a mannequin or model photo from a note such as "put it on a mannequin".
- **Several photos per listing.** Up to eight photos. Each one chooses its own version, as is or white background.
- **Details in one line.** Type sizes, stock and prices in English, Hindi or Hinglish. The app fills in the form and shows the discount below MRP.
- **One stock count.** Stock page with one row per SKU, +1, −1 and +10 buttons, low-stock and out-of-stock filters, and photos on each row.
- **Shopify (live).** Connect your store with a client ID and secret from the Shopify Dev Dashboard. Each publish creates the product, its variants, the stock and the photos.
- **Other marketplaces.** Amazon India and Flipkart stock sync through their APIs. Meesho uses a bulk sheet. WooCommerce and your own website are supported too.
- **Orders.** Record a sale from any channel, and the stock updates everywhere. An order larger than the stock is flagged as oversold.
- **WhatsApp.** Send a photo to list a product. Reply with `studio`, `original` or `yes`. Commands include `sold`, `restock`, `stock` and `low stock`.
- **Listings readiness.** Each product is checked against each marketplace's basic requirements, and anything missing is shown.
- **Sheets.** Download CSV listing sheets for Amazon, Flipkart, Meesho and Shopify.
- **Connect marketplaces.** One page to connect, test and disconnect each channel. Keys are stored encrypted and are never shown again.
- **API and MCP.** A REST API for your own tools, and an MCP endpoint with five inventory tools for AI agents.

## Built with

- **Meta Model API.** Muse Spark reads the photos and writes the listing text. Muse Image edits the photos for white backgrounds, AI edits and mannequin shots.
- **Node.js** with no framework, and a plain JavaScript web app.
- **Neon Postgres** in production. An in-process Postgres (PGlite) runs locally when no database URL is set.
- **Shopify Admin API**, **WhatsApp Cloud API** and marketplace APIs.
- **Render** for hosting.

## Run it locally

You need **Node.js 22 or newer**.

```bash
npm install
cp .env.example .env
npm start
```

On Windows, use `copy .env.example .env` instead of `cp`. Then open http://localhost:3000 and open a shop. The app shows your access token once, so save it.

Generate the secrets in `.env` with:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
```

| Variable | Needed for |
| --- | --- |
| `MASTER_KEY` | Encrypting the keys you save on the Connect marketplaces page. Required for those. |
| `MEDIA_SECRET` | Signing public image links. Recommended. |
| `META_API_KEY` | Photo reading and AI photo edits through the Meta Model API. |
| `DATABASE_URL` | A Postgres URL. Leave it empty to use the local database. |
| `PUBLIC_BASE_URL` | The public address of the app. Shopify and WhatsApp need it to reach your photos. |
| `WHATSAPP_TOKEN`, `WHATSAPP_PHONE_NUMBER_ID`, `WHATSAPP_VERIFY_TOKEN`, `WHATSAPP_APP_SECRET` | The WhatsApp bot. |

Never commit `.env`. It is git-ignored.

Run the tests and the build check:

```bash
npm test
npm run build
```

## Connect your marketplaces

Open **Connect marketplaces** in the sidebar. Each channel has its own card.

- **Shopify:** in the Shopify Dev Dashboard, create an app with product and inventory access, install it on your store, then enter the store domain, the Client ID, the Client secret and the location ID.
- **Meesho:** enter your supplier ID. Stock updates use the bulk sheet until Meesho opens its API.
- **Amazon India and Flipkart:** enter the keys from your seller developer account.
- **WooCommerce and your own website:** enter the site address and the keys. Pushes to a website are signed with `X-QuickList-Signature`.

## Security

- Marketplace and store keys are encrypted with AES-256-GCM before they are stored. The key lives only in `MASTER_KEY`.
- Keys are never sent back to the browser. The screen shows only the last four characters.
- Passwords are hashed with scrypt. Sign-in tokens are stored only as hashes.
- Public image links are signed, so no one can guess another seller's photo.
- Addresses sellers type must use HTTPS and must not point at private networks.

## Known limits

- Live stock sync to Amazon India, Flipkart and WooCommerce has not been checked against live accounts.
- An AI photo edit takes about 15 to 30 seconds.
- The local cleanup for white backgrounds works only on plain backgrounds. Use the Meta key for busy ones.
- Connecting by one-click install (OAuth) is not built. Sellers paste their keys.
- Shopify product photos are sent from `PUBLIC_BASE_URL`. If that is not set, the product is created without photos, and the publish screen says so.

## Hackathon

Built for the Meta Global AI Developer Hackathon, Indie Developer track.
