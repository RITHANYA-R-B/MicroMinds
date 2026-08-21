/**
 * PriceLens — Content Script (FINAL PRODUCTION BUILD)
 * ─────────────────────────────────────────────────────
 * Audits price-personalisation disclosures for legal conspicuousness.
 * Activates ONLY on e-commerce, hotel, flight, and ticket booking pages.
 * Supports: NY Algorithmic Pricing Disclosure Act, Maryland, EU DSA,
 *           and a generic global transparency heuristic.
 */

(function () {
  'use strict';

  /* ──────────────────────────────────────────────────────────
     STATE
  ────────────────────────────────────────────────────────── */
  let currentRuleset = null;
  let lastAuditResult = null;
  let personalizationData = null;
  let badgeInjected = false;

  /* ──────────────────────────────────────────────────────────
     DEFAULT / FALLBACK RULESET
  ────────────────────────────────────────────────────────── */
  const DEFAULT_RULESET = {
    id: "generic",
    label: "General Transparency Check",
    disclosurePatterns: [
      "this price (was|is) set (using|by) (an )?algorithm",
      "personalized (pric(ing|e)|discount|offer)",
      "price (was|is) (determined|calculated|set|adjusted) (using|based on) (your )?(personal )?(data|information|history|activity|location|device)",
      "your account (activity|history|status) may affect the price",
      "prices? (may|might) vary based on",
      "dynamic pric(ing|e)",
      "price(s)? (may|might) (change|vary) (depending|based) on",
      "based on your (browsing|location|device|account|demand)"
    ],
    minFontSizePx: 12,
    minContrastRatio: 4.5,
    maxProximityPx: 300
  };

  /* ──────────────────────────────────────────────────────────
     COLOR HELPERS
  ────────────────────────────────────────────────────────── */
  function parseRgbColor(colorStr) {
    if (!colorStr) return [255, 255, 255, 1];
    if (colorStr === 'transparent') return [0, 0, 0, 0];
    const m = colorStr.match(/rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)(?:\s*,\s*([\d.]+))?\s*\)/i);
    if (!m) return [255, 255, 255, 1];
    return [parseInt(m[1]), parseInt(m[2]), parseInt(m[3]), m[4] != null ? parseFloat(m[4]) : 1];
  }

  function linearize(c) {
    c /= 255;
    return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  }

  function luminance(r, g, b) {
    return 0.2126 * linearize(r) + 0.7152 * linearize(g) + 0.0722 * linearize(b);
  }

  function contrastRatio(fg, bg) {
    const l1 = luminance(...fg), l2 = luminance(...bg);
    const hi = Math.max(l1, l2), lo = Math.min(l1, l2);
    return (hi + 0.05) / (lo + 0.05);
  }

  function getEffectiveBg(el) {
    let cur = el;
    while (cur && cur !== document.documentElement) {
      const s = window.getComputedStyle(cur);
      const bg = parseRgbColor(s.backgroundColor);
      if (bg[3] > 0.01) return bg.slice(0, 3);
      cur = cur.parentElement;
    }
    return [255, 255, 255];
  }

  /* ──────────────────────────────────────────────────────────
     STRUCTURED-DATA PRICE (JSON-LD)
     Preferred over DOM scraping — sites put real prices here
  ────────────────────────────────────────────────────────── */
  function findJsonLdPrice() {
    try {
      for (const script of document.querySelectorAll('script[type="application/ld+json"]')) {
        const data = JSON.parse(script.textContent || '{}');
        const nodes = Array.isArray(data) ? data : [data, ...(data['@graph'] || [])];
        for (const node of nodes) {
          const offer = node.offers || node.Offer;
          if (!offer) continue;
          const o = Array.isArray(offer) ? offer[0] : offer;
          const price = o.price || o.lowPrice;
          if (price != null) return String(price).replace(/[^0-9.]/g, '');
        }
      }
    } catch (_) {}
    return null;
  }

  /* ──────────────────────────────────────────────────────────
     STRIKETHROUGH / MRP DETECTION  — skip "was" / old prices
  ────────────────────────────────────────────────────────── */
  function isStruckThrough(el) {
    let cur = el;
    for (let depth = 0; cur && depth < 5; cur = cur.parentElement, depth++) {
      const tag = (cur.tagName || '').toLowerCase();
      if (['del', 's', 'strike'].includes(tag)) return true;
      const td = window.getComputedStyle(cur).textDecorationLine || '';
      if (td.includes('line-through')) return true;
    }
    return false;
  }

  /* ──────────────────────────────────────────────────────────
     COMMERCE & BOOKING PAGE SMART FILTER
     Prevents extension from popping up on ChatGPT, Gmail, Claude, docs, etc.
  ────────────────────────────────────────────────────────── */
  function isExcludedDomain() {
    const host = location.hostname.toLowerCase();
    const excluded = [
      'chatgpt.com', 'claude.ai', 'chat.openai.com',
      'mail.google.com', 'inbox.google.com', 'mail.yahoo.com', 'outlook.live.com', 'outlook.office.com',
      'docs.google.com', 'drive.google.com',
      'github.com', 'gitlab.com', 'bitbucket.org',
      'x.com', 'twitter.com', 'linkedin.com', 'facebook.com', 'instagram.com',
      'reddit.com', 'youtube.com', 'web.whatsapp.com', 'web.telegram.org',
      'notion.so', 'slack.com', 'discord.com', 'zoom.us',
      'stackoverflow.com', 'medium.com', 'wikipedia.org', 'google.com', 'bing.com'
    ];
    return excluded.some(d => host === d || host.endsWith('.' + d));
  }

  function isCommerceOrBookingPage(priceInfo) {
    if (!priceInfo) return false;

    // Always allow local demo pages and localhost testing
    if (location.protocol === 'file:' || location.hostname === 'localhost' || location.hostname === '127.0.0.1') {
      return true;
    }

    // Block on known non-commerce web applications (ChatGPT, Claude, Gmail, etc.)
    if (isExcludedDomain()) return false;

    // Has schema.org JSON-LD price or product/hotel/flight data
    if (findJsonLdPrice() !== null) return true;

    // Has microdata itemprop price/offer/product/hotel
    if (document.querySelector('[itemprop="price"], [itemprop="offers"], [itemtype*="Product"], [itemtype*="Hotel"], [itemtype*="Offer"], [itemtype*="Reservation"], [itemtype*="Flight"]')) {
      return true;
    }

    // Has commerce/booking intent keywords in page title, buttons, or meta
    const pageText = (document.title + ' ' + (document.body ? document.body.innerText.slice(0, 3000) : '')).toLowerCase();
    const commerceKeywords = [
      'add to cart', 'buy now', 'book now', 'check out', 'checkout', 'reserve',
      'order now', 'select seat', 'select room', 'book flight', 'flight', 'hotel',
      'room rate', 'per night', 'ticket', 'fare', 'pricing', 'cart', 'in stock', 'mrp', 'delivery'
    ];
    const hasCommerceIntent = commerceKeywords.some(kw => pageText.includes(kw));

    if (priceInfo.score >= 25 || hasCommerceIntent) {
      return true;
    }

    return false;
  }

  /* ──────────────────────────────────────────────────────────
     a) findPriceElement()
     Scores candidates: JSON-LD match > itemprop > class hint > font size
  ────────────────────────────────────────────────────────── */
  function findPriceElement() {
    const PRICE_RE = /(\$|USD|₹|INR|Rs\.?|€|EUR|£|GBP)\s?\d[\d,]*(\.\d{1,2})?/i;
    const ATTR_HINT = /price|amount|cost|offer/i;
    const jsonLdPrice = findJsonLdPrice();
    const candidates = [];

    const walker = document.createTreeWalker(
      document.body || document.documentElement,
      NodeFilter.SHOW_ELEMENT,
      {
        acceptNode(node) {
          if (node.closest && node.closest('#pricelens-root')) return NodeFilter.FILTER_REJECT;
          const tag = (node.tagName || '').toLowerCase();
          if (['script','style','noscript','svg','img','iframe','template'].includes(tag)) return NodeFilter.FILTER_REJECT;
          return NodeFilter.FILTER_ACCEPT;
        }
      }
    );

    let node;
    while ((node = walker.nextNode())) {
      const cs = window.getComputedStyle(node);
      if (cs.display === 'none' || cs.visibility === 'hidden' || cs.opacity === '0') continue;
      if (isStruckThrough(node)) continue;

      const directText = [...node.childNodes]
        .filter(n => n.nodeType === Node.TEXT_NODE)
        .map(n => n.textContent).join(' ').trim();
      const text = directText || node.textContent.trim();
      if (!PRICE_RE.test(text)) continue;

      const rect = node.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) continue;

      const matchStr = (text.match(PRICE_RE) || [])[0] || '';
      const digits = matchStr.replace(/[^0-9.]/g, '');
      const fontSize = parseFloat(cs.fontSize) || 0;

      let score = fontSize;
      const idClass = `${node.id || ''} ${node.className || ''}`;
      if (ATTR_HINT.test(idClass)) score += 20;
      if (node.getAttribute && node.getAttribute('itemprop') === 'price') score += 30;
      if (jsonLdPrice && digits.replace(/^0+/, '') === jsonLdPrice.replace(/^0+/, '')) score += 50;

      candidates.push({ element: node, fontSize, rect, text: matchStr, score });
    }

    if (!candidates.length) return null;
    candidates.sort((a, b) => b.score - a.score);
    return candidates[0];
  }

  /* ──────────────────────────────────────────────────────────
     b) scanForDisclosure(ruleset)
     Walk visible TEXT nodes and test against each pattern regex
  ────────────────────────────────────────────────────────── */
  function scanForDisclosure(ruleset) {
    const patterns = ruleset?.disclosurePatterns || DEFAULT_RULESET.disclosurePatterns;
    const regexes = patterns.map(p => new RegExp(p, 'i'));

    const walker = document.createTreeWalker(
      document.body || document.documentElement,
      NodeFilter.SHOW_TEXT,
      {
        acceptNode(node) {
          const parent = node.parentElement;
          if (!parent) return NodeFilter.FILTER_REJECT;
          if (parent.closest && parent.closest('#pricelens-root')) return NodeFilter.FILTER_REJECT;
          const tag = (parent.tagName || '').toLowerCase();
          if (['script','style','noscript','template'].includes(tag)) return NodeFilter.FILTER_REJECT;
          return NodeFilter.FILTER_ACCEPT;
        }
      }
    );

    let textNode;
    while ((textNode = walker.nextNode())) {
      const text = textNode.textContent.trim();
      const parentText = (textNode.parentElement && textNode.parentElement.textContent.length < 500)
        ? textNode.parentElement.textContent.trim()
        : text;

      if (!text && !parentText) continue;

      for (let i = 0; i < regexes.length; i++) {
        if (regexes[i].test(text) || regexes[i].test(parentText)) {
          return {
            element: textNode.parentElement,
            matchedPattern: patterns[i],
            matchedText: text || parentText
          };
        }
      }
    }
    return null;
  }

  /* ──────────────────────────────────────────────────────────
     c) evaluateConspicuousness()
     Compute font size, WCAG contrast, Euclidean proximity,
     and hidden-behind-interaction flag.
  ────────────────────────────────────────────────────────── */
  function evaluateConspicuousness(disclosureEl, priceInfo, ruleset) {
    if (!disclosureEl) return null;

    const cs = window.getComputedStyle(disclosureEl);
    const fontSize = parseFloat(cs.fontSize) || 0;

    const fg = parseRgbColor(cs.color).slice(0, 3);
    const bg = getEffectiveBg(disclosureEl);
    const cr = contrastRatio(fg, bg);

    let proximityPx = Infinity;
    if (priceInfo?.rect) {
      const dr = disclosureEl.getBoundingClientRect();
      if (dr.width > 0 && dr.height > 0) {
        const dc = { x: dr.left + dr.width / 2,  y: dr.top + dr.height / 2 };
        const pc = { x: priceInfo.rect.left + priceInfo.rect.width / 2, y: priceInfo.rect.top + priceInfo.rect.height / 2 };
        proximityPx = Math.hypot(dc.x - pc.x, dc.y - pc.y);
      }
    }

    // Scroll-adjusted absolute distance (catches sticky-above vs footer-below patterns)
    let proximityPxAbsolute = Infinity;
    if (priceInfo?.element) {
      const dRect  = disclosureEl.getBoundingClientRect();
      if (dRect.width > 0 && dRect.height > 0) {
        const pRect  = priceInfo.rect;
        const scrollY = window.scrollY || 0;
        const dTop  = dRect.top + scrollY;
        const pTop  = pRect.top + scrollY;
        proximityPxAbsolute = Math.abs(dTop - pTop);
      }
    }

    let hiddenBehindInteraction = false;
    let cur = disclosureEl;
    while (cur && cur !== document.body) {
      const tag = (cur.tagName || '').toLowerCase();
      const ccs = window.getComputedStyle(cur);
      
      if (ccs.display === 'none' || ccs.visibility === 'hidden' || ccs.opacity === '0') {
        hiddenBehindInteraction = true;
        break;
      }
      if (tag === 'details' && !cur.open) { hiddenBehindInteraction = true; break; }
      if (tag === 'dialog' && !cur.open) { hiddenBehindInteraction = true; break; }
      if (cur.getAttribute?.('aria-expanded') === 'false') { hiddenBehindInteraction = true; break; }
      if (cur.getAttribute?.('aria-hidden') === 'true') { hiddenBehindInteraction = true; break; }
      if (cur.getAttribute?.('role') === 'dialog' || cur.getAttribute?.('aria-modal') === 'true' || cur.classList?.contains('modal') || cur.classList?.contains('drawer')) {
        hiddenBehindInteraction = true;
      }
      const mh = parseFloat(ccs.maxHeight);
      if ((ccs.overflow === 'hidden' || ccs.overflowY === 'hidden') && !isNaN(mh) && mh < 10) {
        hiddenBehindInteraction = true; break;
      }
      cur = cur.parentElement;
    }

    return {
      fontSize,
      contrastRatio: cr,
      proximityPx: Math.min(proximityPx, proximityPxAbsolute),
      hiddenBehindInteraction,
      fg, bg
    };
  }

  /* ──────────────────────────────────────────────────────────
     d) classify()
  ────────────────────────────────────────────────────────── */
  function classify(disclosureFound, metrics, ruleset) {
    const rules = ruleset || DEFAULT_RULESET;

    if (!disclosureFound) {
      return {
        status: "not_disclosed",
        label: "Not Disclosed",
        icon: "❌",
        colorClass: "status-not_disclosed",
        heroClass: "status-hero-not_disclosed",
        heroLabelClass: "hero-label-not_disclosed",
        summaryMessage: rules.id === 'generic'
          ? "Price may be personalized — no explanation given."
          : "No legally required price-personalization disclosure found.",
        reasons: ["No disclosure matching algorithmic or personalized pricing patterns was detected on this page."]
      };
    }

    const fontOk   = metrics.fontSize       >= rules.minFontSizePx;
    const contOk   = metrics.contrastRatio  >= rules.minContrastRatio;
    const proxOk   = metrics.proximityPx    <= rules.maxProximityPx;
    const visOk    = !metrics.hiddenBehindInteraction;

    if (fontOk && contOk && proxOk && visOk) {
      return {
        status: "properly_disclosed",
        label: "Properly Disclosed",
        icon: "✅",
        colorClass: "status-properly_disclosed",
        heroClass: "status-hero-properly_disclosed",
        heroLabelClass: "hero-label-properly_disclosed",
        summaryMessage: "Disclosure meets legal conspicuousness standards.",
        reasons: [],
        metrics
      };
    }

    const reasons = [];
    if (!fontOk)  reasons.push(`Font size ${metrics.fontSize.toFixed(1)}px is below the ${rules.minFontSizePx}px minimum.`);
    if (!contOk)  reasons.push(`Contrast ratio ${metrics.contrastRatio.toFixed(2)}:1 is below the ${rules.minContrastRatio}:1 WCAG minimum.`);
    if (!proxOk)  reasons.push(`Disclosure is ${Math.round(metrics.proximityPx)}px from the price (limit: ${rules.maxProximityPx}px).`);
    if (!visOk)   reasons.push("Disclosure is hidden inside a collapsed element, accordion, or tooltip.");

    return {
      status: "not_conspicuous",
      label: "Present, Not Conspicuous",
      icon: "⚠️",
      colorClass: "status-not_conspicuous",
      heroClass: "status-hero-not_conspicuous",
      heroLabelClass: "hero-label-not_conspicuous",
      summaryMessage: "Disclosure exists but fails legal visibility requirements.",
      reasons,
      metrics
    };
  }

  /* ──────────────────────────────────────────────────────────
     e) injectBadge()
  ────────────────────────────────────────────────────────── */
  function injectBadge(classification, ruleset, priceInfo) {
    // Inject CSS link once
    if (!badgeInjected) {
      const link = document.createElement('link');
      link.rel = 'stylesheet';
      link.href = chrome.runtime.getURL('badge.css');
      document.head.appendChild(link);
      badgeInjected = true;
    }

    let container = document.getElementById('pricelens-root');
    if (!container) {
      container = document.createElement('div');
      container.id = 'pricelens-root';
      document.body.appendChild(container);
    }

    const rules = ruleset || DEFAULT_RULESET;
    const isGeneric = rules.id === 'generic';

    // Build reasons HTML
    const reasonsHtml = classification.reasons?.length
      ? `<div class="pricelens-section-title">Compliance Failures</div>
         <ul class="pricelens-reasons-list">${classification.reasons.map(r => `<li>${r}</li>`).join('')}</ul>`
      : `<div style="font-size:12px;color:#059669;background:#f0fdf4;padding:10px 12px;border-radius:8px;border:1px solid #bbf7d0;">
           ✓ All conspicuousness checks passed.
         </div>`;

    // Build metrics table
    let metricsHtml = '';
    if (classification.metrics) {
      const m = classification.metrics;
      const fPass = m.fontSize       >= rules.minFontSizePx;
      const cPass = m.contrastRatio  >= rules.minContrastRatio;
      const pPass = m.proximityPx    <= rules.maxProximityPx;
      const vPass = !m.hiddenBehindInteraction;

      metricsHtml = `
        <div class="pricelens-section-title">Audit Metrics</div>
        <table class="pricelens-metrics-table">
          <tr>
            <td>Font Size</td>
            <td class="${fPass ? 'pricelens-pass-cell' : 'pricelens-fail-cell'}">${m.fontSize.toFixed(1)}px / min ${rules.minFontSizePx}px</td>
          </tr>
          <tr>
            <td>Contrast Ratio</td>
            <td class="${cPass ? 'pricelens-pass-cell' : 'pricelens-fail-cell'}">${m.contrastRatio.toFixed(2)}:1 / min ${rules.minContrastRatio}:1</td>
          </tr>
          <tr>
            <td>Proximity to Price</td>
            <td class="${pPass ? 'pricelens-pass-cell' : 'pricelens-fail-cell'}">${Math.round(m.proximityPx)}px / max ${rules.maxProximityPx}px</td>
          </tr>
          <tr>
            <td>Visibility</td>
            <td class="${vPass ? 'pricelens-pass-cell' : 'pricelens-fail-cell'}">${vPass ? '✓ Visible' : '✗ Collapsed / Hidden'}</td>
          </tr>
        </table>`;
    }

    const lawTitle = isGeneric
      ? '🌐 General Transparency Check'
      : `⚖️ ${rules.label}`;

    container.innerHTML = `
      <!-- Badge Pill (always visible) -->
      <div class="pricelens-badge-pill ${classification.colorClass}" id="pricelens-pill-btn">
        <span class="pricelens-pill-icon">${classification.icon}</span>
        <span class="pricelens-pill-title">${classification.label}</span>
      </div>

      <!-- Expandable Popover Panel -->
      <div class="pricelens-popover" id="pricelens-popover-panel">

        <!-- Sticky Header -->
        <div class="pricelens-popover-header">
          <div class="pricelens-popover-brand">
            <div class="pricelens-brand-logo">🔍</div>
            <div class="pricelens-brand-name">PriceLens</div>
          </div>
          <button class="pricelens-close-btn" id="pricelens-close-btn" aria-label="Close">&times;</button>
        </div>

        <!-- Body -->
        <div class="pricelens-popover-body">

          <!-- Status Hero -->
          <div class="pricelens-status-hero ${classification.heroClass}">
            <span class="pricelens-hero-icon">${classification.icon}</span>
            <div>
              <div class="pricelens-hero-label ${classification.heroLabelClass}">${classification.label}</div>
              <div class="pricelens-hero-sub">${classification.summaryMessage}</div>
            </div>
          </div>

          <!-- Law Tag -->
          <div class="pricelens-law-tag">${lawTitle}</div>

          <!-- Compliance Failures / Pass -->
          ${reasonsHtml}

          <!-- Metrics Table -->
          ${metricsHtml}

          <!-- Server Personalization Check -->
          <div class="pricelens-section-title">Server Price Verification</div>
          <div class="pricelens-personalization-box">
            <div class="pricelens-perso-title">🌐 Unauthenticated HTML Check</div>
            <div class="pricelens-perso-msg" id="pricelens-personalization-msg">
              Fetching logged-out page price...
            </div>
          </div>

          <!-- Footer -->
          <div class="pricelens-footer">🔍 PriceLens · Price Transparency Auditor · v1.0</div>
        </div>
      </div>`;

    // Event listeners
    document.getElementById('pricelens-pill-btn').addEventListener('click', e => {
      e.stopPropagation();
      document.getElementById('pricelens-popover-panel').classList.toggle('open');
    });

    document.getElementById('pricelens-close-btn').addEventListener('click', e => {
      e.stopPropagation();
      document.getElementById('pricelens-popover-panel').classList.remove('open');
    });

    document.addEventListener('click', e => {
      if (!container.contains(e.target)) {
        document.getElementById('pricelens-popover-panel')?.classList.remove('open');
      }
    }, { once: false });

    // If personalization data already came back, apply it
    if (personalizationData) updatePersonalizationUI(personalizationData);
  }

  /* ──────────────────────────────────────────────────────────
     Personalization UI Updater
  ────────────────────────────────────────────────────────── */
  function updatePersonalizationUI(data) {
    const el = document.getElementById('pricelens-personalization-msg');
    if (!el) return;
    if (!data.ok) {
      el.textContent = `Fetch blocked: ${data.error || 'CORS / bot protection'}`;
      return;
    }
    if (data.strippedPrices?.length) {
      el.innerHTML = `Server HTML prices found:<div class="pricelens-prices-list">${data.strippedPrices.map(p => `<span class="pricelens-price-tag">${p}</span>`).join('')}</div>`;
    } else {
      el.textContent = 'No prices found in unauthenticated server HTML.';
    }
  }

  /* ──────────────────────────────────────────────────────────
     MAIN AUDIT ORCHESTRATOR
  ────────────────────────────────────────────────────────── */
  async function runAudit(overrideJurisdictionId) {
    // 1. Find price candidate
    const priceInfo = findPriceElement();

    // 2. Check if this is an actual commerce / booking / hotel / ticket page
    const isCommerce = isCommerceOrBookingPage(priceInfo);

    if (!isCommerce) {
      // Remove badge from screen on non-commerce pages (e.g. ChatGPT, Claude, Gmail, Docs)
      const existingBadge = document.getElementById('pricelens-root');
      if (existingBadge) {
        existingBadge.remove();
      }

      lastAuditResult = {
        isCommercePage: false,
        summaryMessage: "No active e-commerce, flight, hotel, or booking price detected on this page.",
        timestamp: Date.now()
      };

      try { await chrome.storage.local.set({ lastAuditResult }); } catch (_) {}
      return;
    }

    // Load rulesets.json
    let rulesets = [DEFAULT_RULESET];
    try {
      const res = await fetch(chrome.runtime.getURL('rulesets.json'));
      if (res.ok) rulesets = await res.json();
    } catch (_) {}

    // Jurisdiction selection
    let targetId = overrideJurisdictionId;
    if (!targetId) {
      try {
        const s = await chrome.storage.local.get(['selectedJurisdiction']);
        targetId = s.selectedJurisdiction || 'ny';
      } catch (_) { targetId = 'ny'; }
    }

    currentRuleset = rulesets.find(r => r.id === targetId) || rulesets[0] || DEFAULT_RULESET;

    // Run pipeline
    const disclosureMatch = scanForDisclosure(currentRuleset);
    const metrics         = disclosureMatch ? evaluateConspicuousness(disclosureMatch.element, priceInfo, currentRuleset) : null;
    const classification  = classify(!!disclosureMatch, metrics, currentRuleset);

    lastAuditResult = {
      isCommercePage: true,
      classification,
      ruleset: currentRuleset,
      priceInfo,
      disclosureMatch,
      timestamp: Date.now()
    };

    try { await chrome.storage.local.set({ lastAuditResult }); } catch (_) {}

    injectBadge(classification, currentRuleset, priceInfo);

    // Background personalization check (async, non-blocking)
    try {
      const pageCurrency = priceInfo?.text ? (priceInfo.text.match(/₹|Rs\.?|INR|\$|USD|€|EUR|£|GBP/i) || [])[0] : '';
      chrome.runtime.sendMessage({
        type: "CHECK_PERSONALIZATION",
        url: location.href,
        currency: pageCurrency
      }, res => {
        if (chrome.runtime.lastError) {
          personalizationData = { ok: false, error: chrome.runtime.lastError.message };
        } else {
          personalizationData = res || { ok: false, error: 'No response' };
        }
        updatePersonalizationUI(personalizationData);
      });
    } catch (_) {}
  }

  /* ──────────────────────────────────────────────────────────
     MESSAGE LISTENER  (from popup)
  ────────────────────────────────────────────────────────── */
  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg.type === 'RUN_AUDIT') {
      runAudit(msg.jurisdictionId).then(() => sendResponse({ ok: true, result: lastAuditResult }));
      return true;
    }
    if (msg.type === 'GET_AUDIT_STATUS') {
      sendResponse({ ok: true, result: lastAuditResult });
    }
  });

  /* ──────────────────────────────────────────────────────────
     BOOT
  ────────────────────────────────────────────────────────── */
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => runAudit());
  } else {
    runAudit();
  }

  // SPA / dynamic navigation & drawer opening support
  let lastUrl = location.href;
  new MutationObserver(() => {
    if (location.href !== lastUrl) {
      lastUrl = location.href;
      setTimeout(runAudit, 1000);
    }
  }).observe(document.body || document.documentElement, { childList: true, subtree: true });

  // Re-run audit when user clicks modals, accordions, or drawer triggers (like "Pricing details")
  let clickTimeout;
  document.addEventListener('click', e => {
    if (e.target.closest && e.target.closest('#pricelens-root')) return;
    clearTimeout(clickTimeout);
    clickTimeout = setTimeout(runAudit, 500);
  });
})();
