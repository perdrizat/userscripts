// ==UserScript==
// @name         Mastodon Remote Follow Bridge
// @namespace    https://github.com/perdrizat/userscripts
// @version      0.7
// @description  On any Mastodon instance, reworks the follow buttons in follower/following lists and profile pages to act on YOUR home instance: shows whether you already follow them and lets you follow/unfollow with one click. Optional filter for recently active accounts, throttled requests.
// @author       Markus Perdrizat
// @license      MIT
// @match        *://*/*
// @grant        GM_xmlhttpRequest
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_registerMenuCommand
// @connect      *
// @run-at       document-end
// ==/UserScript==

// WHAT IT DOES
// When you browse someone's follower or following list on a foreign instance
// (or their profile page), the existing Follow button of each account is
// taken over and driven by your HOME instance instead of the one you are
// looking at. The home instance name is appended in parentheses so you can
// see at a glance that the bridge is active:
//   Follow (home.example)     – you don't follow them yet (click to follow)
//   Following (home.example)  – you already follow them (click to unfollow)
//   Requested (home.example)  – they approve followers, request is pending
//   ✖ (home.example)          – account could not be resolved on your home
//   ⚠ (home.example)          – token rejected / home instance unreachable
//   ⏳ (home.example)         – home instance is rate-limiting; requests are
//                              throttled and retried automatically
// On your home instance itself (while logged in) the native buttons already
// do the right thing, so they are left untouched there.
//
// SETUP (automatic)
// While logged in to your home instance, the script detects the session token
// and offers to store it (a confirm dialog on first visit). Nothing else to do.
//
// SETUP (manual, via Tampermonkey menu → "Set home instance / token…")
// 1. Home instance URL, e.g. https://mastodon.social
// 2. Access token: on your home instance go to Preferences → Development →
//    New Application, name it e.g. "Userscript", tick the scopes "read",
//    "write" and "follow", submit, then copy the "Your access token" value.
//
// ACTIVITY FILTER
// The "⚙ Filter" entry sits at the top of the left sidebar navigation. It
// works with the classic UI (Mastodon 4.x, nav.navigation-panel) and the
// redesigned UI (CSS-module classes, found via its About/Explore/Home links),
// logged in or out; if no sidebar exists (e.g. multi-column layout) the entry
// falls back to the top-left page corner after a few seconds. It opens a
// panel with the option "Only active accounts (posted in the last month)",
// enabled by default (the choice is stored per script update).
// Activity is read straight from the page: the profile UI renders a
// "Last active <date>" row in each follower/following entry, so no API call
// is needed. Entries older than one month (or that never posted) are hidden
// BEFORE their button is touched — no relabel, no API calls. Only if the row
// is missing does the script fall back to the viewed instance's public
// statuses API, and only active entries get a follow-status lookup on your
// home instance.
//
// THROTTLING / RATE LIMITS
// All API requests go through a queue limited to roughly one request per
// second. Follow states are fetched in batches (the relationships endpoint
// accepts up to 40 ids per call), so each entry costs just one lookup request
// and buttons start converting within a couple of seconds. If the home (or
// viewed) instance answers with HTTP 429, the script honors Retry-After /
// X-RateLimit-Reset, pauses the queue and reports the condition on the
// affected buttons instead of guessing at the token.
//
// NOTES
// - The first cross-origin request to your home instance makes Tampermonkey
//   show an "a userscript wants to access a cross-origin resource" dialog.
//   Check that the target is your home instance, then choose "Always allow".
// - A remote account's follower list only contains followers that the viewed
//   instance knows about; this is a Mastodon federation limitation, not a
//   script bug.
// - /api/v1/accounts/lookup is stricter than the web search: accounts it
//   cannot resolve are retried via /api/v2/search, so "✖ not found" should
//   stay rare. An unfollow that comes back 404 re-checks the follow state
//   instead of failing silently.
// - The script runs on every website but exits immediately unless the page is
//   a Mastodon web app (detected via its #initial-state element).
(function () {
    'use strict';

    const initialState = document.getElementById('initial-state');
    if (!initialState) return; // not a Mastodon web page

    // ---------------------------------------------------------------- config

    let meta = {};
    try {
        meta = JSON.parse(initialState.textContent).meta || {};
    } catch (e) { /* public page without usable meta */ }

    if (meta.access_token) {
        const storedHome = GM_getValue('home_url', '');
        if (!storedHome) {
            if (window.confirm('Mastodon Remote Follow: use ' + location.origin +
                ' as your home instance?')) {
                GM_setValue('home_url', location.origin);
                GM_setValue('token', meta.access_token);
            }
        } else if (storedHome === location.origin) {
            // keep the stored token fresh (sessions can be re-issued)
            GM_setValue('token', meta.access_token);
        }
    }

    const settings = { only_active: GM_getValue('mrf_only_active', true) };

    function configure() {
        const url = prompt('Home Mastodon instance URL (e.g. https://mastodon.social)',
            GM_getValue('home_url', 'https://'));
        if (url === null) return;
        const token = prompt('Access token (Preferences → Development → New Application;\nscopes: read, write, follow)',
            GM_getValue('token', ''));
        if (token === null) return;
        GM_setValue('home_url', url.replace(/\/+$/, ''));
        GM_setValue('token', token.trim());
    }

    GM_registerMenuCommand('Set home instance / token…', configure);

    GM_registerMenuCommand('Diagnostics…', () => {
        const nav = findSidebar();
        const list = nav ? nav.querySelector('ul') : null;
        const rows = Array.from(document.querySelectorAll('li'))
            .filter((li) => LAST_ACTIVE_RE.test((li.textContent || '').trim())).length;
        alert([
            'Page: ' + location.pathname,
            'Home instance: ' + (homeUrl() || 'not configured'),
            'Access token: ' + (GM_getValue('token', '') ? 'set' : 'missing'),
            'Filter entry: ' + (!uiBuilt ? 'not built yet'
                : uiInNav ? 'in sidebar' : 'fallback (top-left)') +
                (uiWrap && uiWrap.isConnected ? '' : ' — NOT in the document!'),
            'Sidebar: ' + (nav ? 'found, ' + nav.querySelectorAll('a').length + ' links' : 'NOT found'),
            'Sidebar list: ' + (list ? 'found' : 'NOT found'),
            '"Last active" rows on page: ' + rows,
        ].join('\n'));
    });

    const homeUrl = () => GM_getValue('home_url', '');
    const homeHost = () => homeUrl().replace(/^https?:\/\//, '');
    const nativeHere = () => homeUrl() === location.origin && !!meta.access_token;

    // Accounts are considered "active" if their latest post is newer than
    // this timestamp (rolling one-month window, evaluated per page load).
    const CUTOFF = (() => {
        const d = new Date();
        d.setMonth(d.getMonth() - 1);
        return d.getTime();
    })();

    // ------------------------------------------------- throttled request queue

    const MIN_INTERVAL = 1000;  // ms between API requests (~300 req / 5 min)
    const queue = [];
    let pumping = false;
    let lastRequest = 0;
    let coolingUntil = 0;
    let cooldownAnnounced = false;

    function pump() {
        if (pumping) return;
        pumping = true;
        const step = () => {
            if (!queue.length) { pumping = false; return; }
            const wait = Math.max(coolingUntil, lastRequest + MIN_INTERVAL) - Date.now();
            if (wait > 0) { setTimeout(step, wait); return; }
            lastRequest = Date.now();
            queue.shift()();
            setTimeout(step, 0);
        };
        step();
    }

    function headerValue(r, name) {
        const m = r.responseHeaders.match(new RegExp('^' + name + ':\\s*(.*)$', 'im'));
        return m ? m[1].trim() : null;
    }

    // ---------------------------------------------------------------- helpers

    function showToast(msg, isError) {
        const toast = document.createElement('div');
        toast.textContent = msg;
        toast.style.cssText = [
            'position: fixed',
            'top: 16px',
            'right: 16px',
            'z-index: 99999',
            'padding: 10px 16px',
            'border-radius: 6px',
            'color: white',
            'font: 14px sans-serif',
            'box-shadow: 0 2px 8px rgba(0,0,0,0.3)',
            'background-color: ' + (isError ? '#d32f2f' : '#563acc')
        ].join(';');
        document.body.appendChild(toast);
        setTimeout(() => toast.remove(), isError ? 6000 : 3000);
    }

    // Rate-limited GM_xmlhttpRequest wrapper: cb(data, status). data is null
    // on 404, undefined on other errors / unparsable bodies. All requests are
    // serialized through the queue above; 429 responses pause it globally.
    function apiCall(method, base, path, token, cb) {
        queue.push(() => {
            const headers = { 'Accept': 'application/json' };
            if (token) headers.Authorization = 'Bearer ' + token;
            GM_xmlhttpRequest({
                method,
                url: base + path,
                headers,
                onload: (r) => {
                    let data;
                    try { data = JSON.parse(r.responseText); } catch (e) { data = undefined; }
                    if (r.status === 404) data = null;
                    else if (r.status < 200 || r.status >= 300) data = undefined;
                    if (r.status === 429) {
                        let wait = 30000;
                        const ra = headerValue(r, 'Retry-After');
                        if (ra && /^\d+$/.test(ra)) {
                            wait = parseInt(ra, 10) * 1000;
                        } else {
                            const reset = headerValue(r, 'X-RateLimit-Reset');
                            if (reset) {
                                const t = Date.parse(reset);
                                if (!isNaN(t)) wait = Math.max(1000, t - Date.now());
                            }
                        }
                        coolingUntil = Math.max(coolingUntil, Date.now() + wait);
                        if (!cooldownAnnounced) {
                            cooldownAnnounced = true;
                            showToast('Rate-limited by ' + base.replace(/^https?:\/\//, '') +
                                ' — pausing requests for ' + Math.round(wait / 1000) + 's', true);
                            setTimeout(() => { cooldownAnnounced = false; }, wait);
                        }
                    }
                    cb(data, r.status);
                },
                onerror: () => cb(undefined, 0)
            });
        });
        pump();
    }

    // API of the home instance (authenticated).
    const homeApi = (method, path, cb) =>
        apiCall(method, homeUrl(), path, GM_getValue('token', ''), cb);
    // API of the instance being browsed (public endpoints only).
    const localApi = (method, path, cb) =>
        apiCall(method, location.origin, path, null, cb);

    // Follow states are fetched in batches: /api/v1/accounts/relationships
    // accepts up to 40 ids per call, so the per-entry cost shrinks to the
    // single lookup request and the buttons convert much faster.
    const relBatches = [];
    let relFlushTimer = null;

    function queueRelationships(id, cb) {
        let batch = relBatches.find((b) => b.length < 40);
        if (!batch) { batch = []; relBatches.push(batch); }
        batch.push({ id, cb });
        if (!relFlushTimer) {
            relFlushTimer = setTimeout(flushRelationships, 1000);
        } else if (relBatches.reduce((n, b) => n + b.length, 0) >= 40) {
            clearTimeout(relFlushTimer);
            relFlushTimer = null;
            flushRelationships();
        }
    }

    function flushRelationships() {
        relFlushTimer = null;
        const batch = relBatches.shift();
        if (batch && batch.length) {
            const q = batch.map((e) => 'id[]=' + e.id).join('&');
            homeApi('GET', '/api/v1/accounts/relationships?' + q, (rel) => {
                const byId = new Map((rel || []).map((r) => [r.id, r]));
                for (const e of batch) e.cb(byId.get(e.id) || null);
            });
        }
        if (relBatches.length) relFlushTimer = setTimeout(flushRelationships, 1000);
    }

    // Resolve an account on the home instance. /api/v1/accounts/lookup is
    // stricter than the web search (it 404s for many remote accounts that
    // search and manual profile entry find), so a 404 falls back to the
    // search API with an exact handle match.
    function findHomeAccount(acct, cb) {
        homeApi('GET', '/api/v1/accounts/lookup?acct=' + encodeURIComponent(acct), (acc, status) => {
            if ((acc && acc.id) || status !== 404) { cb(acc, status); return; }
            homeApi('GET', '/api/v2/search?q=' + encodeURIComponent(acct) +
                '&type=accounts&resolve=true&limit=10', (res, s2) => {
                const hits = (res && res.accounts) || [];
                const want = acct.toLowerCase();
                const match = hits.find((a) => {
                    let f = a.acct || '';
                    if (f.indexOf('@') < 0) f += '@' + homeHost();
                    return f.toLowerCase() === want;
                });
                cb(match || null, match ? 200 : 404);
            });
        });
    }

    // ---------------------------------------------------------------- state

    const ACCOUNT_HREF = /^\/@([^/#?]+)$/;
    const LIST_PATH = /^\/@[^/]+\/?(followers|following)?\/?$/;
    const PROFILE_PATH = /^\/@[^/]+\/?$/;
    const FOLLOW_TEXT = /^(un)?follow(ing| back)?\b|^request( to follow)?\b|^cancel request\b/i;
    const LAST_ACTIVE_RE = /^Last active/i;
    const ITEM_SEL = 'article, li, .account, .account-card, .account__header';

    // acct -> { id, state: 'none'|'following'|'requested'|'missing'|'error'|
    //           'unauthorized'|'ratelimited'|'anon'|'unconfigured',
    //           active: true|false|undefined, ready, pending }
    const cache = {};

    function acctFromHandle(handle) {
        // local handle on the viewed instance: qualify with its domain
        return handle.indexOf('@') >= 0 ? handle : handle + '@' + location.host;
    }

    function acctFromPath() {
        const m = location.pathname.match(/^\/@([^/]+)/);
        return m ? acctFromHandle(m[1]) : null;
    }

    function acctFromAnchorEl(a) {
        const m = a && (a.getAttribute('href') || '').match(ACCOUNT_HREF);
        return m ? acctFromHandle(m[1]) : null;
    }

    // The "Last active <date>" stats row rendered in each entry of the
    // current profile UI: <li>Last active<strong><time datetime=…>…</time>.
    // Returns a timestamp, -Infinity for accounts that never posted, or null
    // when the row is absent/unparsable.
    function lastActiveInfo(item) {
        if (!item) return null;
        for (const li of item.querySelectorAll('li')) {
            if (!LAST_ACTIVE_RE.test((li.textContent || '').trim())) continue;
            const time = li.querySelector('time[datetime]');
            if (time) {
                const d = Date.parse(time.getAttribute('datetime'));
                if (!isNaN(d)) return d;
            }
            const rest = (li.textContent || '').replace(LAST_ACTIVE_RE, '').trim();
            if (rest === '-' || rest === '') return -Infinity;
            const d = new Date(rest).getTime();
            return isNaN(d) ? null : d;
        }
        return null;
    }

    // The list entry around a follow button. The current UI wraps every
    // follower in a component with CSS-module (hashed) classes, so climb from
    // the button to the ancestor that holds exactly one account link plus the
    // "Last active" row; stop before climbing into the whole list.
    function findItem(btn) {
        let node = btn.parentElement;
        for (let i = 0; node && i < 8; i++, node = node.parentElement) {
            const anchors = Array.from(node.querySelectorAll('a[href^="/@"]'))
                .filter((a) => ACCOUNT_HREF.test(a.getAttribute('href') || ''));
            if (anchors.length > 1) break; // climbed too far
            if (anchors.length === 1 && lastActiveInfo(node) !== null) {
                return { item: node, anchor: anchors[0] };
            }
        }
        return null;
    }

    function itemFor(btn) {
        const found = findItem(btn);
        return found ? found.item : (btn.closest(ITEM_SEL) || btn.parentElement);
    }

    function paint(btn, acct, c) {
        if (btn.dataset.mrfNative) return; // native button on home instance
        const host = homeHost();
        btn.disabled = false;
        if (!homeUrl()) {
            btn.textContent = 'Follow';
            btn.title = 'Set your home instance first (Tampermonkey menu)';
        } else if (!c || c.state === undefined) {
            btn.textContent = '… (' + host + ')';
            btn.disabled = true;
        } else if (c.state === 'ratelimited') {
            btn.textContent = '⏳ (' + host + ')';
            btn.title = 'Rate-limited by ' + host + '. The script throttles its ' +
                'requests and retries automatically — reopen the list in a moment.';
        } else if (c.state === 'unauthorized') {
            btn.textContent = '⚠ (' + host + ')';
            btn.title = 'The access token was rejected by ' + host + ' — ' +
                'reconfigure it via the Tampermonkey menu.';
            btn.disabled = true;
        } else if (c.state === 'missing') {
            btn.textContent = '✖ (' + host + ')';
            btn.title = acct + ' could not be resolved on ' + host + ' (lookup and search).';
            btn.disabled = true;
        } else if (c.state === 'error') {
            btn.textContent = '⚠ (' + host + ')';
            btn.title = 'Could not reach ' + host + ' (network error or outage).';
        } else if (c.state === 'anon') {
            btn.textContent = 'Follow (' + host + ')';
            btn.title = 'Found on ' + host + ', but no access token configured';
        } else if (c.state === 'following') {
            btn.textContent = 'Following (' + host + ')';
            btn.title = 'Click to unfollow ' + acct + ' on ' + host;
        } else if (c.state === 'requested') {
            btn.textContent = 'Requested (' + host + ')';
            btn.title = 'Follow request pending on ' + host + ' (click to withdraw)';
        } else {
            btn.textContent = 'Follow (' + host + ')';
            btn.title = 'Click to follow ' + acct + ' on ' + host;
        }
    }

    function applyFilter(btn, acct, c) {
        const item = itemFor(btn);
        if (!item) return;
        // Hide-only: unhiding happens exclusively when the filter is switched
        // off (refilterAll), so nothing can make a hidden entry reappear.
        if (settings.only_active && c && c.active === false) {
            item.style.display = 'none';
        }
    }

    function resolve(acct, btn) {
        const c = cache[acct] || (cache[acct] = {});
        if (c.ready) { paint(btn, acct, c); applyFilter(btn, acct, c); return; }
        if (c.pending) {
            (c.waiters || (c.waiters = [])).push(btn);
            return;
        }
        c.pending = true;

        const token = GM_getValue('token', '');
        const native = btn.dataset.mrfNative === '1';
        const steps = [];

        // Activity check runs first; when the account is stale, the (more
        // expensive) home-instance requests are skipped entirely.
        if (settings.only_active) {
            steps.push((next) => {
                // Preferred source: the "Last active" row on the page — free.
                const info = lastActiveInfo(itemFor(btn));
                if (info !== null) {
                    c.active = info > CUTOFF;
                    next();
                    return;
                }
                // Fallback for pages without that row: ask the viewed
                // instance's public API. If we are browsing the home instance
                // itself, its account id doubles as the local id and no
                // second lookup is needed.
                const sameInstance = homeUrl() === location.origin;
                const needLocalLookup = !(sameInstance && !native && c.id);
                const checkStatuses = (localId) => {
                    if (!localId) { next(); return; }
                    localApi('GET', '/api/v1/accounts/' + localId + '/statuses?limit=1', (sts, status) => {
                        if (status === 429) { next(); return; } // leave active undefined
                        if (Array.isArray(sts)) {
                            c.active = sts.length
                                ? new Date(sts[0].created_at).getTime() > CUTOFF
                                : false;
                        }
                        next();
                    });
                };
                if (!needLocalLookup) { checkStatuses(c.id); return; }
                localApi('GET', '/api/v1/accounts/lookup?acct=' + encodeURIComponent(acct), (acc) => {
                    checkStatuses(acc && acc.id);
                });
            });
        }

        if (homeUrl() && !native) {
            steps.push((next) => {
                if (settings.only_active && c.active === false) { next(); return; } // stale: skip
                findHomeAccount(acct, (acc, status) => {
                    if (acc && acc.id) {
                        c.id = acc.id;
                        if (!token) { c.state = 'anon'; next(); return; }
                        // Batched: one relationships request covers up to 40
                        // entries, so the per-entry cost is just the lookup.
                        queueRelationships(acc.id, (r) => {
                            c.state = r ? (r.following ? 'following'
                                : r.requested ? 'requested' : 'none') : 'missing';
                            next();
                        });
                    } else if (status === 404) {
                        c.state = 'missing';
                        next();
                    } else if (status === 401 || status === 403) {
                        c.state = 'unauthorized';
                        next();
                    } else if (status === 429) {
                        c.state = 'ratelimited';
                        next();
                    } else {
                        c.state = 'error';
                        next();
                    }
                });
            });
        } else if (!homeUrl()) {
            c.state = 'unconfigured';
        }

        const finish = () => {
            c.pending = false;
            c.ready = true;
            const waiters = (c.waiters || []).concat([btn]);
            c.waiters = [];
            for (const w of waiters) {
                if (w.isConnected) { paint(w, acct, c); applyFilter(w, acct, c); }
            }
        };
        const run = (i) => {
            if (i >= steps.length) { finish(); return; }
            steps[i](() => run(i + 1));
        };
        run(0);
    }

    function toggle(acct, btn) {
        if (!homeUrl()) { configure(); return; }
        if (!GM_getValue('token', '')) { alert('No access token configured (Tampermonkey menu).'); return; }
        const c = cache[acct];
        if (!c || !c.id || c.state === 'missing') return;
        const following = (c.state === 'following' || c.state === 'requested');
        btn.textContent = '… (' + homeHost() + ')';
        apiCall(following ? 'DELETE' : 'POST', homeUrl(),
            '/api/v1/accounts/' + c.id + '/follow', GM_getValue('token', ''), (rel, status) => {
                const r = rel && (rel.following !== undefined ? rel : rel[0]);
                if (status === 200 && r) {
                    c.state = r.following ? 'following' : r.requested ? 'requested' : 'none';
                    c.ready = true;
                    paint(btn, acct, c);
                    showToast(
                        c.state === 'following' ? '✓ Followed ' + acct :
                        c.state === 'requested' ? '⏳ Follow request sent to ' + acct :
                        'Unfollowed ' + acct);
                } else if (status === 429) {
                    paint(btn, acct, c);
                    showToast('Rate-limited by ' + homeHost() + ' — try again shortly', true);
                } else if (status === 404) {
                    // The cached account id is unknown on the home instance
                    // — resolve fresh and show the real follow state.
                    delete cache[acct];
                    resolve(acct, btn);
                    showToast('Account id rejected by ' + homeHost() +
                        ' — follow state re-checked', true);
                } else {
                    paint(btn, acct, c);
                    showToast('Follow action failed (' + status + ')', true);
                }
            });
    }

    // ---------------------------------------------------------------- DOM

    function takeover(btn) {
        const found = findItem(btn);
        let acct = null;
        if (found) {
            acct = acctFromAnchorEl(found.anchor);
        } else {
            acct = acctFromAnchorEl(btn.closest(ITEM_SEL) &&
                btn.closest(ITEM_SEL).querySelector('a[href^="/@"]'));
        }
        if (!acct && PROFILE_PATH.test(location.pathname)) acct = acctFromPath();
        if (!acct) { btn.dataset.mrf = 'skip'; return; }
        if (meta.me && acct === meta.me + '@' + location.host) { btn.dataset.mrf = 'skip'; return; }

        // When the filter is on, decide from the page's own "Last active"
        // row first: stale entries are hidden without relabelling the button
        // or spending any API calls.
        if (settings.only_active && found) {
            const info = lastActiveInfo(found.item);
            if (info !== null && info <= CUTOFF) {
                found.item.style.display = 'none';
                const c = cache[acct] || (cache[acct] = {});
                c.active = false;
                btn.dataset.mrf = 'skip';
                btn.dataset.mrfAcct = acct;
                return;
            }
        }
        // Known-inactive accounts (e.g. decided on an earlier render) are
        // never taken over and never queried.
        if (settings.only_active && cache[acct] && cache[acct].active === false) {
            btn.dataset.mrf = 'skip';
            btn.dataset.mrfAcct = acct;
            return;
        }

        // On the home instance (logged in) the native button is already
        // correct — keep it, only use it as an anchor for the activity filter.
        if (nativeHere()) {
            btn.dataset.mrfAcct = acct;
            resolve(acct, btn);
            return;
        }

        // Replace the node with a clone to detach the site's own click
        // handler (React listeners die with the original node), then wire up
        // our own behavior and label.
        const clone = btn.cloneNode(true);
        btn.parentNode.replaceChild(clone, btn);
        btn = clone;
        btn.dataset.mrfAcct = acct;
        btn.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();
            toggle(acct, btn);
        });
        resolve(acct, btn);
    }

    function scan() {
        if (!LIST_PATH.test(location.pathname)) return;
        if (!homeUrl() && !settings.only_active) return;
        document.querySelectorAll('button, a.button').forEach((b) => {
            if (b.dataset.mrf) return;
            if (!FOLLOW_TEXT.test((b.textContent || '').trim())) return;
            b.dataset.mrf = '1';
            takeover(b);
        });
        // Re-hide entries whose inactivity is already known, in case React
        // re-created their nodes after the initial pass.
        if (settings.only_active) {
            document.querySelectorAll('[data-mrf-acct]').forEach((b) => {
                const c = cache[b.dataset.mrfAcct];
                if (c && c.active === false) {
                    const item = itemFor(b);
                    if (item) item.style.display = 'none';
                }
            });
        }
    }

    function refilterAll() {
        document.querySelectorAll('[data-mrf-acct]').forEach((btn) => {
            const acct = btn.dataset.mrfAcct;
            const item = itemFor(btn);
            if (item) item.style.display = '';
            if (!settings.only_active) {
                // The age check may have skipped the follow-status lookup;
                // fetch it now that the account is relevant again.
                const c = acct && cache[acct];
                if (c && c.state === undefined) {
                    delete cache[acct];
                    resolve(acct, btn);
                }
                return;
            }
            const c = acct && cache[acct];
            if (!c || c.active === undefined) {
                delete cache[acct]; // force a fresh resolve incl. activity check
                resolve(acct, btn);
            } else {
                applyFilter(btn, acct, c);
            }
        });
    }

    // --- UI (option dialog, pattern from heise_newsticker_filter.user.js) ---

    const style = document.createElement('style');
    style.textContent = `
        .mrf-nav-wrap { position: relative; list-style: none; display: block; }
        .mrf-nav-btn {
            display: flex;
            align-items: center;
            gap: 8px;
            width: 100%;
            text-align: left;
            background: none;
            border: none;
            cursor: pointer;
            font: inherit;
            color: inherit;
            padding: 10px 14px;
            overflow: hidden;
        }
        .mrf-nav-btn:hover { background: rgba(86, 58, 200, 0.1); }
        .mrf-fallback-wrap { position: fixed; top: 12px; left: 12px; z-index: 99998; }
        .mrf-panel {
            position: absolute;
            top: calc(100% + 6px);
            left: 0;
            z-index: 99998;
            background: #fff;
            border: 1px solid #ddd;
            border-radius: 4px;
            box-shadow: 0 2px 8px rgba(0,0,0,0.15);
            padding: 6px 0;
            min-width: 260px;
        }
        .mrf-label {
            display: flex;
            align-items: center;
            gap: 8px;
            padding: 5px 14px;
            cursor: pointer;
            white-space: nowrap;
            font: 13px sans-serif;
            color: #1f1235;
            user-select: none;
        }
        .mrf-label:hover { background: #f0f0f0; }
    `;
    document.head.append(style);

    // Place the filter entry into Mastodon's left sidebar navigation. Two UI
    // generations must be supported:
    // - classic (Mastodon 4.x): <nav class="navigation-panel"> with stable
    //   class names;
    // - redesigned (v5 nightly): CSS-module (hashed) classes. The sidebar is
    //   found by content — the nav holding the About/Explore/Home links (the
    //   logged-out sidebar has no Home link!). Among several navs the one
    //   with the most links/buttons wins, which skips the mobile tab bar.
    // The SPA may still be rendering at document-end, so poll for up to ~4s;
    // if no sidebar appears (e.g. multi-column layout), fall back to the
    // top-left page corner. React occasionally wipes foreign nodes out of the
    // sidebar, so keepPanel() re-inserts the entry whenever it disappears.
    let uiBuilt = false;
    const uiStart = Date.now();
    let uiWrap = null;
    let uiBtn = null;
    let uiInNav = false;

    function visibleNav(n) {
        return n && getComputedStyle(n).display !== 'none' ? n : null;
    }

    function findSidebar() {
        // classic UI (Mastodon 4.x)
        for (const n of document.querySelectorAll('.navigation-panel')) {
            if (visibleNav(n)) return n;
        }
        // redesigned UI: find by content
        const navs = new Set();
        for (const a of document.querySelectorAll('a[href="/home"], a[href="/explore"], a[href="/about"]')) {
            const n = visibleNav(a.closest('nav'));
            if (n) navs.add(n);
        }
        let best = null;
        let bestScore = -1;
        for (const n of navs) {
            const score = n.querySelectorAll('a, button').length;
            if (score > bestScore) { best = n; bestScore = score; }
        }
        return best;
    }

    function insertWrap() {
        if (uiInNav) {
            const nav = findSidebar();
            if (nav) {
                uiWrap.className = 'mrf-nav-wrap';
                uiBtn.className = 'mrf-nav-btn';
                const list = nav.querySelector('ul');
                if (list) {
                    if (list.firstElementChild !== uiWrap) {
                        list.insertBefore(uiWrap, list.firstChild);
                    }
                } else {
                    nav.insertBefore(uiWrap, nav.firstChild);
                }
                // If React drops or hides the foreign node anyway, fall back
                // to the page corner instead of staying invisible.
                requestAnimationFrame(() => {
                    if (!uiWrap.isConnected) { uiInNav = false; insertWrap(); return; }
                    if (uiInNav && getComputedStyle(uiWrap).display === 'none') {
                        uiInNav = false;
                        uiWrap.remove();
                        insertWrap();
                    }
                });
                return;
            }
            uiInNav = false; // nav vanished: fall back to the page corner
        }
        uiWrap.className = 'mrf-fallback-wrap';
        document.body.append(uiWrap);
    }

    function tryBuildPanel() {
        if (uiBuilt) return;
        const nav = findSidebar();
        if (!nav && Date.now() - uiStart < 4000) return; // SPA still rendering
        uiBuilt = true;
        uiInNav = !!nav;
        insertWrap();
    }

    function keepPanel() {
        if (!uiBuilt) return;
        if (!uiWrap.isConnected) { insertWrap(); return; }
        // re-assert the top position if React moved its own items around
        if (uiInNav) {
            const nav = findSidebar();
            const list = nav ? nav.querySelector('ul') : null;
            if (list && list.firstElementChild !== uiWrap) {
                list.insertBefore(uiWrap, list.firstChild);
            }
        }
    }

    function buildPanelContent() {
        uiWrap = document.createElement('li'); // valid child of the sidebar's <ul>
        uiBtn = document.createElement('button');
        uiBtn.textContent = '⚙ Filter';

        const panel = document.createElement('div');
        panel.className = 'mrf-panel';
        panel.hidden = true;

        const homeLine = document.createElement('div');
        homeLine.className = 'mrf-label';
        homeLine.style.cursor = 'default';
        homeLine.textContent = 'Home: ' + (homeHost() || 'not configured');
        panel.append(homeLine);

        const label = document.createElement('label');
        label.className = 'mrf-label';

        const cb = document.createElement('input');
        cb.type = 'checkbox';
        cb.checked = settings.only_active;
        cb.addEventListener('change', () => {
            settings.only_active = cb.checked;
            GM_setValue('mrf_only_active', cb.checked);
            refilterAll();
        });

        label.append(cb, document.createTextNode('Only active accounts (posted in the last month)'));
        panel.append(label);

        uiBtn.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();
            homeLine.textContent = 'Home: ' + (homeHost() || 'not configured');
            panel.hidden = !panel.hidden;
        });
        document.addEventListener('click', () => { panel.hidden = true; });
        panel.addEventListener('click', (e) => e.stopPropagation());

        uiWrap.append(uiBtn, panel);
    }

    buildPanelContent();

    // --- startup (all declarations above must have run by now) ---

    scan();
    tryBuildPanel();

    const timer = { id: null };
    new MutationObserver(() => {
        clearTimeout(timer.id);
        timer.id = setTimeout(() => {
            try {
                scan();
                tryBuildPanel();
                keepPanel();
            } catch (e) {
                console.error('Mastodon Remote Follow:', e);
            }
        }, 300);
    }).observe(document.body, { childList: true, subtree: true });

    // Belt-and-suspenders in case the page stays mutation-free while the SPA
    // is still mounting.
    const bootInterval = setInterval(() => {
        tryBuildPanel();
        keepPanel();
        if (uiBuilt && uiWrap && uiWrap.isConnected) clearInterval(bootInterval);
    }, 250);
})();
