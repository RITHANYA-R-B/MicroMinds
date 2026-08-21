/**
 * PriceLens — Popup Script (Final Build)
 */
document.addEventListener('DOMContentLoaded', async () => {
  const selectEl   = document.getElementById('jurisdiction-select');
  const rerunBtn   = document.getElementById('rerun-btn');
  const resHeader  = document.getElementById('result-header');
  const resIcon    = document.getElementById('res-icon');
  const resLabel   = document.getElementById('res-label');
  const resSummary = document.getElementById('res-summary');
  const resFailures = document.getElementById('res-failures');
  const resReasons  = document.getElementById('res-reasons');

  // Status → CSS class map
  const STATUS_CLASS = {
    properly_disclosed: 'properly_disclosed',
    not_conspicuous:    'not_conspicuous',
    not_disclosed:      'not_disclosed'
  };

  // Load saved jurisdiction
  try {
    const data = await chrome.storage.local.get(['selectedJurisdiction', 'lastAuditResult']);
    if (data.selectedJurisdiction) selectEl.value = data.selectedJurisdiction;
    if (data.lastAuditResult)       renderResult(data.lastAuditResult);
  } catch (_) {}

  // Jurisdiction change → save + re-audit
  selectEl.addEventListener('change', async () => {
    await chrome.storage.local.set({ selectedJurisdiction: selectEl.value });
    triggerAudit(selectEl.value);
  });

  // Re-run button
  rerunBtn.addEventListener('click', () => triggerAudit(selectEl.value));

  async function triggerAudit(jurisdictionId) {
    // Show loading state
    setHeader('pending', '⌛', 'Auditing…', 'pending');
    resSummary.textContent = 'Running checks on the active tab…';
    resFailures.style.display = 'none';

    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab) {
      setHeader('pending', '⚠️', 'No Active Tab', 'pending');
      resSummary.textContent = 'No active browser tab detected.';
      return;
    }

    chrome.tabs.sendMessage(tab.id, { type: 'RUN_AUDIT', jurisdictionId }, response => {
      if (chrome.runtime.lastError || !response) {
        setHeader('pending', '⚠️', 'Extension Inactive', 'pending');
        resSummary.textContent = 'PriceLens activates on e-commerce and booking pages. If testing local demo files, ensure "Allow access to file URLs" is ON in chrome://extensions.';
        return;
      }
      if (response.result) renderResult(response.result);
    });
  }

  function renderResult(auditResult) {
    if (!auditResult) return;

    if (auditResult.isCommercePage === false) {
      setHeader('pending', '🛍️', 'Non-Commerce Page', 'pending');
      resSummary.textContent = auditResult.summaryMessage || 'PriceLens activates only on e-commerce, flight, hotel, and ticket booking pages with active prices.';
      resFailures.style.display = 'none';
      resReasons.innerHTML = '';
      return;
    }

    if (!auditResult.classification) return;
    const c = auditResult.classification;
    const cls = STATUS_CLASS[c.status] || 'pending';

    setHeader(cls, c.icon, c.label, cls);
    resSummary.textContent = c.summaryMessage || '';

    if (c.reasons?.length) {
      resFailures.style.display = 'block';
      resReasons.innerHTML = c.reasons.map(r => `<li>${r}</li>`).join('');
    } else {
      resFailures.style.display = 'none';
      resReasons.innerHTML = '';
    }
  }

  function setHeader(headerClass, icon, label, labelClass) {
    resHeader.className = `result-card-header ${headerClass}`;
    resIcon.textContent  = icon;
    resLabel.textContent = label;
    resLabel.className   = `result-label ${labelClass}`;
  }
});
