// ==UserScript==
// @name         Heise Newsticker Filter
// @namespace    https://github.com/perdrizat/userscripts
// @version      1.0
// @description  Removes unwanted article types and categories from the Heise newsticker
// @description:de Blendet unerwünschte Artikeltypen und Kategorien im Heise-Newsticker aus
// @author       Markus Perdrizat
// @license      MIT
// @match        https://www.heise.de/newsticker/*
// @grant        GM_getValue
// @grant        GM_setValue
// @run-at       document-end
// ==/UserScript==

(function() {
    'use strict';

    // enabled: true  = show articles of this type (checkbox checked)
    // enabled: false = hide articles of this type (checkbox unchecked)
    const FILTERS = [
        { key: 'ct',           label: "c't Magazin",  enabled: true, test: a => a.classList.contains('a-theme--ct') },
        { key: 'ix',           label: 'iX Magazin',   enabled: true, test: a => a.classList.contains('a-theme--ix') },
        { key: 'macandi',      label: 'Mac & i',      enabled: true, test: a => a.classList.contains('a-theme--macandi') },
        { key: 'make',         label: 'Make',         enabled: true, test: a => a.classList.contains('a-theme--make') },
        { key: 'autos',        label: 'Autos',        enabled: true, test: a => a.classList.contains('a-theme--autos') },
        { key: 'security',     label: 'Security',     enabled: true, test: a => a.classList.contains('a-theme--security') },
        { key: 'developer',    label: 'Developer',    enabled: true, test: a => a.classList.contains('a-theme--developer') },
        { key: 'heisePlus',    label: 'Heise+',       enabled: false, test: a => !!a.querySelector('svg.heise-plus-logo') },
        { key: 'bestlisten',   label: 'bestenlisten', enabled: false, test: a => a.classList.contains('a-theme--bestenlisten') },
        { key: 'heiseAngebot', label: 'heise-Angebot',enabled: false, test: a => hasMeta(a, 'heise-Angebot') },
    ];

    FILTERS.forEach(f => { f.enabled = GM_getValue('hnf_' + f.key, f.enabled); });

    function hasMeta(article, label) {
        for (const el of article.querySelectorAll('.a-article-meta__text--bold')) {
            if (el.textContent.trim() === label) return true;
        }
        return false;
    }

    function shouldRemove(article) {
        return FILTERS.some(f => !f.enabled && f.test(article));
    }

    // Inline style beats any site CSS that might override the [hidden] attribute.
    function setVisibility(article) {
        article.style.display = shouldRemove(article) ? 'none' : '';
    }

    function filterArticles(root) {
        root.querySelectorAll('article.a-article-teaser').forEach(setVisibility);
    }

    filterArticles(document);

    new MutationObserver(mutations => {
        for (const { addedNodes } of mutations) {
            for (const node of addedNodes) {
                if (node.nodeType !== Node.ELEMENT_NODE) continue;
                if (node.matches('article.a-article-teaser')) {
                    setVisibility(node);
                } else {
                    filterArticles(node);
                }
            }
        }
    }).observe(document.body, { childList: true, subtree: true });

    // --- UI ---

    const style = document.createElement('style');
    style.textContent = `
        .hnf-nav-item { position: relative; }
        .hnf-btn {
            background: none;
            border: none;
            cursor: pointer;
            font: inherit;
            color: #c0392b;
            font-weight: bold;
            padding: 0;
        }
        .hnf-btn:hover { text-decoration: underline; }
        .hnf-panel {
            position: absolute;
            top: calc(100% + 6px);
            left: 0;
            background: #fff;
            border: 1px solid #ddd;
            border-radius: 4px;
            box-shadow: 0 2px 8px rgba(0,0,0,0.15);
            padding: 6px 0;
            min-width: 160px;
            z-index: 9999;
        }
        .hnf-label {
            display: flex;
            align-items: center;
            gap: 8px;
            padding: 5px 14px;
            cursor: pointer;
            white-space: nowrap;
            font-size: 0.875em;
            user-select: none;
        }
        .hnf-label:hover { background: #f0f0f0; }
    `;
    document.head.append(style);

    function buildPanel() {
        const archivLink = document.querySelector('a[name="newstickernavi.ho.archiv"]');
        if (!archivLink) return;

        const li = document.createElement('li');
        li.className = 'a-nav__item hnf-nav-item';

        const btn = document.createElement('button');
        btn.className = 'a-nav__link hnf-btn';
        btn.textContent = 'Kategorienfilter';

        const panel = document.createElement('div');
        panel.className = 'hnf-panel';
        panel.hidden = true;

        FILTERS.forEach(f => {
            const label = document.createElement('label');
            label.className = 'hnf-label';

            const cb = document.createElement('input');
            cb.type = 'checkbox';
            cb.checked = f.enabled;
            cb.addEventListener('change', () => {
                f.enabled = cb.checked;
                GM_setValue('hnf_' + f.key, f.enabled);
                filterArticles(document);
            });

            label.append(cb, document.createTextNode(f.label));
            panel.append(label);
        });

        btn.addEventListener('click', e => {
            e.stopPropagation();
            panel.hidden = !panel.hidden;
        });
        document.addEventListener('click', () => { panel.hidden = true; });
        panel.addEventListener('click', e => e.stopPropagation());

        li.append(btn, panel);
        archivLink.closest('li').before(li);
    }

    buildPanel();
})();
