/**
 * PriceLens — Background Service Worker
 * Handles background server fetch for price personalization checks.
 *
 * Cleans scripts and styles before extracting clean prices to avoid
 * picking up minified JavaScript variables or jQuery tokens.
 */

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === "CHECK_PERSONALIZATION") {
    fetch(msg.url, { credentials: "omit", cache: "no-store" })
      .then(r => {
        if (!r.ok) {
          throw new Error(`HTTP ${r.status} ${r.statusText}`);
        }
        return r.text();
      })
      .then(html => {
        const foundPrices = [];

        // 1. Try to extract JSON-LD prices first (most accurate structured data)
        try {
          const jsonLdMatches = html.match(/<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi) || [];
          for (const s of jsonLdMatches) {
            const inner = s.replace(/<script[^>]*>|<\/script>/gi, '').trim();
            const data = JSON.parse(inner);
            const nodes = Array.isArray(data) ? data : [data, ...(data['@graph'] || [])];
            for (const it of nodes) {
              const offer = it.offers || it.Offer;
              if (offer) {
                const o = Array.isArray(offer) ? offer[0] : offer;
                const p = o.price || o.lowPrice;
                const cur = o.priceCurrency || '';
                if (p != null) {
                  const sym = cur === 'INR' ? '₹' : (cur === 'USD' ? '$' : (cur === 'EUR' ? '€' : (cur === 'GBP' ? '£' : '₹')));
                  foundPrices.push(`${sym}${p}`);
                }
              }
            }
          }
        } catch (_) {}

        // 2. Clean HTML: strip scripts (except jsonld), styles, and svgs to remove JS variables like $9
        const cleanHtml = html
          .replace(/<script(?![^>]*application\/ld\+json)[\s\S]*?<\/script>/gi, ' ')
          .replace(/<style[\s\S]*?<\/style>/gi, ' ')
          .replace(/<svg[\s\S]*?<\/svg>/gi, ' ')
          .replace(/<[^>]+>/g, ' ');

        // 3. Match valid formatted price strings
        const priceRegex = /(?:₹|Rs\.?|INR|\$|USD|€|EUR|£|GBP)\s?[0-9]{1,3}(?:,[0-9]{2,3})*(?:\.[0-9]{2})?(?![a-zA-Z0-9_.])/g;
        const matches = cleanHtml.match(priceRegex) || [];

        for (const m of matches) {
          const trimmed = m.trim();
          const numPart = trimmed.replace(/[^0-9.]/g, '');
          // Ignore single digit numbers or invalid JS fragments like $9.
          if (numPart && parseFloat(numPart) >= 10 && !trimmed.endsWith('.')) {
            if (!foundPrices.includes(trimmed)) {
              foundPrices.push(trimmed);
            }
          }
        }

        // 4. Filter by page currency if specified
        let finalPrices = foundPrices;
        if (msg.currency) {
          const currFiltered = foundPrices.filter(p => p.includes(msg.currency));
          if (currFiltered.length > 0) {
            finalPrices = currFiltered;
          }
        }

        sendResponse({ ok: true, strippedPrices: finalPrices.slice(0, 4) });
      })
      .catch(err => {
        sendResponse({ ok: false, error: String(err) });
      });
    return true; // async response
  }
});
