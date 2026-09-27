# Riconoscere il nome senza il cloud

Perché oggi l'ascolto continuo costa, cosa servirebbe per non farlo costare
più, e perché non lo facciamo adesso. Scritto per S48; da rivedere quando
cambia una delle cose elencate in fondo.

## Cosa costa, oggi

Il rilevatore locale decide solo *se qualcuno sta parlando*, non *cosa dice*.
Per sapere se la frase comincia col nome bisogna trascriverla, e la
trascrizione è nel cloud: 1,5 s di audio per ogni frase sentita.

Misurato il 2026-09-17 con chiamate vere a OpenRouter
(`microsoft/mai-transcribe-2`):

| Voce | Valore |
|---|---|
| Prezzo | 0,0000278 $ al secondo di audio |
| Minimo fatturato | 2 s, quindi 0,0000556 $ a controllo del nome |
| Stanza silenziosa | 0 chiamate all'ora: senza voce non parte niente |
| Televisione o parlato | circa 332 chiamate all'ora, cioè 0,018 $/h |
| Lavoro normale | circa 21 chiamate all'ora, cioè 0,0012 $/h |

Le chiamate all'ora vengono da un'ora simulata con il rilevatore vero
(`packages/voice/src/audio/level.ts`), non da una stanza registrata: servono a
dare l'ordine di grandezza, non la cifra esatta.

## Cosa servirebbe

Un riconoscitore del nome che gira sulla macchina e sente solo «nik»: non una
trascrizione completa, una parola sola. Sono modelli piccoli, decine di MB, con
una soglia da tarare, e girano in continuazione sul flusso del microfono.

Il costo non è il modello, è dove lo si fa girare.

- **Nella webview non ci sta.** Misurato l'11 settembre 2026 con Parakeet
  (0,6B): il renderer arriva a 4,2 GB e smette di rispondere, sia con WebGPU
  sia con WASM. Un modello da parola sola è molto più piccolo, ma resta il
  fatto che la webview è il posto sbagliato: niente thread condivisi senza
  isolamento cross-origin, e l'audio già passa dal thread principale.
- **In un processo a parte si può.** È la strada giusta: un processo nativo che
  tiene il microfono, riconosce il nome e sveglia la webview solo quando lo
  sente. Vuol dire però un componente nativo per piattaforma, il microfono
  spostato fuori dalla webview, e le prove su tre sistemi operativi. Non è il
  lavoro di un pomeriggio.
- **Ci sono modelli pronti** (per esempio openWakeWord, Porcupine): uno è
  Apache-2.0 con modelli da addestrare, l'altro ha una licenza che va letta
  prima di legarci ADE. Va scelto guardando anche la licenza, non solo la
  qualità.

## Perché oggi non si fa

Con l'ascolto continuo spento di serie (S48), la spesa in sottofondo è zero
finché l'utente non la chiede: il problema urgente è risolto senza toccare il
riconoscimento. Il riconoscimento locale serve a chi *vuole* l'ascolto sempre
attivo e non vuole pagarlo, ed è una cosa sola con lo spostare la cattura audio
fuori dalla webview.

## Quando riaprirlo

- Se l'utente chiede l'ascolto sempre attivo come modo normale di lavorare.
- Se l'audio esce dalla webview per altri motivi: metà del lavoro sarebbe già
  fatta.
- Se esce un riconoscitore da parola sola che gira nella webview in pochi MB e
  senza thread dedicati.
