/*
 * Follow-Check
 * Wertet den offiziellen Instagram-Datenexport komplett lokal im Browser aus.
 * Es gibt keinen Server-Upload, kein Tracking und keine Netzwerkanfragen
 * (zusätzlich per Content-Security-Policy "connect-src 'none'" erzwungen).
 */
(function () {
  "use strict";

  // ---------------------------------------------------------------------------
  // Zustand
  // ---------------------------------------------------------------------------
  /** @type {Map<string,{u:string,t:number}>|null} */
  let following = null;
  /** @type {Map<string,{u:string,t:number}>|null} */
  let followers = null;
  const done = new Set();
  let current = "notback";
  let shown = 0;
  const PAGE = 150;
  const STORE_KEY = "followcheck.v1";
  const results = { notback: [], fans: [], mutual: [] };

  const $ = (id) => document.getElementById(id);
  const USER_RE = /^[A-Za-z0-9._]{1,30}$/;
  const RESERVED = new Set(["p", "explore", "reel", "reels", "stories", "tv", "accounts",
    "directory", "about", "developer", "legal", "privacy", "terms", "help", "emails",
    "session", "challenge", "web", "direct", "your_activity"]);

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
    let gotFollowing = false, gotFollowers = false;
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
    if (following) status(following.size ? "ok" : "err", following.size ? "✔" : "⚠", following.size ? "Du folgst " + fmt(following.size) + " Konten" : "In der following-Datei wurden keine Konten gefunden.");
    else status("info", "○", "Es fehlt noch: following.json (Konten, denen du folgst)");
    if (followers) status(followers.size ? "ok" : "err", followers.size ? "✔" : "⚠", followers.size ? fmt(followers.size) + " Konten folgen dir" : "In den followers-Dateien wurden keine Konten gefunden.");
    else status("info", "○", "Es fehlt noch: followers_1.json (deine Follower)");
    problems.forEach(function (p) { status("err", "⚠", p); });

    $("file").value = "";
    if (following && followers) {
      done.clear();
      compute(true);
      persist();
    }
  }

  // ---------------------------------------------------------------------------
  // Auswertung & Darstellung
  // ---------------------------------------------------------------------------
  function compute(scroll) {
    const notback = [], fans = [], mutual = [];
    following.forEach(function (v, k) {
      const f = followers.get(k);
      if (f) mutual.push({ u: v.u, t: f.t || 0, t2: v.t || 0 });
      else notback.push({ u: v.u, t: v.t || 0 });
    });
    followers.forEach(function (v, k) {
      if (!following.has(k)) fans.push({ u: v.u, t: v.t || 0 });
    });
    results.notback = notback; results.fans = fans; results.mutual = mutual;

    $("c-notback").textContent = fmt(notback.length);
    $("c-fans").textContent = fmt(fans.length);
    $("c-mutual").textContent = fmt(mutual.length);

    const s = $("summary");
    s.textContent = "";
    [[following.size, "Du folgst"], [followers.size, "Follower"], [notback.length, "Folgen dir nicht zurück"], [mutual.length, "Gegenseitig"]]
      .forEach(function (x) {
        const d = el("div", "stat");
        d.appendChild(el("div", "n", fmt(x[0])));
        d.appendChild(el("div", "l", x[1]));
        s.appendChild(d);
      });

    $("results").hidden = false;
    render(true);
    if (scroll) $("results").scrollIntoView({ behavior: "smooth", block: "start" });
  }

  const DESCS = {
    notback: "Du folgst diesen Konten, sie folgen dir aber nicht zurück. Tippe auf einen Namen, um das Profil in Instagram zu öffnen.",
    fans: "Diese Konten folgen dir, du folgst ihnen aber nicht.",
    mutual: "Ihr folgt euch gegenseitig."
  };
  const SINCE = { notback: "Du folgst seit ", fans: "Folgt dir seit ", mutual: "Folgt dir seit " };

  function filtered() {
    const q = $("search").value.trim().toLowerCase().replace(/^@/, "");
    const hide = $("hide-done").checked;
    const sort = $("sort").value;
    let rows = results[current].filter(function (r) {
      if (q && r.u.toLowerCase().indexOf(q) === -1) return false;
      if (hide && done.has(r.u.toLowerCase())) return false;
      return true;
    });
    rows = rows.slice().sort(function (a, b) {
      if (sort === "new" && a.t !== b.t) return b.t - a.t;
      if (sort === "old" && a.t !== b.t) return (a.t || Infinity) - (b.t || Infinity);
      return a.u.toLowerCase().localeCompare(b.u.toLowerCase());
    });
    return rows;
  }

  function render(reset) {
    const list = $("list");
    const empty = $("empty");
    const rows = filtered();
    if (reset) { list.textContent = ""; shown = 0; }
    const old = list.querySelector(".more");
    if (old) old.remove();

    const total = results[current].length;
    const doneCount = results[current].filter(function (r) { return done.has(r.u.toLowerCase()); }).length;
    $("desc").textContent = DESCS[current] + (current === "notback" && doneCount ? " (" + doneCount + " von " + total + " abgehakt)" : "");

    if (!rows.length) {
      empty.hidden = false;
      empty.textContent = $("search").value.trim() ? "Kein Treffer für diese Suche." :
        (current === "notback" && total && doneCount === total ? "Alles abgehakt 🎉" : "Keine Einträge in dieser Kategorie.");
      return;
    }
    empty.hidden = true;

    const frag = document.createDocumentFragment();
    const end = Math.min(rows.length, shown + PAGE);
    for (let i = shown; i < end; i++) frag.appendChild(row(rows[i]));
    shown = end;
    if (shown < rows.length) {
      const li = el("li", "more");
      const b = el("button", "btn", "Weitere " + fmt(Math.min(PAGE, rows.length - shown)) + " anzeigen (" + fmt(rows.length - shown) + " übrig)");
      b.type = "button";
      b.addEventListener("click", function () { render(false); });
      li.appendChild(b);
      frag.appendChild(li);
    }
    list.appendChild(frag);
  }

  function row(r) {
    const key = r.u.toLowerCase();
    const li = el("li", "item" + (done.has(key) ? " done" : ""));
    const a = el("a", "open");
    a.href = "https://www.instagram.com/" + encodeURIComponent(r.u) + "/";
    a.target = "_blank";
    a.rel = "noopener noreferrer";
    a.setAttribute("aria-label", "Profil von @" + r.u + " in Instagram öffnen");
    const av = el("span", "avatar", r.u.replace(/[^a-z0-9]/gi, "").charAt(0) || "@");
    av.style.background = colorFor(key);
    av.setAttribute("aria-hidden", "true");
    const meta = el("span", "meta");
    meta.appendChild(el("span", "uname", "@" + r.u));
    if (r.t) meta.appendChild(el("span", "since", SINCE[current] + dateStr(r.t)));
    a.appendChild(av); a.appendChild(meta); a.appendChild(el("span", "chev", "›"));
    a.addEventListener("click", function () { setDone(li, key, true); });

    const c = el("button", "check");
    c.type = "button";
    c.setAttribute("aria-label", "@" + r.u + " abhaken");
    c.setAttribute("aria-pressed", done.has(key) ? "true" : "false");
    c.appendChild(el("span", "", "✓"));
    c.addEventListener("click", function () { setDone(li, key, !done.has(key)); });

    li.appendChild(a); li.appendChild(c);
    return li;
  }

  function setDone(li, key, on) {
    if (on) done.add(key); else done.delete(key);
    li.classList.toggle("done", on);
    const c = li.querySelector(".check");
    if (c) c.setAttribute("aria-pressed", on ? "true" : "false");
    persist();
    // Beschreibung (Zähler) aktualisieren, ohne die Liste neu aufzubauen
    const total = results[current].length;
    const doneCount = results[current].filter(function (r) { return done.has(r.u.toLowerCase()); }).length;
    $("desc").textContent = DESCS[current] + (current === "notback" && doneCount ? " (" + doneCount + " von " + total + " abgehakt)" : "");
  }

  // ---------------------------------------------------------------------------
  // Export / Kopieren
  // ---------------------------------------------------------------------------
  const LABEL = { notback: "folgen-dir-nicht-zurueck", fans: "du-folgst-nicht-zurueck", mutual: "gegenseitig" };

  function exportCsv() {
    const rows = filtered();
    const esc = function (s) { return '"' + String(s).replace(/"/g, '""') + '"'; };
    const lines = ["Username;Profil-Link;Seit;Abgehakt"];
    rows.forEach(function (r) {
      lines.push([esc(r.u), esc("https://www.instagram.com/" + r.u + "/"), esc(r.t ? isoDate(r.t) : ""), esc(done.has(r.u.toLowerCase()) ? "ja" : "")].join(";"));
    });
    const blob = new Blob(["﻿" + lines.join("\r\n")], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = "instagram-" + LABEL[current] + ".csv";
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 4000);
  }

  async function copyList() {
    const text = filtered().map(function (r) { return "@" + r.u; }).join("\n");
    if (!text) { toast("Liste ist leer"); return; }
    try {
      await navigator.clipboard.writeText(text);
    } catch (e) {
      const ta = document.createElement("textarea");
      ta.value = text; ta.setAttribute("readonly", "");
      ta.style.position = "fixed"; ta.style.opacity = "0";
      document.body.appendChild(ta); ta.select();
      try { document.execCommand("copy"); } catch (e2) { /* ignorieren */ }
      ta.remove();
    }
    toast(filtered().length + " Usernames kopiert");
  }

  // ---------------------------------------------------------------------------
  // Optional: lokal auf dem Gerät merken (nur wenn aktiv gewählt)
  // ---------------------------------------------------------------------------
  function persist() {
    if (!$("remember").checked || !following || !followers) return;
    const pack = function (m) { const a = []; m.forEach(function (v) { a.push([v.u, v.t]); }); return a; };
    try {
      localStorage.setItem(STORE_KEY, JSON.stringify({
        v: 1, savedAt: Date.now(), following: pack(following), followers: pack(followers), done: Array.from(done)
      }));
    } catch (e) { /* Speicher nicht verfügbar, z. B. privater Modus */ }
  }
  function forget() {
    try { localStorage.removeItem(STORE_KEY); } catch (e) { /* ignorieren */ }
  }
  function restore() {
    let raw = null;
    try { raw = localStorage.getItem(STORE_KEY); } catch (e) { return; }
    if (!raw) return;
    try {
      const d = JSON.parse(raw);
      if (!d || d.v !== 1) return;
      const unpack = function (arr) { const m = new Map(); (arr || []).forEach(function (x) { add(m, x[0], x[1]); }); return m; };
      following = unpack(d.following);
      followers = unpack(d.followers);
      (d.done || []).forEach(function (k) { done.add(k); });
      $("remember").checked = true;
      clearStatus();
      status("ok", "✔", "Gespeicherte Auswertung vom " + new Date(d.savedAt).toLocaleString("de-CH", { dateStyle: "medium", timeStyle: "short" }) + " geladen.");
      compute(false);
    } catch (e) { forget(); }
  }

  function resetAll() {
    following = null; followers = null; done.clear();
    results.notback = []; results.fans = []; results.mutual = [];
    forget();
    $("remember").checked = false;
    $("search").value = "";
    $("list").textContent = "";
    $("results").hidden = true;
    clearStatus();
    $("upload").scrollIntoView({ behavior: "smooth", block: "start" });
    toast("Alles zurückgesetzt");
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
    following = new Map(); followers = new Map();
    for (let i = 0; i < 140; i++) {
      const u = name(i), t = now - Math.floor(rnd() * 5 * 365 * 86400);
      const r = rnd();
      if (r < .62) { add(following, u, t); add(followers, u, t - 86400); }
      else if (r < .84) add(following, u, t);
      else add(followers, u, t);
    }
    done.clear();
    clearStatus();
    status("info", "ℹ", "Das sind erfundene Beispieldaten. Lade deinen eigenen Export, um dein echtes Ergebnis zu sehen.");
    $("remember").checked = false;
    forget();
    compute(true);
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
  function isoDate(ts) { return new Date(ts * 1000).toISOString().slice(0, 10); }
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
  function toast(msg) {
    const t = $("toast");
    t.textContent = msg;
    t.classList.add("show");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { t.classList.remove("show"); }, 2200);
  }

  // ---------------------------------------------------------------------------
  // Events
  // ---------------------------------------------------------------------------
  $("file").addEventListener("change", function (e) { handleFiles(e.target.files); });
  $("demo").addEventListener("click", loadDemo);

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
  // Verhindern, dass der Browser eine danebengezogene Datei öffnet
  window.addEventListener("dragover", function (e) { e.preventDefault(); });
  window.addEventListener("drop", function (e) { e.preventDefault(); });

  document.querySelectorAll(".seg").forEach(function (b) {
    b.addEventListener("click", function () {
      document.querySelectorAll(".seg").forEach(function (x) {
        x.classList.toggle("active", x === b);
        x.setAttribute("aria-selected", x === b ? "true" : "false");
      });
      current = b.getAttribute("data-key");
      render(true);
    });
  });

  let searchTimer = 0;
  $("search").addEventListener("input", function () {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(function () { render(true); }, 120);
  });
  $("sort").addEventListener("change", function () { render(true); });
  $("hide-done").addEventListener("change", function () { render(true); });
  $("export").addEventListener("click", exportCsv);
  $("copy").addEventListener("click", copyList);
  $("reset").addEventListener("click", resetAll);
  $("remember").addEventListener("change", function (e) {
    if (e.target.checked) { persist(); toast("Wird auf diesem Gerät gemerkt"); }
    else { forget(); toast("Gespeicherte Daten gelöscht"); }
  });

  restore();
})();
