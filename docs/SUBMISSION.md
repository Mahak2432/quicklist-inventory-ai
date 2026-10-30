# QuickListInventoryAI: submission checklist and demo plan

## What the event requires

From the participant guide and official rules:

- **Problem statement:** Build for Your World. Solve a problem you know firsthand.
- **Meta models:** the project must use models through the Meta Model API.
- **Track:** Indie Developer (individual builders and students, or a team of up to four). Startups are a separate track.
- **Public repository:** the code must be open source and publicly accessible.
- **New work only:** everything presented must have been built during the event. Use only code, data and assets you have rights to.
- **Submission:** on the Cerebral Valley platform by **Wed Nov 4, 9:00 PM ET**. Include the public repository link, an accessible three-minute demo video, and every team member.
- **Judging:** stage one is pass/fail on theme and Meta model use. Stage two scores Impact (30%), Use of Meta AI tooling (25%), Technical depth (20%) and Demo (25%). Judges also run the live product, so keep it online during judging, Nov 5 to 8.
- **Credits:** each participant claims their own $150 credit by Nov 4, 9:00 PM ET. Set a spend-limit notification on the Billing page.

## Checklist

- [x] Track: Indie Developer, solo
- [ ] Problem statement: Build for Your World
- [ ] Repository is public, with a README that lists what was built during the hackathon
- [ ] Live URL works, and is opened once before judging starts
- [ ] Three-minute demo video is uploaded and its link is accessible
- [ ] Meta credit claimed on the form, and the spend-limit notification is set
- [ ] Submission form filled in, with every team member listed
- [ ] Discord questions asked by Nov 3 (office hours run 10 to 11 AM ET daily)

## Judging rubric, mapped to the product

- **Impact:** sellers on Amazon, Flipkart, Meesho, Shopify and WooCommerce retype the same product details and oversell when stock drifts apart. One photo plus one line of details produces a live listing and one shared stock count.
- **Use of Meta AI tooling:** Muse Spark reads the photo and writes the listing, and it reads Hinglish replies. Planned extensions: Muse Image for studio photos, and Muse Voice Transcribe for WhatsApp voice notes. Say clearly which of these are live in the video.
- **Technical depth:** encrypted seller credentials (AES-256-GCM), an order ledger that can't deduct stock twice, a per-seller MCP endpoint, a guard against seller-supplied addresses that point at private networks, and 23 automated tests.
- **Demo:** the three-minute script below.

## Three-minute video script

| Time | Show | Say |
| --- | --- | --- |
| 0:00 to 0:20 | The demo shop on the stock page | Sellers retype the same details on every marketplace, then oversell when stock drifts apart. |
| 0:20 to 0:50 | Snap a product photo | Muse Spark writes the title, bullets, description and HSN suggestion from the photo. |
| 0:50 to 1:15 | Type "sizes 7 to 10, 15 each, MRP 1499, sell 799" and publish | Sellers answer only what a photo can't show. |
| 1:15 to 1:55 | Shopify connection, then a sale in QuickListInventoryAI, then the Shopify admin | One sale updates the store's stock. |
| 1:55 to 2:25 | WhatsApp: "low stock", then "sold 2 SKU" | Sellers run the shop from WhatsApp. |
| 2:25 to 2:50 | An MCP client calling the inventory tools | An AI agent can adjust stock through the same tools. |
| 2:50 to 3:00 | The Meta models used, and who benefits | Built for small sellers, in one afternoon's build. |

## Shopify test store, for the video

1. Create a free Shopify Partners account, then a development store.
2. In the store admin, go to **Settings → Apps and sales channels → Develop apps**. Create an app with read and write scopes for products and inventory. Install it and copy the Admin API access token. Shopify shows it once.
3. Find the location ID under **Settings → Locations**. It's the number in the location's web address.
4. In the app, go to **Settings → Stores and marketplaces → Shopify**. Enter the store domain (`yourstore.myshopify.com`), the token and the location ID, then save and test. Matching SKUs are linked automatically when the store already has them.
5. To create products in the store, export the Shopify sheet from the Listings page and import it under **Products → Import**. Shopify fetches the photos from the public link, so run this after hosting, with `PUBLIC_BASE_URL` set.

## Be honest in the video

- Show only what works end to end: the photo listing, stock changes, the Shopify push, the WhatsApp commands, and the MCP tools.
- Don't claim Amazon or Flipkart stock sync until it has been tested against a live account. Their request formats are unverified.
- Say that Shopify orders are not yet received by webhook. The video uses the order simulator or a manual sale.
- Say which features are planned, not live.
