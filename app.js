/*
 * Follow-Check
 * Wertet den offiziellen Instagram-Datenexport komplett lokal im Browser aus.
 * Zeigt nur Konten, die dir nicht zurückfolgen, und lässt dich per Swipe
 * entscheiden: links = entfolgen, rechts = behalten.
 * Entscheide werden im localStorage dieses Geräts gespeichert, damit bei einem
 * neuen Export nur noch neue Leute zum Swipen kommen.
 * Es gibt keinen Server-Upload, kein Tracking und keine Netzwerkanfragen
 * (zusätzlich per Content-Security-Policy "connect-src 'none'" erzwungen).
 */
(function () {
  "use strict";

  // ---------------------------------------------------------------------------
  // Zustand
  // ---------------------------------------------------------------------------
  const STORE_KEY = "followcheck.v2";
  const OLD_KEY = "followcheck.v1";
  const PAGE = 150;
  const SWIPE_DIST = 100;

  /** Konten aus dem letzten Export, die dir nicht zurückfolgen */
  let notback = [];          // [{u, t}]
  /** Kennzahlen des letzten Exports */
  let stats = null;          // {following, followers, exportAt}
  /** Entscheide: key (username klein) -> Eintrag */
  let keep = {};             // {u, t, at}
  let unfollow = {};         // {u, t, at, done}
  let backupAt = 0;
  /** Anzahl Änderungen seit dem letzten Backup */
  let changes = 0;

  // Nur für diese Sitzung (falls following und followers einzeln geladen werden)
  /** @type {Map<string,{u:string,t:number}>|null} */
  let following = null;
  /** @type {Map<string,{u:string,t:number}>|null} */
  let followers = null;

  let demo = false;
  let view = "swipe";
  let shown = 0;
  let animating = false;
  let storageOk = true;
  let persistAsked = false;
  let guideOpen = false;
  const history = [];        // Swipe-Verlauf für Rückgängig: {k, kind}

  const $ = (id) => document.getElementById(id);
  const USER_RE = /^[A-Za-z0-9._]{1,30}$/;
  const RESERVED = new Set(["p", "explore", "reel", "reels", "stories", "tv", "accounts",
    "directory", "about", "developer", "legal", "privacy", "terms", "help", "emails",
    "session", "challenge", "web", "direct", "your_activity"]);
  const key = (u) => String(u).toLowerCase();
  function bump() { changes++; }

  // ---------------------------------------------------------------------------
  // Parser
  // ---------------------------------------------------------------------------
  function cleanUser(s) {
    return (s == null ? "" : String(s)).trim().replace(/^@/, "");
  }

  function usernameFromHref(href) {
    if (!href) return "";
    let url;
    try {
      url = /^https?:/i.test(href) ? new URL(href) : new URL(href, "https://www.instagram.com/");
    } catch (e) { return ""; }
    const host = url.hostname.replace(/^www\./, "").toLowerCase();
    if (host !== "instagram.com" && !host.endsWith(".instagram.com")) return "";
    let segs = url.pathname.split("/").filter(Boolean);
    if (segs[0] === "_u" && segs.length > 1) segs = segs.slice(1);
    const first = segs[0] || "";
    if (!first || RESERVED.has(first.toLowerCase())) return "";
    return decodeURIComponent(first);
  }

  function add(map, name, ts) {
    const u = cleanUser(name);
    if (!USER_RE.test(u)) return;
    const k = u.toLowerCase();
    const t = Number(ts) || 0;
    const prev = map.get(k);
    if (!prev) map.set(k, { u: u, t: t });
    else if (!prev.t && t) prev.t = t;
  }

  function parseJson(data) {
    const map = new Map();
    (function walk(node) {
      if (Array.isArray(node)) { node.forEach(walk); return; }
      if (!node || typeof node !== "object") return;
      if (Array.isArray(node.string_list_data)) {
        const title = cleanUser(node.title);
        node.string_list_data.forEach(function (it) {
          it = it || {};
          let u = cleanUser(it.value);
          if (!u) u = usernameFromHref(it.href);
          if (!u) u = title;
          add(map, u, it.timestamp);
        });
        if (!node.string_list_data.length && title) add(map, title, 0);
        return;
      }
      for (const k in node) {
        if (Object.prototype.hasOwnProperty.call(node, k)) walk(node[k]);
      }
    })(data);
    return map;
  }

  function parseHtml(text) {
    const map = new Map();
    const doc = new DOMParser().parseFromString(text, "text/html");
    doc.querySelectorAll("a[href]").forEach(function (a) {
      const u = usernameFromHref(a.getAttribute("href"));
      if (u) add(map, u, 0);
    });
    return map;
  }

  function parseText(text) {
    const s = (text || "").replace(/^﻿/, "").trim();
    if (!s) return { map: new Map(), json: null };
    if (s[0] === "{" || s[0] === "[") {
      try {
        const data = JSON.parse(s);
        return { map: parseJson(data), json: data };
      } catch (e) { /* kein JSON, weiter mit HTML */ }
    }
    return { map: parseHtml(s), json: null };
  }

  // Dateiname -> "following" | "followers" | null
  function kindFromName(path) {
    const base = String(path).split("/").pop().toLowerCase();
    if (/^following([\s\-(]\S*)?\.(json|html?)$/.test(base)) return "following";
    if (/^followers(_\d+)?([\s\-(]\S*)?\.(json|html?)$/.test(base)) return "followers";
    return null;
  }

  function kindFromJson(data) {
    if (data && !Array.isArray(data) && typeof data === "object") {
      if (Array.isArray(data.relationships_following)) return "following";
      if (Array.isArray(data.relationships_followers)) return "followers";
    }
    if (Array.isArray(data) && data.length && data[0] && Array.isArray(data[0].string_list_data)) return "followers";
    return null;
  }

  // ---------------------------------------------------------------------------
  // Minimaler ZIP-Leser (ohne Bibliothek, nutzt DecompressionStream)
  // Liest nur die benötigten Einträge, auch bei sehr grossen Exporten.
  // ---------------------------------------------------------------------------
  async function bytes(file, start, end) {
    return new DataView(await file.slice(start, end).arrayBuffer());
  }
  function u64(dv, o) { return dv.getUint32(o, true) + dv.getUint32(o + 4, true) * 4294967296; }

  async function zipEntries(file) {
    const tailLen = Math.min(file.size, 65557 + 20);
    const tail = await bytes(file, file.size - tailLen, file.size);
    let eocd = -1;
    for (let i = tail.byteLength - 22; i >= 0; i--) {
      if (tail.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
    }
    if (eocd < 0) throw new Error("Das scheint keine gültige ZIP-Datei zu sein.");
    let count = tail.getUint16(eocd + 10, true);
    let cdSize = tail.getUint32(eocd + 12, true);
    let cdOff = tail.getUint32(eocd + 16, true);

    if (count === 0xffff || cdSize === 0xffffffff || cdOff === 0xffffffff) {
      const loc = eocd - 20;
      if (loc >= 0 && tail.getUint32(loc, true) === 0x07064b50) {
        const z64off = u64(tail, loc + 8);
        const z = await bytes(file, z64off, z64off + 56);
        if (z.getUint32(0, true) === 0x06064b50) {
          count = u64(z, 32); cdSize = u64(z, 40); cdOff = u64(z, 48);
        }
      }
    }

    const cd = await bytes(file, cdOff, cdOff + cdSize);
    const dec = new TextDecoder("utf-8");
    const out = [];
    let p = 0;
    for (let n = 0; n < count && p + 46 <= cd.byteLength; n++) {
      if (cd.getUint32(p, true) !== 0x02014b50) break;
      const flags = cd.getUint16(p + 8, true);
      const method = cd.getUint16(p + 10, true);
      let comp = cd.getUint32(p + 20, true);
      let size = cd.getUint32(p + 24, true);
      const nLen = cd.getUint16(p + 28, true);
      const xLen = cd.getUint16(p + 30, true);
      const cLen = cd.getUint16(p + 32, true);
      let off = cd.getUint32(p + 42, true);
      const name = dec.decode(new Uint8Array(cd.buffer, cd.byteOffset + p + 46, nLen));
      // ZIP64-Zusatzfeld
      let x = p + 46 + nLen;
      const xEnd = x + xLen;
      while (x + 4 <= xEnd) {
        const id = cd.getUint16(x, true), len = cd.getUint16(x + 2, true);
        if (id === 0x0001) {
          let q = x + 4;
          if (size === 0xffffffff) { size = u64(cd, q); q += 8; }
          if (comp === 0xffffffff) { comp = u64(cd, q); q += 8; }
          if (off === 0xffffffff) { off = u64(cd, q); q += 8; }
        }
        x += 4 + len;
      }
      out.push({ name: name, flags: flags, method: method, comp: comp, size: size, off: off });
      p = xEnd + cLen;
    }
    return out;
  }

  async function zipRead(file, e) {
    if (e.flags & 1) throw new Error("Die ZIP-Datei ist verschlüsselt.");
    const h = await bytes(file, e.off, e.off + 30);
    if (h.getUint32(0, true) !== 0x04034b50) throw new Error("Beschädigte ZIP-Datei.");
    const start = e.off + 30 + h.getUint16(26, true) + h.getUint16(28, true);
    const blob = file.slice(start, start + e.comp);
    if (e.method === 0) return await blob.text();
    if (e.method === 8) {
      if (typeof DecompressionStream === "undefined") {
        throw new Error("Dein Browser kann ZIP-Dateien nicht direkt öffnen. Bitte aktualisiere iOS bzw. deinen Browser oder entpacke die ZIP und wähle die JSON-Dateien einzeln.");
      }
      const stream = blob.stream().pipeThrough(new DecompressionStream("deflate-raw"));
      return await new Response(stream).text();
    }
    throw new Error("Nicht unterstütztes ZIP-Format.");
  }

  function isZip(file) {
    return /\.zip$/i.test(file.name) || /zip/i.test(file.type);
  }
  async function looksLikeZip(file) {
    try {
      const dv = await bytes(file, 0, 4);
      return dv.byteLength === 4 && dv.getUint32(0, true) === 0x04034b50;
    } catch (e) { return false; }
  }


  // ---------------------------------------------------------------------------
  // Dateien verarbeiten
  // ---------------------------------------------------------------------------
  async function handleFiles(fileList) {
    const files = Array.from(fileList || []);
    if (!files.length) return;
    clearStatus();
    status("info", "⏳", "Lese " + (files.length > 1 ? files.length + " Dateien" : "Datei") + " …");

    const newFollowing = new Map();
    const newFollowers = new Map();
    let gotFollowing = false, gotFollowers = false, gotBackup = false, backupMsg = "";
    const problems = [];

    function merge(target, map) { map.forEach(function (v, k) { if (!target.has(k)) target.set(k, v); }); }

    for (const file of files) {
      try {
        if (isZip(file) || await looksLikeZip(file)) {
          const entries = await zipEntries(file);
          const wanted = entries.filter(function (e) { return kindFromName(e.name) && !/(^|\/)__MACOSX\//.test(e.name); });
          if (!wanted.length) {
            problems.push("In „" + file.name + "“ wurden keine Follower-Dateien gefunden. Hast du beim Export „Follower und gefolgte Konten“ ausgewählt?");
            continue;
          }
          for (const e of wanted) {
            const kind = kindFromName(e.name);
            const res = parseText(await zipRead(file, e));
            if (kind === "following") { merge(newFollowing, res.map); gotFollowing = true; }
            else { merge(newFollowers, res.map); gotFollowers = true; }
          }
        } else {
          const text = await file.text();
          const res = parseText(text);
          if (res.json && res.json.app === "follow-check") {
            const taken = importBackup(res.json);
            gotBackup = true;
            backupMsg = "Backup geladen: " + fmt(taken) + " Entscheide übernommen";
            continue;
          }
          const kind = kindFromName(file.name) || kindFromJson(res.json);
          if (!kind) {
            problems.push("„" + file.name + "“ wurde nicht erkannt. Benötigt werden following.json und followers_1.json (oder die ZIP-Datei).");
            continue;
          }
          if (kind === "following") { merge(newFollowing, res.map); gotFollowing = true; }
          else { merge(newFollowers, res.map); gotFollowers = true; }
        }
      } catch (err) {
        problems.push("„" + file.name + "“: " + (err && err.message ? err.message : "Konnte nicht gelesen werden."));
      }
    }

    if (gotFollowing) following = newFollowing;
    if (gotFollowers) followers = newFollowers;

    clearStatus();
    if (backupMsg) status("ok", "✔", backupMsg);
    if (gotFollowing || gotFollowers || !gotBackup) {
      if (following) status(following.size ? "ok" : "err", following.size ? "✔" : "⚠", following.size ? "Du folgst " + fmt(following.size) + " Konten" : "In der following-Datei wurden keine Konten gefunden.");
      else status("info", "○", "Es fehlt noch: following.json (Konten, denen du folgst)");
      if (followers) status(followers.size ? "ok" : "err", followers.size ? "✔" : "⚠", followers.size ? fmt(followers.size) + " Konten folgen dir" : "In den followers-Dateien wurden keine Konten gefunden.");
      else status("info", "○", "Es fehlt noch: followers_1.json (deine Follower)");
    }
    problems.forEach(function (p) { status("err", "⚠", p); });

    $("file").value = "";
    if ((gotFollowing || gotFollowers) && following && followers && following.size) {
      applyExport(following, followers, false);
    }
  }

  /**
   * Neuen Export übernehmen und mit den gespeicherten Entscheiden abgleichen.
   */
  function applyExport(fing, fers, isDemo) {
    if (isDemo) {
      demo = true; keep = {}; unfollow = {}; notback = []; backupAt = 0; changes = 0;
    } else if (demo) {
      demo = false; keep = {}; unfollow = {}; notback = []; stats = null; backupAt = 0; changes = 0;
    }
    const hadPrev = !!stats || Object.keys(keep).length > 0 || Object.keys(unfollow).length > 0;
    const prevSet = new Set(notback.map(function (r) { return key(r.u); }));

    const nb = [];
    fing.forEach(function (v, k) { if (!fers.has(k)) nb.push({ u: v.u, t: v.t || 0 }); });
    const nbMap = new Map(nb.map(function (r) { return [key(r.u), r]; }));

    let unfollowed = 0, followBack = 0, stillOpen = 0, reopened = 0, skipped = 0;
    Object.keys(unfollow).forEach(function (k) {
      const r = nbMap.get(k);
      if (!r) {
        if (fing.has(k)) followBack++; else unfollowed++;
        delete unfollow[k];
        return;
      }
      const e = unfollow[k];
      if (e.done) { e.done = false; reopened++; }
      if (r.t) e.t = r.t;
      stillOpen++;
    });
    Object.keys(keep).forEach(function (k) {
      const r = nbMap.get(k);
      if (r) { skipped++; if (r.t) keep[k].t = r.t; }
    });

    notback = nb;
    stats = { following: fing.size, followers: fers.size, exportAt: Date.now() };
    history.length = 0;
    save();

    const note = $("import-note");
    note.textContent = "";
    if (hadPrev && !isDemo) {
      const fresh = queue().filter(function (r) { return !prevSet.has(key(r.u)); }).length;
      note.appendChild(el("strong", "", "Abgleich mit deinen gespeicherten Entscheiden"));
      const ul = el("ul");
      ul.appendChild(el("li", "", fmt(fresh) + " neu dazugekommen, " + fmt(queue().length) + " insgesamt zum Swipen"));
      if (skipped) ul.appendChild(el("li", "", fmt(skipped) + " behaltene werden übersprungen"));
      if (unfollowed) ul.appendChild(el("li", "", fmt(unfollowed) + " erfolgreich entfolgt ✔"));
      if (followBack) ul.appendChild(el("li", "", fmt(followBack) + " folgen dir inzwischen zurück"));
      if (stillOpen) ul.appendChild(el("li", "", fmt(stillOpen) + " noch zum Entfolgen offen" + (reopened ? " (davon " + fmt(reopened) + " abgehakt, aber du folgst ihnen noch)" : "")));
      note.appendChild(ul);
      note.hidden = false;
    } else if (isDemo) {
      note.appendChild(el("span", "", "ℹ Das sind erfundene Beispieldaten. Es wird nichts gespeichert. Lade deinen eigenen Export, um loszulegen."));
      note.hidden = false;
    } else {
      note.hidden = true;
    }

    setView("swipe");
    renderAll();
    $("results").scrollIntoView({ behavior: "smooth", block: "start" });
  }

  // ---------------------------------------------------------------------------
  // Swipe-Stapel
  // ---------------------------------------------------------------------------
  function sorter(order) {
    return function (a, b) {
      if (order === "new" && a.t !== b.t) return b.t - a.t;
      if (order === "old" && a.t !== b.t) return (a.t || Infinity) - (b.t || Infinity);
      if (order === "recent" && a.at !== b.at) return (b.at || 0) - (a.at || 0);
      return a.u.toLowerCase().localeCompare(b.u.toLowerCase());
    };
  }

  function queue() {
    return notback.filter(function (r) {
      const k = key(r.u);
      return !keep[k] && !unfollow[k];
    }).sort(sorter($("order").value));
  }

  function profileUrl(u) { return "https://www.instagram.com/" + encodeURIComponent(u) + "/"; }

  function makeCard(r, depth) {
    const k = key(r.u);
    const c = el("div", "scard");
    c.setAttribute("data-depth", String(depth));
    c.appendChild(el("div", "stamp stamp-no", "ENTFOLGEN"));
    c.appendChild(el("div", "stamp stamp-yes", "BEHALTEN"));
    const av = el("div", "scard-avatar", r.u.replace(/[^a-z0-9]/gi, "").charAt(0) || "@");
    av.style.background = colorFor(k);
    av.setAttribute("aria-hidden", "true");
    c.appendChild(av);
    c.appendChild(el("div", "scard-name", "@" + r.u));
    c.appendChild(el("div", "scard-since", r.t ? "Du folgst seit " + dateStr(r.t) : "Folgt dir nicht zurück"));
    const a = el("a", "scard-open", "Profil ansehen ↗");
    a.href = profileUrl(r.u);
    a.target = "_blank";
    a.rel = "noopener noreferrer";
    c.appendChild(a);
    return c;
  }

  function setPos(card, dx, dy) {
    card.style.transform = "translate(" + dx + "px," + (dy * 0.25) + "px) rotate(" + (dx / 18) + "deg)";
    const no = card.querySelector(".stamp-no"), yes = card.querySelector(".stamp-yes");
    if (no) no.style.opacity = String(Math.max(0, Math.min(1, -dx / SWIPE_DIST)));
    if (yes) yes.style.opacity = String(Math.max(0, Math.min(1, dx / SWIPE_DIST)));
  }

  function attachDrag(card) {
    let id = null, sx = 0, sy = 0, dx = 0, dy = 0, t0 = 0, moved = false;
    card.addEventListener("pointerdown", function (e) {
      if (animating || id !== null || (e.button && e.button !== 0)) return;
      if (e.target.closest("a")) return;
      id = e.pointerId; sx = e.clientX; sy = e.clientY; dx = 0; dy = 0;
      t0 = performance.now(); moved = false;
      try { card.setPointerCapture(id); } catch (err) { /* ignorieren */ }
      card.classList.add("dragging");
    });
    card.addEventListener("pointermove", function (e) {
      if (e.pointerId !== id) return;
      dx = e.clientX - sx; dy = e.clientY - sy;
      if (Math.abs(dx) > 6 || Math.abs(dy) > 6) moved = true;
      setPos(card, dx, dy);
    });
    function end(e, cancel) {
      if (e.pointerId !== id) return;
      id = null;
      card.classList.remove("dragging");
      const speed = Math.abs(dx) / Math.max(1, performance.now() - t0);
      if (!cancel && (Math.abs(dx) > SWIPE_DIST || (Math.abs(dx) > 40 && speed > 0.6))) {
        decide(dx < 0 ? "unfollow" : "keep", card, dy);
        return;
      }
      setPos(card, 0, 0);
      if (!cancel && !moved) {
        const a = card.querySelector("a.scard-open");
        if (a) a.click();
      }
    }
    card.addEventListener("pointerup", function (e) { end(e, false); });
    card.addEventListener("pointercancel", function (e) { end(e, true); });
  }

  function renderDeck(enterDir) {
    const deck = $("deck");
    const empty = $("deck-empty");
    const q = queue();
    deck.textContent = "";
    $("btn-undo").disabled = !history.length;
    $("btn-no").disabled = !q.length;
    $("btn-yes").disabled = !q.length;

    const total = notback.length;
    $("progress").textContent = q.length ? "Noch " + fmt(q.length) + " von " + fmt(total) : "";

    if (!q.length) {
      deck.hidden = true;
      empty.hidden = false;
      empty.textContent = "";
      if (!stats && !total) {
        empty.appendChild(el("p", "", "Lade unten deinen Instagram-Export, um loszulegen."));
      } else if (!total) {
        empty.appendChild(el("p", "big", "🎉"));
        empty.appendChild(el("p", "", "Alle, denen du folgst, folgen dir zurück."));
      } else {
        empty.appendChild(el("p", "big", "🎉"));
        empty.appendChild(el("p", "", "Alle durchgeswipt."));
        const open = openUnfollowCount();
        if (needsBackup()) {
          empty.appendChild(el("p", "muted", "Speichere jetzt ein Backup, damit deine Entscheide beim nächsten Export noch da sind."));
          const bb = el("button", "btn btn-primary", "💾 Backup speichern");
          bb.type = "button";
          bb.addEventListener("click", saveBackup);
          empty.appendChild(bb);
          if (open) {
            const b2 = el("button", "btn btn-ghost", "Danach zu «Entfolgen» (" + fmt(open) + ")");
            b2.type = "button";
            b2.addEventListener("click", function () { setView("unfollow"); });
            empty.appendChild(b2);
          }
        } else if (open) {
          empty.appendChild(el("p", "muted", "Jetzt unter «Entfolgen» die Profile öffnen und in Instagram entfolgen."));
          const b = el("button", "btn btn-primary", "Zu «Entfolgen» (" + fmt(open) + ")");
          b.type = "button";
          b.addEventListener("click", function () { setView("unfollow"); });
          empty.appendChild(b);
        } else {
          empty.appendChild(el("p", "muted", "Beim nächsten Export siehst du hier nur neue Leute."));
        }
      }
      return;
    }

    deck.hidden = false;
    empty.hidden = true;
    const n = Math.min(3, q.length);
    for (let i = n - 1; i >= 0; i--) deck.appendChild(makeCard(q[i], i));
    const top = deck.lastChild;
    attachDrag(top);

    if (enterDir) {
      animating = true;
      top.classList.add("dragging");
      setPos(top, enterDir * (window.innerWidth + 200), 0);
      void top.offsetWidth;
      top.classList.remove("dragging");
      setPos(top, 0, 0);
      setTimeout(function () { animating = false; }, 260);
    }
  }

  function decide(kind, card, dy) {
    if (animating || view !== "swipe") return;
    const q = queue();
    if (!q.length) return;
    const r = q[0];
    const k = key(r.u);
    card = card || $("deck").lastChild;
    const rec = { u: r.u, t: r.t || 0, at: Date.now() };
    if (kind === "keep") keep[k] = rec;
    else unfollow[k] = Object.assign(rec, { done: false });
    history.push({ k: k, kind: kind });
    if (history.length > 200) history.shift();
    bump();
    save();
    askPersist();
    updateCounts();

    animating = true;
    const dir = kind === "keep" ? 1 : -1;
    if (card) {
      card.classList.remove("dragging");
      card.classList.add("fly");
      setPos(card, dir * (window.innerWidth + 300), dy || 0);
    }
    setTimeout(function () { animating = false; renderDeck(); }, 250);
  }

  function undo() {
    if (animating) return;
    const h = history.pop();
    if (!h) return;
    delete keep[h.k];
    delete unfollow[h.k];
    bump();
    save();
    updateCounts();
    renderDeck(h.kind === "keep" ? 1 : -1);
  }

  // ---------------------------------------------------------------------------
  // Listen «Entfolgen» und «Behalten»
  // ---------------------------------------------------------------------------
  const DESCS = {
    unfollow: "Diese Konten willst du entfolgen. Tippe auf einen Namen, entfolge im Profil (Gefolgt → Nicht mehr folgen). Zurück hier ist der Eintrag abgehakt. Mit ♥ doch behalten.",
    keep: "Diese Konten folgen dir nicht zurück, du folgst ihnen aber gerne weiter. Sie kommen auch bei neuen Exporten nicht mehr zum Swipen. Mit ✕ doch entfolgen."
  };

  function openUnfollowCount() {
    let n = 0;
    for (const k in unfollow) if (!unfollow[k].done) n++;
    return n;
  }

  function listRows() {
    const src = view === "keep" ? keep : unfollow;
    const q = $("search").value.trim().toLowerCase().replace(/^@/, "");
    const hide = view === "unfollow" && $("hide-done").checked;
    return Object.keys(src).map(function (k) { return Object.assign({ k: k }, src[k]); })
      .filter(function (r) {
        if (q && r.k.indexOf(q) === -1) return false;
        if (hide && r.done) return false;
        return true;
      })
      .sort(sorter($("sort").value));
  }

  function renderList(reset) {
    const list = $("list");
    const empty = $("empty");
    const rows = listRows();
    if (reset) { list.textContent = ""; shown = 0; }
    const old = list.querySelector(".more");
    if (old) old.remove();

    const src = view === "keep" ? keep : unfollow;
    const total = Object.keys(src).length;
    let desc = DESCS[view];
    if (view === "unfollow" && total) {
      const doneCount = total - openUnfollowCount();
      if (doneCount) desc += " (" + fmt(doneCount) + " von " + fmt(total) + " abgehakt)";
    }
    $("desc").textContent = desc;

    if (!rows.length) {
      empty.hidden = false;
      if ($("search").value.trim()) empty.textContent = "Kein Treffer für diese Suche.";
      else if (view === "unfollow" && total) empty.textContent = "Alles abgehakt 🎉";
      else if (view === "unfollow") empty.textContent = "Noch niemand. Wische beim Swipen nach links, um jemanden hier einzutragen.";
      else empty.textContent = "Noch niemand. Wische beim Swipen nach rechts, um jemanden zu behalten.";
      return;
    }
    empty.hidden = true;

    const frag = document.createDocumentFragment();
    const end = Math.min(rows.length, shown + PAGE);
    for (let i = shown; i < end; i++) frag.appendChild(listRow(rows[i]));
    shown = end;
    if (shown < rows.length) {
      const li = el("li", "more");
      const b = el("button", "btn", "Weitere " + fmt(Math.min(PAGE, rows.length - shown)) + " anzeigen (" + fmt(rows.length - shown) + " übrig)");
      b.type = "button";
      b.addEventListener("click", function () { renderList(false); });
      li.appendChild(b);
      frag.appendChild(li);
    }
    list.appendChild(frag);
  }

  function listRow(r) {
    const k = r.k;
    const isUnf = view === "unfollow";
    const li = el("li", "item" + (isUnf && r.done ? " done" : ""));
    const a = el("a", "open");
    a.href = profileUrl(r.u);
    a.target = "_blank";
    a.rel = "noopener noreferrer";
    a.setAttribute("aria-label", "Profil von @" + r.u + " in Instagram öffnen");
    const av = el("span", "avatar", r.u.replace(/[^a-z0-9]/gi, "").charAt(0) || "@");
    av.style.background = colorFor(k);
    av.setAttribute("aria-hidden", "true");
    const meta = el("span", "meta");
    meta.appendChild(el("span", "uname", "@" + r.u));
    if (r.t) meta.appendChild(el("span", "since", "Du folgst seit " + dateStr(r.t)));
    a.appendChild(av); a.appendChild(meta); a.appendChild(el("span", "chev", "›"));
    li.appendChild(a);

    if (isUnf) {
      a.addEventListener("click", function () { setDone(li, k, true); });
      const c = el("button", "check");
      c.type = "button";
      c.setAttribute("aria-label", "@" + r.u + " als entfolgt abhaken");
      c.setAttribute("aria-pressed", r.done ? "true" : "false");
      c.appendChild(el("span", "", "✓"));
      c.addEventListener("click", function () { setDone(li, k, !(unfollow[k] && unfollow[k].done)); });
      li.appendChild(c);
      const m = el("button", "mini mini-keep", "♥");
      m.type = "button";
      m.title = "Doch behalten";
      m.setAttribute("aria-label", "@" + r.u + " doch behalten");
      m.addEventListener("click", function () { move(k, "keep"); });
      li.appendChild(m);
    } else {
      const m = el("button", "mini mini-no", "✕");
      m.type = "button";
      m.title = "Doch entfolgen";
      m.setAttribute("aria-label", "@" + r.u + " doch entfolgen");
      m.addEventListener("click", function () { move(k, "unfollow"); });
      li.appendChild(m);
    }
    return li;
  }

  function setDone(li, k, on) {
    const e = unfollow[k];
    if (!e) return;
    e.done = on;
    bump();
    li.classList.toggle("done", on);
    const c = li.querySelector(".check");
    if (c) c.setAttribute("aria-pressed", on ? "true" : "false");
    save();
    updateCounts();
    const total = Object.keys(unfollow).length;
    const doneCount = total - openUnfollowCount();
    $("desc").textContent = DESCS.unfollow + (doneCount ? " (" + fmt(doneCount) + " von " + fmt(total) + " abgehakt)" : "");
  }

  function move(k, to, silent) {
    const from = to === "keep" ? unfollow : keep;
    const dest = to === "keep" ? keep : unfollow;
    const e = from[k];
    if (!e) return;
    const prev = Object.assign({}, e);
    delete from[k];
    dest[k] = { u: e.u, t: e.t || 0, at: Date.now() };
    if (to === "unfollow") dest[k].done = false;
    bump();
    save();
    updateCounts();
    renderList(true);
    if (!silent) {
      toast("@" + e.u + " → " + (to === "keep" ? "Behalten" : "Entfolgen"), "Rückgängig", function () {
        delete dest[k];
        from[k] = prev;
        bump();
        save();
        updateCounts();
        renderList(true);
      });
    }
  }

  // ---------------------------------------------------------------------------
  // Ansicht
  // ---------------------------------------------------------------------------
  function hasData() {
    return !!stats || notback.length > 0 || Object.keys(keep).length > 0 || Object.keys(unfollow).length > 0;
  }

  function setView(v) {
    view = v;
    document.querySelectorAll(".seg").forEach(function (x) {
      const on = x.getAttribute("data-key") === v;
      x.classList.toggle("active", on);
      x.setAttribute("aria-selected", on ? "true" : "false");
    });
    const isSwipe = v === "swipe";
    $("view-swipe").hidden = !isSwipe;
    $("view-list").hidden = isSwipe;
    $("filters").hidden = isSwipe;
    $("hide-done-wrap").hidden = v !== "unfollow";
    if (isSwipe) renderDeck();
    else { $("search").value = ""; renderList(true); }
    renderBackupBanner();
  }

  function updateCounts() {
    $("c-swipe").textContent = fmt(queue().length);
    $("c-unfollow").textContent = fmt(openUnfollowCount());
    $("c-keep").textContent = fmt(Object.keys(keep).length);

    const s = $("summary");
    s.textContent = "";
    if (stats) {
      [[fmt(stats.following), "Du folgst"], [fmt(stats.followers), "Follower"],
        [fmt(notback.length), "Folgen dir nicht zurück"],
        [new Date(stats.exportAt).toLocaleDateString("de-CH", { day: "numeric", month: "short" }), "Export geladen"]]
        .forEach(function (x) {
          const d = el("div", "stat");
          d.appendChild(el("div", "n", x[0]));
          d.appendChild(el("div", "l", x[1]));
          s.appendChild(d);
        });
    }
    s.hidden = !stats;

    renderBackupBanner();

    const info = $("store-info");
    if (demo) {
      info.textContent = "Beispieldaten: es wird nichts gespeichert.";
    } else {
      info.textContent = "Auf diesem Gerät gespeichert: " + fmt(Object.keys(keep).length) + " behalten, " +
        fmt(Object.keys(unfollow).length) + " zum Entfolgen. Letztes Backup: " +
        (backupAt ? backupDate() : "noch keins") + (backupAt && !changes ? " ✔ alles gesichert" : "") + ".";
      if (!storageOk) info.textContent += " ⚠ Speichern ist in diesem Browser gerade nicht möglich (privater Modus?). Bitte Backup nutzen.";
    }
  }

  function decisionCount() { return Object.keys(keep).length + Object.keys(unfollow).length; }
  function backupDate() { return new Date(backupAt).toLocaleDateString("de-CH", { dateStyle: "medium" }); }
  function needsBackup() { return !demo && decisionCount() > 0 && (!backupAt || changes > 0); }

  function renderBackupBanner() {
    const b = $("backup-banner");
    // Im leeren Swipe-Stapel steht schon ein Backup-Knopf
    if (!needsBackup() || (view === "swipe" && !queue().length)) { b.hidden = true; return; }
    $("backup-banner-text").textContent = !backupAt
      ? "Noch kein Backup. Sichere deine Entscheide, sonst sind sie weg, wenn Safari den Speicher leert."
      : fmt(changes) + (changes === 1 ? " Änderung" : " Änderungen") + " seit dem letzten Backup (" + backupDate() + ").";
    b.hidden = false;
  }

  function renderAll() {
    const has = hasData();
    $("results").hidden = !has;
    $("anleitung").hidden = has && !guideOpen;
    $("show-guide").hidden = !(has && !guideOpen);
    $("demo").hidden = has && !demo;
    $("h-upload").textContent = has && !demo ? "Neuen Export laden" : "Export auswählen";
    updateCounts();
    if (view === "swipe") renderDeck(); else renderList(true);
  }


  // ---------------------------------------------------------------------------
  // Speichern (localStorage) und Backup
  // ---------------------------------------------------------------------------
  function snapshot() {
    return {
      v: 2,
      stats: stats,
      notback: notback.map(function (r) { return [r.u, r.t || 0]; }),
      keep: keep,
      unfollow: unfollow,
      backupAt: backupAt,
      changes: changes
    };
  }

  function save() {
    if (demo) return;
    try {
      localStorage.setItem(STORE_KEY, JSON.stringify(snapshot()));
      storageOk = true;
    } catch (e) {
      if (storageOk) toast("Speichern nicht möglich. Bitte Backup speichern.");
      storageOk = false;
    }
  }

  function askPersist() {
    if (persistAsked || demo) return;
    persistAsked = true;
    try {
      if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(function () {});
    } catch (e) { /* ignorieren */ }
  }

  function cleanDecisions(obj, isUnf) {
    const out = {};
    if (!obj || typeof obj !== "object") return out;
    Object.keys(obj).forEach(function (k) {
      const e = obj[k] || {};
      const u = cleanUser(e.u || k);
      if (!USER_RE.test(u)) return;
      const rec = { u: u, t: Number(e.t) || 0, at: Number(e.at) || 0 };
      if (isUnf) rec.done = !!e.done;
      out[key(u)] = rec;
    });
    return out;
  }

  function cleanNotback(arr) {
    const out = [];
    const seen = new Set();
    (Array.isArray(arr) ? arr : []).forEach(function (x) {
      const u = cleanUser(Array.isArray(x) ? x[0] : x && x.u);
      if (!USER_RE.test(u) || seen.has(key(u))) return;
      seen.add(key(u));
      out.push({ u: u, t: Number(Array.isArray(x) ? x[1] : x.t) || 0 });
    });
    return out;
  }

  function cleanStats(s) {
    if (!s || typeof s !== "object") return null;
    return { following: Number(s.following) || 0, followers: Number(s.followers) || 0, exportAt: Number(s.exportAt) || 0 };
  }

  function restore() {
    let raw = null, old = null;
    try { raw = localStorage.getItem(STORE_KEY); old = localStorage.getItem(OLD_KEY); }
    catch (e) { storageOk = false; return; }

    if (raw) {
      try {
        const d = JSON.parse(raw);
        if (d && d.v === 2) {
          stats = cleanStats(d.stats);
          notback = cleanNotback(d.notback);
          keep = cleanDecisions(d.keep, false);
          unfollow = cleanDecisions(d.unfollow, true);
          backupAt = Number(d.backupAt) || 0;
          changes = Number(d.changes) || 0;
        }
      } catch (e) { /* defekte Daten ignorieren */ }
    } else if (old) {
      // Übernahme aus der alten Version (followcheck.v1)
      try {
        const d = JSON.parse(old);
        const unpack = function (arr) { const m = new Map(); (arr || []).forEach(function (x) { add(m, x[0], x[1]); }); return m; };
        const fing = unpack(d.following), fers = unpack(d.followers);
        if (fing.size) {
          fing.forEach(function (v, k) { if (!fers.has(k)) notback.push({ u: v.u, t: v.t || 0 }); });
          stats = { following: fing.size, followers: fers.size, exportAt: Number(d.savedAt) || Date.now() };
          const nbKeys = new Set(notback.map(function (r) { return key(r.u); }));
          (d.done || []).forEach(function (k) {
            const r = notback.find(function (x) { return key(x.u) === k; });
            if (r && nbKeys.has(k)) unfollow[k] = { u: r.u, t: r.t, at: Date.now(), done: true };
          });
          save();
        }
      } catch (e) { /* ignorieren */ }
      try { localStorage.removeItem(OLD_KEY); } catch (e) { /* ignorieren */ }
    }
  }

  function saveBackup() {
    if (demo) { toast("Beispieldaten werden nicht gesichert"); return; }
    backupAt = Date.now();
    changes = 0;
    save();
    const data = Object.assign({ app: "follow-check", exportedAt: new Date(backupAt).toISOString() }, snapshot());
    delete data.changes;
    const blob = new Blob([JSON.stringify(data, null, 1)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "follow-check-backup-" + new Date(backupAt).toISOString().slice(0, 10) + ".json";
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 4000);
    updateCounts();
    if (view === "swipe" && !queue().length) renderDeck();
    toast("Backup gespeichert (Dateien → Downloads)");
  }

  function importBackup(d) {
    if (!d || d.app !== "follow-check") throw new Error("Das ist keine Follow-Check-Backup-Datei.");
    if (demo) { demo = false; keep = {}; unfollow = {}; notback = []; stats = null; backupAt = 0; changes = 0; }
    const wasEmpty = !Object.keys(keep).length && !Object.keys(unfollow).length;
    const k2 = cleanDecisions(d.keep, false);
    const u2 = cleanDecisions(d.unfollow, true);
    let taken = 0;
    function take(src, isKeep) {
      Object.keys(src).forEach(function (k) {
        const cur = keep[k] || unfollow[k];
        if (cur && (cur.at || 0) >= (src[k].at || 0)) return;
        delete keep[k]; delete unfollow[k];
        (isKeep ? keep : unfollow)[k] = src[k];
        taken++;
      });
    }
    take(k2, true);
    take(u2, false);
    if (!notback.length && !stats) {
      notback = cleanNotback(d.notback);
      stats = cleanStats(d.stats);
    } else if (notback.length) {
      // Einträge, die im aktuellen Export nicht mehr vorkommen, sind erledigt
      const nbKeys = new Set(notback.map(function (r) { return key(r.u); }));
      Object.keys(unfollow).forEach(function (k) { if (!nbKeys.has(k)) delete unfollow[k]; });
    }
    backupAt = Math.max(backupAt, Number(d.backupAt) || 0);
    if (wasEmpty) changes = 0;
    history.length = 0;
    save();
    renderAll();
    toast("Backup geladen: " + fmt(taken) + " Entscheide übernommen");
    $("results").scrollIntoView({ behavior: "smooth", block: "start" });
    return taken;
  }

  async function loadBackupFile(file) {
    if (!file) return;
    try {
      const d = JSON.parse((await file.text()).replace(/^﻿/, ""));
      importBackup(d);
    } catch (e) {
      toast(e && e.message && /Backup/.test(e.message) ? e.message : "Backup konnte nicht gelesen werden");
    }
    $("backup-file").value = "";
  }

  let resetTimer = 0;
  function resetClick() {
    const b = $("reset");
    if (!resetTimer) {
      b.textContent = "Wirklich alles löschen?";
      b.classList.add("armed");
      resetTimer = setTimeout(disarmReset, 4000);
      return;
    }
    disarmReset();
    resetAll();
  }
  function disarmReset() {
    clearTimeout(resetTimer);
    resetTimer = 0;
    $("reset").textContent = "Alles löschen";
    $("reset").classList.remove("armed");
  }

  function resetAll() {
    following = null; followers = null;
    notback = []; stats = null; keep = {}; unfollow = {}; backupAt = 0; changes = 0;
    history.length = 0; demo = false; guideOpen = false;
    try { localStorage.removeItem(STORE_KEY); localStorage.removeItem(OLD_KEY); } catch (e) { /* ignorieren */ }
    $("import-note").hidden = true;
    clearStatus();
    setView("swipe");
    renderAll();
    $("upload").scrollIntoView({ behavior: "smooth", block: "start" });
    toast("Alles gelöscht");
  }

  async function copyList() {
    const rows = view === "swipe" ? queue() : listRows();
    const text = rows.map(function (r) { return "@" + r.u; }).join("\n");
    if (!text) { toast("Liste ist leer"); return; }
    try {
      await navigator.clipboard.writeText(text);
    } catch (e) {
      const ta = document.createElement("textarea");
      ta.value = text; ta.setAttribute("readonly", "");
      document.body.appendChild(ta); ta.select();
      try { document.execCommand("copy"); } catch (e2) { /* ignorieren */ }
      ta.remove();
    }
    toast(fmt(rows.length) + " Usernames kopiert");
  }

  // ---------------------------------------------------------------------------
  // Beispieldaten
  // ---------------------------------------------------------------------------
  function loadDemo() {
    const words = ["alpen", "berg", "see", "stadt", "kaffee", "foto", "reise", "sport", "musik", "kunst", "food", "velo", "ski", "hund", "katze", "zuri", "bern", "basel", "luzern", "tech"];
    let seed = 7;
    const rnd = function () { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
    const pick = function () { return words[Math.floor(rnd() * words.length)]; };
    const name = function (i) { return pick() + (rnd() < .5 ? "_" : ".") + pick() + (rnd() < .6 ? Math.floor(rnd() * 99) : "") + (i % 7 === 0 ? "_official" : ""); };
    const now = Math.floor(Date.now() / 1000);
    const fing = new Map(), fers = new Map();
    for (let i = 0; i < 140; i++) {
      const u = name(i), t = now - Math.floor(rnd() * 5 * 365 * 86400);
      const r = rnd();
      if (r < .62) { add(fing, u, t); add(fers, u, t - 86400); }
      else if (r < .84) add(fing, u, t);
      else add(fers, u, t);
    }
    clearStatus();
    applyExport(fing, fers, true);
  }

  // ---------------------------------------------------------------------------
  // Hilfsfunktionen
  // ---------------------------------------------------------------------------
  function el(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }
  function fmt(n) { return Number(n).toLocaleString("de-CH"); }
  function dateStr(ts) {
    return new Date(ts * 1000).toLocaleDateString("de-CH", { month: "short", year: "numeric" });
  }
  function colorFor(s) {
    let h = 0;
    for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
    return "hsl(" + (h % 360) + " 62% 52%)";
  }
  function clearStatus() { $("status").textContent = ""; }
  function status(kind, icon, msg) {
    const d = el("div", "line " + kind);
    d.appendChild(el("span", "", icon));
    d.appendChild(el("span", "", msg));
    $("status").appendChild(d);
  }
  let toastTimer = 0;
  let toastAction = null;
  function toast(msg, actionLabel, action) {
    const t = $("toast");
    const btn = $("toast-btn");
    $("toast-msg").textContent = msg;
    toastAction = action || null;
    btn.hidden = !action;
    btn.textContent = actionLabel || "";
    t.classList.toggle("has-action", !!action);
    t.classList.add("show");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { t.classList.remove("show", "has-action"); toastAction = null; }, action ? 4500 : 2200);
  }

  // ---------------------------------------------------------------------------
  // Events
  // ---------------------------------------------------------------------------
  $("file").addEventListener("change", function (e) { handleFiles(e.target.files); });
  $("demo").addEventListener("click", loadDemo);
  $("show-guide").addEventListener("click", function () {
    guideOpen = true;
    renderAll();
    $("anleitung").scrollIntoView({ behavior: "smooth", block: "start" });
  });

  const drop = $("drop");
  ["dragenter", "dragover"].forEach(function (ev) {
    drop.addEventListener(ev, function (e) { e.preventDefault(); drop.classList.add("dragover"); });
  });
  ["dragleave", "drop"].forEach(function (ev) {
    drop.addEventListener(ev, function () { drop.classList.remove("dragover"); });
  });
  drop.addEventListener("drop", function (e) {
    e.preventDefault();
    if (e.dataTransfer && e.dataTransfer.files) handleFiles(e.dataTransfer.files);
  });
  window.addEventListener("dragover", function (e) { e.preventDefault(); });
  window.addEventListener("drop", function (e) { e.preventDefault(); });

  document.querySelectorAll(".seg").forEach(function (b) {
    b.addEventListener("click", function () { setView(b.getAttribute("data-key")); });
  });

  $("btn-no").addEventListener("click", function () { decide("unfollow"); });
  $("btn-yes").addEventListener("click", function () { decide("keep"); });
  $("btn-undo").addEventListener("click", undo);
  $("order").addEventListener("change", function () { renderDeck(); });

  document.addEventListener("keydown", function (e) {
    if ($("results").hidden || view !== "swipe") return;
    const tag = (e.target && e.target.tagName) || "";
    if (/^(INPUT|SELECT|TEXTAREA)$/.test(tag)) return;
    if (e.key === "ArrowLeft") { e.preventDefault(); decide("unfollow"); }
    else if (e.key === "ArrowRight") { e.preventDefault(); decide("keep"); }
    else if (e.key === "Backspace" || ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "z")) { e.preventDefault(); undo(); }
  });

  let searchTimer = 0;
  $("search").addEventListener("input", function () {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(function () { renderList(true); }, 120);
  });
  $("sort").addEventListener("change", function () { renderList(true); });
  $("hide-done").addEventListener("change", function () { renderList(true); });
  $("copy").addEventListener("click", copyList);
  $("reset").addEventListener("click", resetClick);
  $("backup-save").addEventListener("click", saveBackup);
  $("backup-banner-btn").addEventListener("click", saveBackup);
  $("backup-file").addEventListener("change", function (e) { loadBackupFile(e.target.files && e.target.files[0]); });
  $("toast-btn").addEventListener("click", function () {
    const fn = toastAction;
    toastAction = null;
    $("toast").classList.remove("show", "has-action");
    if (fn) fn();
  });

  // Beim Zurückkehren aus Instagram (anderer Tab) Stand aus dem Speicher prüfen
  window.addEventListener("storage", function (e) {
    if (e.key === STORE_KEY && !demo) { restore(); renderAll(); }
  });

  restore();
  renderAll();
})();
