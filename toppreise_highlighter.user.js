// ==UserScript==
// @name         Toppreise Preferred Vendor Highlighter
// @namespace    https://github.com/perdrizat/userscripts
// @version      1.0
// @description  Highlights offers from vendors marked with a filled star, dampens others, and hides the redundant "Favorite Shops" list on Toppreise.ch
// @author       Markus Perdrizat
// @license      MIT
// @match        https://www.toppreise.ch/*
// @grant        GM_addStyle
// @run-at       document-end
// ==/UserScript==

(function() {
    'use strict';

    // 1. Define the custom CSS for our highlights and dampening effects
    // Preferred: Green border and subtle background tint
    // Others: Lower opacity and grayscale, but restores on hover for readability
    const customCss = `
        /* Hide the separate "Favorite Shops" list at the top */
        .Plugin_FavoriteShopsOfferList,
        .f_FavoriteShopsOfferList {
            display: none !important;
        }

        .tp-script-preferred {
            background-color: rgba(40, 167, 69, 0.04) !important;
            box-shadow: 0 4px 6px rgba(40, 167, 69, 0.1);
            z-index: 10;
            position: relative; /* Ensure border renders correctly */
        }

        .tp-script-dampened {
            opacity: 0.5;
            filter: grayscale(90%);
            transition: all 0.2s ease-in-out;
        }

        .tp-script-dampened:hover {
            opacity: 1;
            filter: grayscale(0%);
            box-shadow: 0 0 5px rgba(0,0,0,0.1);
        }
    `;

    // Helper to inject CSS
    function addGlobalStyle(css) {
        if (typeof GM_addStyle !== 'undefined') {
            GM_addStyle(css);
        } else {
            const head = document.getElementsByTagName('head')[0];
            if (!head) return;
            const style = document.createElement('style');
            style.type = 'text/css';
            style.innerHTML = css;
            head.appendChild(style);
        }
    }

    addGlobalStyle(customCss);

    // 2. Main logic to find and process offers
    function highlightOffers() {
        // Select all elements matching the offer class provided
        const offers = document.querySelectorAll('.offercontent');

        offers.forEach(offer => {
            // Skip if we've already processed this row to improve performance
            if (offer.classList.contains('tp-script-processed')) return;

            // Check for the filled star icon (Preferred Vendor)
            const isPreferred = offer.querySelector('.TPIcons-filledstar');
            // Check for the empty star icon (Standard Vendor)
            const isStandard = offer.querySelector('.TPIcons-star');

            if (isPreferred) {
                offer.classList.add('tp-script-preferred');
                offer.classList.add('tp-script-processed');
            } else if (isStandard) {
                // We check for isStandard to ensure we don't dim headers or ads
                // that might share the 'offercontent' class but lack a star.
                offer.classList.add('tp-script-dampened');
                offer.classList.add('tp-script-processed');
            }
        });
    }

    // 3. Run initially
    highlightOffers();

    // 4. Set up a MutationObserver to handle dynamic content
    // (e.g. when you change filters, sort order, or load more results)
    const observer = new MutationObserver((mutations) => {
        let shouldUpdate = false;
        for (const mutation of mutations) {
            // If nodes are added (new offers loaded), trigger the highlighter
            if (mutation.addedNodes.length > 0) {
                shouldUpdate = true;
                break;
            }
            // Also trigger if attributes change (rare, but good safety)
            if (mutation.type === 'attributes' && mutation.target.classList.contains('offercontent')) {
                shouldUpdate = true;
                break;
            }
        }

        if (shouldUpdate) {
            highlightOffers();
        }
    });

    // Start observing the document body for changes
    observer.observe(document.body, {
        childList: true,
        subtree: true
    });

})();