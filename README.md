# Follow-Check

Zeigt, wer dir auf Instagram nicht zurückfolgt. Optimiert fürs iPhone, funktioniert aber auf jedem Gerät.

- Kein Login, kein Passwort, keine API, kein Scraping
- Nutzt nur den **offiziellen Instagram-Datenexport** (ZIP direkt, JSON oder HTML)
- Alles läuft **lokal im Browser**. Per Content-Security-Policy (`connect-src 'none'`) ist technisch ausgeschlossen, dass die Seite Daten verschickt
- Keine Cookies, kein Tracking, keine externen Schriften oder CDNs

## Funktionen

- ZIP-Datei direkt auswählen, kein Entpacken nötig (auch mehrteilige Exporte und `followers_1`, `followers_2` …)
- Drei Listen: *Folgen dir nicht zurück*, *Du folgst nicht zurück*, *Gegenseitig*
- Suche, Sortierung nach Datum, Abhaken beim Entfolgen
- Profil antippen öffnet direkt die Instagram-App
- Liste kopieren oder als CSV speichern
- Optional „Auf diesem Gerät merken" (localStorage, nur nach Opt-in)
- Hell/Dunkel-Modus, Zum-Home-Bildschirm-fähig

## Dateien

```
index.html            Seite mit Anleitung, Upload, Ergebnis, FAQ
app.js                Logik (ZIP-Leser, Parser, Vergleich)
style.css             Design
datenschutz.html      Datenschutzerklärung
icon.svg / *.png      Icons
manifest.webmanifest  Web-App-Manifest
.nojekyll             GitHub Pages ohne Jekyll ausliefern
```

## Auf GitHub Pages veröffentlichen

1. Alle Dateien committen und auf `main` pushen.
2. Im Repository: **Settings → Pages → Build and deployment → Source: Deploy from a branch**, Branch `main`, Ordner `/ (root)`.
3. Nach ca. 1 Minute ist die Seite unter `https://<user>.github.io/<repo>/` erreichbar.

Lokal testen: `python -m http.server` im Ordner starten und `http://localhost:8000` öffnen.

## Hinweis

Privates, nicht-kommerzielles Projekt ohne Verbindung zu Instagram oder Meta. Instagram ist eine Marke der Meta Platforms, Inc.
