# Kart Telemetry Web App

Single-page web app per visualizzare telemetria kart via BLE direttamente dal browser.

L'app riceve pacchetti JSON da un ESP32, li salva in sessione e li mostra in tempo reale su diverse viste: dashboard, mappa GPS, GG plot, timing, canali e export.

## Cosa fa

- Connessione BLE dal browser all'ESP32
- Visualizzazione live di velocita, heading, G laterale e longitudinale
- Traccia GPS su mappa con colore per velocita o G
- GG plot live con storico e picchi massimi
- Rilevamento giri e settori tramite attraversamento di linee GPS
- Grafici canali nel tempo
- Export sessione in JSON e CSV
- Tema chiaro/scuro salvato in `localStorage`

## Come funziona l'app

Il flusso e semplice:

1. L'ESP32 invia notifiche BLE con un payload JSON.
2. `js/ble.js` si occupa della connessione Bluetooth, decodifica i messaggi e genera eventi `data`.
3. `js/session.js` riceve ogni pacchetto, lo salva e calcola la logica di sessione: giro corrente, best lap, settori, statistiche.
4. `js/app.js` orchestra tutto e inoltra i dati ai vari tab dell'interfaccia.
5. I moduli in `js/tabs/` aggiornano la UI delle singole sezioni.

In pratica:

- ESP32 = acquisizione e pre-processing sensori
- Browser = visualizzazione, analisi giro, UI ed export

## Formato dati atteso via BLE

L'app si aspetta notifiche JSON simili a questa:

```json
{
  "ms": 12345,
  "lat": 45.123456,
  "lon": 9.123456,
  "alt": 15.2,
  "spd": 80.5,
  "hdg": 127.3,
  "fix": 2,
  "ax": 0.02,
  "ay": 0.85,
  "az": 1.01,
  "gz": 15.3,
  "t": 45.2
}
```

Significato campi principali:

- `spd`: velocita in km/h
- `lat`, `lon`: coordinate GPS
- `hdg`: heading in gradi
- `fix`: qualita fix GPS
- `ax`: accelerazione longitudinale in g
- `ay`: accelerazione laterale in g
- `az`: asse verticale in g
- `gz`: yaw rate in gradi al secondo
- `t`: temperatura

Valori `fix` previsti:

- `0` = no fix
- `1` = GPS
- `2` = RTK float
- `3` = RTK fixed

## UUID BLE

UUID di default usati dall'app:

- Service: `91bad492-b950-4226-aa2b-4ede9fa42f59`
- Characteristic: `ca73b3ba-39f6-4ab3-91ae-186dc9577d99`

## Uso rapido

Non serve build, bundler o npm.

1. Apri `index.html` in un browser compatibile con Web Bluetooth.
2. Premi `Connect`.
3. Seleziona il device BLE dell'ESP32.
4. Inizia a ricevere i dati live.
5. Vai nel tab `Map` per impostare finish line e settori.

Nota: Web Bluetooth funziona solo in browser compatibili. Su iPhone si usa tipicamente Bluefy o browser equivalenti con supporto BLE.

## Logica giri e settori

La logica giri e tutta lato browser.

- Nel tab `Map` puoi impostare la finish line cliccando due punti sulla mappa.
- Puoi aggiungere fino a 2 linee settore.
- A ogni nuovo punto GPS, `js/session.js` controlla se il segmento tra punto precedente e punto attuale attraversa una di queste linee.
- Il primo attraversamento della finish line avvia il giro.
- Gli attraversamenti successivi chiudono il giro precedente e aprono quello nuovo.

La configurazione di finish line e settori viene salvata in `localStorage`.

## Struttura del codice

```text
Wep_Page_DataLogger/
├─ index.html
├─ README.md
├─ css/
│  └─ style.css
└─ js/
   ├─ app.js
   ├─ ble.js
   ├─ session.js
   └─ tabs/
      ├─ dashboard.js
      ├─ map.js
      ├─ ggplot.js
      ├─ timing.js
      ├─ channels.js
      └─ export.js
```

## Ruolo dei file principali

### `index.html`

E il punto di ingresso dell'app. Contiene:

- header con stato BLE e statistiche live
- barra tab
- i 6 pannelli principali
- inclusione librerie esterne e script locali

## `css/style.css`

Contiene tutto lo stile dell'app:

- palette colori
- layout responsive
- tema light/dark
- componenti dashboard, tab, sidebar, tabelle, grafici e toast

## `js/ble.js`

Gestisce il collegamento BLE:

- richiesta device
- connessione GATT
- subscribe alle notifiche
- parsing JSON
- dispatch di eventi come `connecting`, `connected`, `disconnected`, `data`, `error`

Espone l'istanza globale:

```js
window.ble
```

## `js/session.js`

E il motore dati della sessione:

- salva tutti i pacchetti ricevuti
- mantiene elenco giri completati
- calcola best lap
- gestisce finish line e settori
- espone statistiche sessione
- salva configurazione pista in `localStorage`

Espone l'istanza globale:

```js
window.session
```

Eventi principali emessi:

- `packet`
- `lapstart`
- `lapcomplete`
- `sector`
- `cleared`

## `js/app.js`

Fa da orchestratore globale:

- gestisce il cambio tab
- collega eventi BLE e sessione alla UI
- aggiorna header e timer live
- inoltra ogni pacchetto ai moduli grafici
- gestisce il tema

## Moduli in `js/tabs/`

Ogni file gestisce un tab specifico.

### `dashboard.js`

Render live di:

- speed gauge su canvas
- bussola
- mini GG plot
- barre G laterale e longitudinale
- valori live sensori

### `map.js`

Gestisce:

- mappa Leaflet
- track GPS live
- marker posizione corrente
- finish line e sector lines
- colorazione traccia per speed o G

### `ggplot.js`

Gestisce il grafico scatter $a_y$ vs $a_x$:

- trail storico
- cerchi 1g, 2g, 3g
- picchi massimi
- filtro live / lap

### `timing.js`

Gestisce:

- tempo giro live
- visualizzazione settori
- tabella lap history
- delta dal best lap

### `channels.js`

Mostra grafici temporali rolling di:

- speed
- lateral G
- longitudinal G

### `export.js`

Permette export di:

- sessione completa JSON
- tutti i campioni CSV
- riepilogo giri CSV

## Librerie usate

- Leaflet per la mappa
- OpenStreetMap come tile source
- Chart.js per GG plot e canali
- Canvas 2D API per gauge e widget custom
- Web Bluetooth API per la connessione BLE

## Stato e persistenza locale

L'app salva nel browser:

- `kart_track_config`: finish line e settori
- `kart_theme`: tema chiaro/scuro

## Note progettuali

Questo progetto e volutamente semplice da distribuire:

- niente framework
- niente build step
- niente dipendenze locali
- pronto per GitHub Pages o hosting statico

L'idea e mantenere il firmware ESP32 focalizzato su acquisizione e filtraggio dati, lasciando al browser tutta la parte di visualizzazione e analisi sessione.