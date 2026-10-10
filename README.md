# Follow-Check

Zeigt, wer dir auf Instagram nicht zurückfolgt, und lässt dich per Swipe entscheiden: links = entfolgen, rechts = behalten. Optimiert fürs iPhone, funktioniert aber auf jedem Gerät.

- Kein Login, kein Passwort, keine API, kein Scraping
- Nutzt nur den **offiziellen Instagram-Datenexport** (ZIP direkt, JSON oder HTML)
- Alles läuft **lokal im Browser**. Per Content-Security-Policy (`connect-src 'none'`) ist technisch ausgeschlossen, dass die Seite Daten verschickt
- Keine Cookies, kein Tracking, keine externen Schriften oder CDNs

## Funktionen

- ZIP-Datei direkt auswählen, kein Entpacken nötig (auch mehrteilige Exporte und `followers_1`, `followers_2` …)
- Zeigt nur Konten, denen du folgst, die dir aber nicht zurückfolgen
- Swipen wie bei Tinder (Touch, Maus, Pfeiltasten) oder per Knopf ✕ / ♥, mit Rückgängig
- Listen *Entfolgen* (zum Abhaken beim Entfolgen) und *Behalten*
- Entscheide werden im localStorage gespeichert (`followcheck.v2`). Beim nächsten Export kommen Behaltene nicht mehr zum Swipen, Entfolgte verschwinden automatisch
- Backup der Entscheide als JSON-Datei speichern und wieder laden (wird zusammengeführt)
- Profil antippen öffnet direkt die Instagram-App
- Hell/Dunkel-Modus, Zum-Home-Bildschirm-fähig

## Backup (empfohlen)

Safari löscht den localStorage einer Seite, wenn sie eine Weile nicht geöffnet wird. Darum ist das Backup der sichere Stand:

1. Nach dem Swipen *Backup speichern* (Datei `follow-check-backup-JJJJ-MM-TT.json`, landet in Dateien → Downloads).
2. Beim nächsten Export die neue ZIP-Datei und das Backup zusammen auswählen.

Die Seite erinnert mit einem Hinweis, solange es ungesicherte Änderungen gibt. Beim Laden wird zusammengeführt, der neuere Entscheid gewinnt.

## Dateien

```
index.html            Seite mit Anleitung, Upload, Ergebnis, FAQ
app.js                Logik (ZIP-Leser, Parser, Swipe, Speicher, Backup)
style.css             Design
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

Privates Tool für den Eigengebrauch, ohne Verbindung zu Instagram oder Meta. Wird nicht von Suchmaschinen indexiert.
