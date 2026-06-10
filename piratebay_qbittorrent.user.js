// ==UserScript==
// @name         Send to qBittorrent (Pirate Bay)
// @namespace    https://github.com/perdrizat/userscripts
// @version      1.3
// @description  Adds a button next to each magnet link that sends the torrent to a qBittorrent instance via its WebUI API.
// @author       Markus Perdrizat
// @license      MIT
// @match        *://thepiratebay.org/*
// @match        *://thepiratebay.se/*
// @grant        GM_xmlhttpRequest
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_registerMenuCommand
// @connect      *
// @run-at       document-end
// ==/UserScript==

// Configuration lives in Tampermonkey script storage (survives script updates),
// not in the code. The first button click prompts for the qBittorrent WebUI URL;
// change it later via the Tampermonkey menu ("Configure qBittorrent…").
//
// FIRST REQUEST: Tampermonkey shows a dialog that "a userscript wants to access
// a cross-origin resource" pointing at your qBittorrent host. This is expected:
// the host is only known at runtime, so it cannot be whitelisted with a specific
// @connect directive. Check that the request target URL is your qBittorrent
// WebUI, then choose "Always allow" ("Immer erlauben") to whitelist it
// permanently. Avoid "Always allow all domains" — it would let this script
// talk to any host without asking.
//
// NO-AUTH SETUP: to avoid storing a password, let qBittorrent skip auth for
// your home network: Tools → Options → Web UI → Authentication → enable
// "Bypass authentication for clients in whitelisted IP subnets" and add your
// LAN subnet (e.g. 192.168.1.0/24). Only do this on a trusted network — every
// device in that subnet gets password-free control — and never expose a WebUI
// configured this way to the internet.
function getConfig() {
  return {
    url: GM_getValue('qb_url', ''),
    username: GM_getValue('qb_username', 'admin'),
    password: GM_getValue('qb_password', '')
  };
}

function configure() {
  var url = prompt('qBittorrent WebUI URL (e.g. http://192.168.0.42:8080)', GM_getValue('qb_url', 'http://'));
  if (url === null) return null;
  var username = prompt('Username (ignored if auth is bypassed)', GM_getValue('qb_username', 'admin'));
  if (username === null) return null;
  var password = prompt('Password (leave empty if auth is bypassed)', GM_getValue('qb_password', ''));
  if (password === null) return null;
  GM_setValue('qb_url', url.replace(/\/+$/, ''));
  GM_setValue('qb_username', username);
  GM_setValue('qb_password', password);
  return getConfig();
}

GM_registerMenuCommand('Configure qBittorrent…', configure);

function showToast(msg, isError) {
  var toast = document.createElement('div');
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
    'transition: opacity 0.4s',
    'background-color: ' + (isError ? '#d32f2f' : '#4CAF50')
  ].join(';');
  document.body.appendChild(toast);
  setTimeout(function() {
    toast.style.opacity = '0';
    setTimeout(function() { toast.remove(); }, 400);
  }, isError ? 6000 : 3000);
}

document.querySelectorAll('a[href^="magnet:?xt=urn:btih:"]').forEach(function(link) {
  var btn = document.createElement('button');
  btn.textContent = '⬇ qB';
  btn.style.marginLeft = '8px';
  btn.style.cursor = 'pointer';
  btn.style.backgroundColor = '#4CAF50';
  btn.style.color = 'white';
  btn.style.border = 'none';
  btn.style.padding = '2px 6px';
  btn.style.borderRadius = '4px';
  btn.onclick = function(e) {
    e.preventDefault();
    var cfg = getConfig();
    if (!cfg.url) cfg = configure();
    if (!cfg || !cfg.url || cfg.url === 'http://') return;
    var magnet = link.href;
    GM_xmlhttpRequest({
      method: 'POST',
      url: cfg.url + '/api/v2/auth/login',
      headers: {'Content-Type': 'application/x-www-form-urlencoded'},
      data: 'username=' + encodeURIComponent(cfg.username) + '&password=' + encodeURIComponent(cfg.password),
      onload: function(r) {
        if (r.status >= 200 && r.status < 300) {
          GM_xmlhttpRequest({
            method: 'POST',
            url: cfg.url + '/api/v2/torrents/add',
            headers: {'Content-Type': 'application/x-www-form-urlencoded'},
            data: 'urls=' + encodeURIComponent(magnet),
            onload: function(addR) {
              if (addR.status >= 200 && addR.status < 300) {
                showToast('✅ Torrent added!');
              } else {
                showToast('❌ Add failed: ' + addR.status + ' ' + addR.responseText, true);
              }
            }
          });
        } else {
          showToast('❌ Login failed: ' + r.status + ' ' + r.responseText, true);
        }
      }
    });
  };
  link.parentNode.insertBefore(btn, link.nextSibling);
});
