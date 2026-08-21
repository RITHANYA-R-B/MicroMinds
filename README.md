# PriceLens 🔍💸

**PriceLens** is a browser extension that audits whether price-personalization disclosures on e-commerce web pages are **legally conspicuous** — not just technically present. Built at **OpenHack '26**, Bannari Amman Institute of Technology.

> Many sites *do* disclose that prices are personalized (e.g. tiny grey text buried in a footer), but a disclosure that's technically present yet practically invisible doesn't meet the intent of consumer-protection disclosure law. PriceLens flags the difference.

---

## 🚩 Problem Statement

E-commerce platforms increasingly personalize prices based on browsing history, device, location, and behavior. Several jurisdictions require disclosure of this practice — but disclosure quality varies wildly, from clear banners to compliance-only text nobody will ever read. There was no lightweight, real-time way for a shopper to check *"is this disclosure actually conspicuous, or just technically present?"*

## 💡 Solution

PriceLens runs in the background as you browse. On supported/detected e-commerce pages it:

1. Scans the DOM for personalization-disclosure language.
2. Scores the disclosure's **conspicuousness** — font size, color contrast against background, DOM position/proximity to price elements — rather than mere presence.
3. Checks the finding against a jurisdiction-specific rules dataset.
4. Surfaces a simple three-state badge on the page: **✅ Disclosed / ⚠️ Weakly Disclosed / ❌ Not Disclosed**.

---

## 🏗️ System Architecture

```
┌─────────────────────┐
│   Web Page (DOM)    │
└─────────┬────────────┘
          │
          ▼
┌─────────────────────┐      ┌──────────────────────────┐
│   Content Script     │◄────►│  Background Service Worker │
│  - DOM scan           │      │  - Personalization signal │
│  - Conspicuousness    │      │    check (stripped-context │
│    scoring (font,     │      │    fetch + price compare) │
│    contrast, proximity)│      │  - Jurisdiction lookup     │
└─────────┬────────────┘      └──────────────┬─────────────┘
          │                                    │
          ▼                                    ▼
┌───────────────────────────────────────────────────────┐
│           Jurisdiction Ruleset (JSON)                  │
│   Defines what counts as a valid disclosure per region │
└───────────────────────────────────────────────────────┘
          │
          ▼
┌─────────────────────┐
│   On-page Badge UI    │
│  ✅ / ⚠️ / ❌          │
└─────────────────────┘
```

**Core differentiator:** the conspicuousness-scoring logic in the content script — this is what separates PriceLens from a simple keyword-matching disclosure checker.

---

## 🛠️ Tech Stack

| Layer | Technology |
|---|---|
| Extension platform | Chrome Extension **Manifest V3** |
| Language | Vanilla **JavaScript** (no frameworks) |
| DOM parsing | Native `DOMParser` |
| Browser support | Chrome, Edge (Chromium-based) |
| Ruleset storage | Static **JSON** (jurisdiction rules) |

**No external runtime libraries or paid APIs are used** — the extension ships with zero third-party dependencies, keeping the attack surface and permissions footprint minimal. See [Third-Party Acknowledgements](#-third-party-acknowledgements--attributions) below.

---

## ⚙️ Setup & Installation

### Prerequisites
- Google Chrome or Microsoft Edge (any recent Chromium-based version)
- No build step, no `npm install` required — pure JS, load unpacked

### Steps

1. **Clone the repository**
   ```bash
   git clone https://github.com/<your-username>/pricelens.git
   cd pricelens
   ```

2. **Load the extension in Chrome/Edge**
   - Open `chrome://extensions` (or `edge://extensions`)
   - Enable **Developer mode** (top-right toggle)
   - Click **Load unpacked**
   - Select the `pricelens/` project folder (the one containing `manifest.json`)

3. **Verify it loaded**
   - You should see the PriceLens icon appear in your extensions toolbar
   - Pin it for easy access

4. **Test it**
   - Visit a supported e-commerce site (e.g. Flipkart, Amazon), or
   - Open the included local test page: `test-pages/mock-personalized-price.html`
   - The badge (✅/⚠️/❌) should appear near the price element within a few seconds

### Reloading after changes
Any time you edit source files, go to `chrome://extensions` → click the refresh icon on the PriceLens card → reload the target page.

---

## 🎬 Demo / Usage

1. Navigate to a product page with dynamic/personalized pricing.
2. PriceLens automatically scans the page in the background.
3. A badge appears near the price:
   - **✅ Disclosed** — a clear, conspicuous personalization disclosure was found
   - **⚠️ Weakly Disclosed** — disclosure text exists but fails conspicuousness checks (low contrast, tiny font, far from price)
   - **❌ Not Disclosed** — no personalization disclosure detected at all
4. Click the badge for a breakdown of what was checked (font size, contrast ratio, DOM proximity, jurisdiction rule applied).

---

## 🚀 Roadmap / Scalability

- [ ] Expand jurisdiction ruleset (EU DSA, India CCPA-equivalent provisions, etc.)
- [ ] Machine-readable disclosure score exposed via extension API for researcher/regulator tooling
- [ ] Firefox (WebExtensions) port
- [ ] Crowdsourced site-report database for known personalization patterns
- [ ] Historical price-tracking to strengthen the personalization signal beyond a single stripped-context fetch

---

## 👥 Team

Built by a team of 4 at **OpenHack '26**, Bannari Amman Institute of Technology:

| Role | Responsibility |
|---|---|
| Member A | Content script & disclosure/conspicuousness detection (core differentiator) |
| Member B | Background service worker & personalization signal (stripped-context fetch, price comparison) |
| Member C | Jurisdiction ruleset JSON, badge UI, manifest & wiring |
| Member D | Mock test page, integration testing, demo script & presentation |

---

## 📦 Third-Party Acknowledgements & Attributions

PriceLens is intentionally built with **zero external runtime libraries or paid APIs** to keep the extension lightweight and auditable.

| Dependency | Type | License | Purpose |
|---|---|---|---|
| Chrome Extensions **Manifest V3** platform | Platform API (Google) | N/A — platform spec | Extension runtime/permissions model |
| Native `DOMParser` Web API | Browser-native API | N/A — web standard | HTML/DOM parsing, no external parser library |

*No third-party npm packages, CDN scripts, or paid third-party APIs are bundled or called at runtime. If this changes in future iterations, this table will be updated accordingly.*

---

## 📄 License

This project is licensed under the **MIT License** — see [`LICENSE`](./LICENSE) for details.

---

## 🙏 Acknowledgements

Built during **OpenHack '26** at Bannari Amman Institute of Technology. Thanks to the organizers and mentors for the opportunity and feedback.
