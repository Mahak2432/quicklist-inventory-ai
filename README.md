---
title: QuickListInventoryAI
emoji: 🧾
colorFrom: indigo
colorTo: red
sdk: docker
app_port: 7860
pinned: false
---

# QuickListInventoryAI

Snap a product photo. QuickListInventoryAI writes the listing, keeps one stock count across every channel, and takes orders from the web, WhatsApp and connected stores.

**Built for the Meta Global AI Developer Hackathon** (problem statement: Build for Your World; Indie Developer track). Everything in this repository was written during the building period. It uses Muse Spark through the Meta Model API. The submission checklist and demo plan are in [docs/SUBMISSION.md](docs/SUBMISSION.md).

## Run it on your computer

You need Node.js 22.13 or newer (24 recommended). Node's built-in SQLite needs it.

```bash
npm install
```

Copy `.env.example` to `.env`. Then generate the two secrets. Run this twice, and paste one output into `MASTER_KEY` and the other into `MEDIA_SECRET`:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
```

Start the app:

```bash
npm start
```

Open http://localhost:3000, open a shop, and save the token it shows. It is shown once.

Run the checks:

```bash
npm test
```

## Set up the Meta key

`npm start` reads `.env` automatically, so the key only has to live in that file.

1. Open the Meta developer console at dev.meta.ai and go to **API keys**. The list shows a masked key. Meta shows the full key only when it is created. If you did not save it, select **Create API key**, name it `quicklist-inventory-ai`, and copy it straight away.
2. In the project folder, copy `.env.example` to `.env`.
3. Open `.env` in a text editor and set `META_API_KEY=` to the key, then save. Do not paste the key into chat, and do not commit `.env`. It is already git-ignored.
4. Run `npm run check:meta`. It makes one tiny test call and prints the models your key can see. You want to see `Reply call worked.`
5. If you get a 401, check for spaces around the key, or create a new key. If the model name is missing from the list, set `META_SPARK_MODEL` to a name from that list.
6. Open **Billing** and **Usage** in the console after testing, so you can see what each call costs.

Your $150 free credit is Meta Model API credit. While free credits are in use, Meta says your content may be used for product improvement. Before real sellers upload photos, decide whether that is acceptable. "Stop using free credits" switches to pay-as-you-go on the card on file, so only click it if you accept charges.

## What you need to provide

Never paste these into chat or WhatsApp. Put server values in the host's environment settings. Enter marketplace keys only on the **Settings → Stores and marketplaces** page.

| Item | Where it goes | Needed for |
| --- | --- | --- |
| `MASTER_KEY` | server env | Saving any store or marketplace key. Required. |
| `MEDIA_SECRET` | server env | Signing public image links. Recommended. |
| `META_API_KEY` | server env | Reading photos (Muse Spark) and studio photos (Muse Image). Uses your free Meta credit. |
| `WHATSAPP_TOKEN`, `WHATSAPP_PHONE_NUMBER_ID` | server env | Replies on your business test number. |
| `WHATSAPP_VERIFY_TOKEN`, `WHATSAPP_APP_SECRET` | server env | Verifying Meta's webhook and signatures. |
| `PUBLIC_BASE_URL` | server env | Image links for marketplaces, and the WhatsApp webhook. Needs a public HTTPS address. |
| Marketplace and store keys | Settings page in the app | Stock sync to Amazon, Flipkart, Meesho, Shopify, WooCommerce and your website. |

## Testing the connections

- **Demo marketplace:** no account needed. Connect it, then place a test order from the Orders page. Each stock push appears on the Settings page. Start here.
- **Shopify:** create a free development store in the Shopify Partners dashboard. Make a custom app with inventory and product scopes, then paste its Admin API token.
- **WooCommerce:** run WordPress with WooCommerce on your computer (for example with Local or Docker). Create Read/Write REST keys under WooCommerce → Settings → Advanced.
- **My own website:** point it at a test receiver such as webhook.site. Pushes arrive signed with `X-QuickList-Signature`. Use test data only.
- **Amazon India and Flipkart:** need developer and seller accounts. The Amazon request shapes come from the SP-API documentation and are untested against a live account. Check them in the Amazon sandbox before go-live.
- **Meesho:** stock sync goes through the bulk sheet only. Meesho does not offer a stock API to new sellers.

## WhatsApp test number

1. In the Meta developer console, open your app and add the WhatsApp product. Copy the test number's **Phone number ID**. Create a system-user token and put it in `WHATSAPP_TOKEN`.
2. Set the webhook URL to `https://<your-public-address>/webhooks/whatsapp`. Use `WHATSAPP_VERIFY_TOKEN` as the verify token, then subscribe to `messages`.
3. The test number can only message numbers you have added as test recipients.
4. To test locally, a free Cloudflare quick tunnel gives your localhost a public HTTPS address.
5. Replies within 24 hours of a customer message are free. Messages outside that window need approved templates and can cost money.

## Hosting

The repo includes a `Dockerfile` that runs on any Docker host. The app listens on port 7860 by default, and the database is kept in `/data`.

- **Hugging Face Spaces (free, no card):** create a Docker Space and push this repo. The free tier sleeps when idle and its disk resets on restart, so seller data is lost on each restart. Fine for a demo, not for real sellers.
- **A host with a persistent volume:** needed for real data. Use the free credit you were given on a platform that offers a volume, and mount it at `/data`. Tell me which provider issued the credit and I will check its volume and pricing rules.

The hackathon's official rules were not visible to me, so I could not confirm any hosting requirements. Check the official rules page before submitting.

## Security

- Seller keys are encrypted with AES-256-GCM before they are stored. The key lives only in `MASTER_KEY`. If you lose it, sellers must re-enter their keys.
- Keys are never sent back to the browser. The screen shows only the last four characters.
- Addresses sellers type (store domain, site address, webhook URL) must use https and must not point at private networks. Redirects are refused.
- Serve the app over HTTPS in production. Rotate any key that was ever pasted into a chat.

## Known limits

- Live stock sync to Amazon, Flipkart, Shopify and WooCommerce is not yet verified against live accounts.
- Shopify and WooCommerce need each SKU's variant or product ID, linked with `POST /api/channels`. There is no screen for this yet.
- Inbound orders from Shopify or Amazon need a relay that signs and forwards them. Only the signed-token path is built.
- Voice notes are not supported. Muse Image studio edits are unverified, and the local cleanup handles plain backgrounds only.
- Connecting by OAuth (install-with-one-click) is not built. Sellers paste keys.
- SQLite on one server suits a demo, not many sellers at once.

## API overview

All `/api` routes need `Authorization: Bearer <token>`. The MCP endpoint is at `/mcp` and exposes five inventory tools.

- `POST /api/tenants`: open a shop (returns the token once)
- `POST /api/listings/drafts`: upload a photo (`Content-Type: image/*`)
- `PATCH /api/listings/drafts/:id`: edit fields, answers, free text or `image_mode`
- `POST /api/listings/drafts/:id/publish`: create the product and SKUs
- `GET /api/products`, `GET /api/stock/:sku`, `POST /api/stock/:sku/adjust`
- `POST /api/orders/:platform`: `AMAZON_IN`, `FLIPKART`, `MEESHO`, `SHOPIFY`, `WOOCOMMERCE`, `CUSTOM_SITE`, `DEMO`
- `GET /api/connections`, `PUT /api/connections/:platform`, `POST /api/connections/:platform/test`, `DELETE /api/connections/:platform`
- `GET /api/exports/:platform.csv`, `GET /api/readiness/:platform`
- `POST /api/whatsapp/simulate`: run the WhatsApp flow without Meta, for testing
