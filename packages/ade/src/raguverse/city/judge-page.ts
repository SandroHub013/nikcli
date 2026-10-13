/**
 * The page the bench's pictures are judged on: one HTML file with everything in it (the JPEGs are embedded, the clips
 * are links), no network. For each of the eight shots a slider between «prima» and «dopo», the switch between Bassa and
 * Media, three buttons (peggio, uguale, meglio, always of the «dopo» against the «prima»), the numbers of the gate next
 * to them, «È tripla A?» with a note, and the answers as JSON in a box to copy and as a file to save (no clipboard: the
 * webview asks a permission for it and hangs).
 *
 * «Alla cieca» hides the labels and puts the two pictures of each shot on a random side, from a seed; the buttons
 * always speak of the «dopo», so the answers need no mapping back. A piece is closed with «meglio» on at least six of the eight
 * and no «peggio» (the plan's rule): the page says so as the buttons are pressed.
 */

export interface JudgeShot {
  n: number
  name: string
  /** What the shot is for, in a line. */
  about: string
}

export interface JudgeImage {
  level: string
  n: number
  /** A `data:image/jpeg;base64,…` address. */
  before: string
  after: string
}

export interface JudgeNumber {
  name: string
  before?: string
  after?: string
  /** Whether the «dopo» passes; absent when it is only a number. */
  ok?: boolean
}

export interface JudgeData {
  title: string
  /** Where the blind order comes from. */
  seed: number
  generated: string
  levels: string[]
  shots: JudgeShot[]
  images: JudgeImage[]
  /** The gate's numbers and the automatic checks, side by side. */
  numbers: JudgeNumber[]
  /** Clips by level: paths relative to the page. */
  clips?: Record<string, { before?: string; after?: string }>
}

export type Verdict = "peggio" | "uguale" | "meglio"

/** Which side the «prima» is on for shot `n`, blind: 0 = left, 1 = right. Deterministic from the seed. */
export function beforeSide(seed: number, n: number): 0 | 1 {
  let a = (seed * 2654435761 + n * 40503) >>> 0
  // mulberry32, one step
  a = (a + 0x6d2b79f5) >>> 0
  let t = a
  t = Math.imul(t ^ (t >>> 15), t | 1)
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
  return (((t ^ (t >>> 14)) >>> 0) & 1) as 0 | 1
}

/** What the answers say: the counts, and whether the piece is closed (six «meglio» of eight and no «peggio»). */
export function summarize(
  verdicts: Record<string, string | undefined>,
  total: number,
): { meglio: number; uguale: number; peggio: number; unanswered: number; closed: boolean } {
  let meglio = 0
  let uguale = 0
  let peggio = 0
  let answered = 0
  for (const key of Object.keys(verdicts)) {
    const v = verdicts[key]
    if (v === "meglio") meglio++
    else if (v === "uguale") uguale++
    else if (v === "peggio") peggio++
    else continue
    answered++
  }
  return { meglio, uguale, peggio, unanswered: Math.max(0, total - answered), closed: meglio >= 6 && peggio === 0 }
}

const escapeHtml = (text: string) =>
  text.replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] as string,
  )

/** JSON that is safe inside a `<script>`: no `</script>`, no `<!--`, no line separators. */
const scriptJson = (value: unknown) =>
  JSON.stringify(value)
    .replace(/</g, "\\u003c")
    .replace(new RegExp(String.fromCharCode(0x2028), "g"), "\\u2028")
    .replace(new RegExp(String.fromCharCode(0x2029), "g"), "\\u2029")

const CSS = `
:root { --bg:#f6f7f9; --fg:#14171c; --muted:#5b6472; --card:#fff; --line:#d5d9e0; --accent:#0a7fb3; --good:#1a8a4a; --bad:#c23a3a; color-scheme: light dark; }
@media (prefers-color-scheme: dark) { :root:not([data-theme="light"]) { --bg:#0e1116; --fg:#e6e9ee; --muted:#98a1ae; --card:#171b22; --line:#2b323d; --accent:#43b8ee; --good:#4bc380; --bad:#ff7a7a; } }
:root[data-theme="dark"] { --bg:#0e1116; --fg:#e6e9ee; --muted:#98a1ae; --card:#171b22; --line:#2b323d; --accent:#43b8ee; --good:#4bc380; --bad:#ff7a7a; }
* { box-sizing: border-box; }
body { margin:0; background:var(--bg); color:var(--fg); font:15px/1.5 system-ui, "Segoe UI", sans-serif; }
main { max-width:1100px; margin:0 auto; padding:16px; }
h1 { font-size:22px; margin:8px 0 4px; } h2 { font-size:17px; margin:0 0 4px; }
p.lead { color:var(--muted); margin:0 0 12px; }
.bar { display:flex; flex-wrap:wrap; gap:8px 16px; align-items:center; padding:10px 12px; background:var(--card); border:1px solid var(--line); border-radius:10px; position:sticky; top:0; z-index:5; }
.tabs button, .verdicts button, .yn button { font:inherit; padding:6px 14px; border:1px solid var(--line); background:var(--card); color:var(--fg); border-radius:8px; cursor:pointer; }
.tabs button[aria-pressed="true"], .verdicts button[aria-pressed="true"], .yn button[aria-pressed="true"] { background:var(--accent); color:#fff; border-color:var(--accent); }
.verdicts button[data-v="peggio"][aria-pressed="true"] { background:var(--bad); border-color:var(--bad); }
.verdicts button[data-v="meglio"][aria-pressed="true"] { background:var(--good); border-color:var(--good); }
.count { margin-left:auto; color:var(--muted); font-variant-numeric:tabular-nums; }
.count b.closed { color:var(--good); }
section.shot { background:var(--card); border:1px solid var(--line); border-radius:12px; padding:12px; margin:14px 0; }
.about { color:var(--muted); margin:0 0 8px; }
.compare { position:relative; aspect-ratio:16/9; background:#000; border-radius:8px; overflow:hidden; touch-action:none; }
.compare img { position:absolute; inset:0; width:100%; height:100%; object-fit:contain; display:block; }
.compare .top { clip-path: inset(0 0 0 50%); }
.compare .cut { position:absolute; top:0; bottom:0; width:2px; background:#fff; box-shadow:0 0 0 1px rgba(0,0,0,.5); left:50%; pointer-events:none; }
.compare .tag { position:absolute; top:8px; padding:2px 8px; border-radius:6px; background:rgba(0,0,0,.6); color:#fff; font-size:13px; }
.compare .tag.l { left:8px; } .compare .tag.r { right:8px; }
.blind .tag { display:none; }
input[type=range] { width:100%; margin:8px 0 4px; }
.verdicts { display:flex; flex-wrap:wrap; gap:8px; align-items:center; margin-top:6px; }
table { border-collapse:collapse; width:100%; font-variant-numeric:tabular-nums; }
td, th { text-align:left; padding:5px 8px; border-bottom:1px solid var(--line); vertical-align:top; }
td.ok { color:var(--good); } td.no { color:var(--bad); font-weight:600; }
textarea { width:100%; font:13px/1.4 ui-monospace, Consolas, monospace; background:var(--bg); color:var(--fg); border:1px solid var(--line); border-radius:8px; padding:8px; }
a { color:var(--accent); }
label.blindbox { display:flex; gap:6px; align-items:center; }
@media (max-width:600px) { .count { margin-left:0; } }
`

/** The page's own code. `beforeSide` and `summarize` are the tested functions, copied in as they are. */
const script = () => `
${beforeSide.toString()}
${summarize.toString()}
(function () {
  var data = JSON.parse(document.getElementById("data").textContent);
  var KEY = "nikverse-judge-" + data.seed;
  var state = { level: data.levels[0], blind: false, verdicts: {}, tripleA: null, note: "" };
  try { var saved = JSON.parse(localStorage.getItem(KEY) || "null"); if (saved) { state.verdicts = saved.verdicts || {}; state.tripleA = saved.tripleA || null; state.note = saved.note || ""; state.blind = !!saved.blind; } } catch (e) {}
  var lastUrl;
  function save() { try { localStorage.setItem(KEY, JSON.stringify(state)); } catch (e) {} }
  function imageOf(level, n) { for (var i = 0; i < data.images.length; i++) if (data.images[i].level === level && data.images[i].n === n) return data.images[i]; return null; }
  function el(id) { return document.getElementById(id); }

  function draw() {
    document.body.classList.toggle("blind", state.blind);
    var buttons = document.querySelectorAll(".tabs button");
    for (var b = 0; b < buttons.length; b++) buttons[b].setAttribute("aria-pressed", String(buttons[b].dataset.level === state.level));
    data.shots.forEach(function (shot) {
      var img = imageOf(state.level, shot.n);
      var box = el("cmp-" + shot.n);
      if (!img) { box.style.display = "none"; return; }
      box.style.display = "";
      // Left is the bottom picture, right the top one, revealed from the cut on.
      var beforeLeft = !state.blind || beforeSide(data.seed, shot.n) === 0;
      var left = beforeLeft ? img.before : img.after;
      var right = beforeLeft ? img.after : img.before;
      el("l-" + shot.n).src = left;
      el("r-" + shot.n).src = right;
      el("tl-" + shot.n).textContent = beforeLeft ? "prima" : "dopo";
      el("tr-" + shot.n).textContent = beforeLeft ? "dopo" : "prima";
      for (var v = 0; v < 3; v++) {
        var btn = el("v-" + shot.n + "-" + v);
        btn.setAttribute("aria-pressed", String(state.verdicts[shot.n] === btn.dataset.v));
      }
    });
    var clip = data.clips && data.clips[state.level];
    el("clips").innerHTML = clip ? "Clip di 10 s a " + state.level + ": " + (clip.before ? '<a href="' + clip.before + '">prima</a>' : "") + (clip.before && clip.after ? " · " : "") + (clip.after ? '<a href="' + clip.after + '">dopo</a>' : "") : "";
    var yn = document.querySelectorAll(".yn button");
    for (var y = 0; y < yn.length; y++) yn[y].setAttribute("aria-pressed", String(state.tripleA === yn[y].dataset.a));
    var s = summarize(state.verdicts, data.shots.length);
    el("count").innerHTML = "meglio <b>" + s.meglio + "</b> · uguale <b>" + s.uguale + "</b> · peggio <b>" + s.peggio + "</b>" + (s.unanswered ? " · da giudicare " + s.unanswered : "") + " — " + (s.closed ? '<b class="closed">pezzo chiuso</b>' : "serve «meglio» su 6 e nessun «peggio»");
    el("note").value = state.note;
    el("blind").checked = state.blind;
    el("out").value = JSON.stringify(result(), null, 2);
    try {
      if (lastUrl) URL.revokeObjectURL(lastUrl);
      lastUrl = URL.createObjectURL(new Blob([el("out").value], { type: "application/json" }));
      el("save").href = lastUrl;
    } catch (e) {}
  }
  function result() {
    var s = summarize(state.verdicts, data.shots.length);
    return {
      page: data.title, generated: data.generated, seed: data.seed, blind: state.blind,
      verdicts: data.shots.map(function (shot) { return { shot: shot.n, name: shot.name, verdict: state.verdicts[shot.n] || null }; }),
      counts: { meglio: s.meglio, uguale: s.uguale, peggio: s.peggio, unanswered: s.unanswered },
      closed: s.closed, tripleA: state.tripleA, note: state.note
    };
  }
  data.shots.forEach(function (shot) {
    var range = el("cut-" + shot.n);
    range.addEventListener("input", function () {
      var p = range.value + "%";
      el("r-" + shot.n).style.clipPath = "inset(0 0 0 " + p + ")";
      el("bar-" + shot.n).style.left = p;
    });
    for (var v = 0; v < 3; v++) (function (btn) {
      btn.addEventListener("click", function () { state.verdicts[shot.n] = btn.dataset.v; save(); draw(); });
    })(el("v-" + shot.n + "-" + v));
  });
  document.querySelectorAll(".tabs button").forEach(function (b) { b.addEventListener("click", function () { state.level = b.dataset.level; save(); draw(); }); });
  document.querySelectorAll(".yn button").forEach(function (b) { b.addEventListener("click", function () { state.tripleA = b.dataset.a; save(); draw(); }); });
  el("note").addEventListener("input", function () { state.note = el("note").value; save(); el("out").value = JSON.stringify(result(), null, 2); });
  el("blind").addEventListener("change", function () { state.blind = el("blind").checked; save(); draw(); });
  el("reset").addEventListener("click", function () { state.verdicts = {}; state.tripleA = null; state.note = ""; save(); draw(); });
  draw();
})();
`

export function judgePage(data: JudgeData): string {
  const shots = data.shots
    .map(
      (shot) => `
<section class="shot" id="shot-${shot.n}">
  <h2>${shot.n}. ${escapeHtml(shot.name)}</h2>
  <p class="about">${escapeHtml(shot.about)}</p>
  <div class="compare" id="cmp-${shot.n}">
    <img id="l-${shot.n}" alt="inquadratura ${shot.n}, sinistra">
    <img id="r-${shot.n}" class="top" alt="inquadratura ${shot.n}, destra">
    <div class="cut" id="bar-${shot.n}"></div>
    <span class="tag l" id="tl-${shot.n}"></span><span class="tag r" id="tr-${shot.n}"></span>
  </div>
  <input type="range" id="cut-${shot.n}" min="0" max="100" value="50" aria-label="cursore tra le due immagini, inquadratura ${shot.n}">
  <div class="verdicts">
    <span>Il «dopo» è:</span>
    ${(["peggio", "uguale", "meglio"] as const).map((v, i) => `<button id="v-${shot.n}-${i}" data-v="${v}" aria-pressed="false">${v}</button>`).join("\n    ")}
  </div>
</section>`,
    )
    .join("\n")
  const rows = data.numbers
    .map(
      (row) =>
        `<tr><td>${escapeHtml(row.name)}</td><td>${escapeHtml(row.before ?? "—")}</td><td class="${row.ok === undefined ? "" : row.ok ? "ok" : "no"}">${escapeHtml(row.after ?? "—")}${row.ok === undefined ? "" : row.ok ? " ✓" : " ✗"}</td></tr>`,
    )
    .join("\n")
  const tabs = data.levels
    .map((level) => `<button data-level="${escapeHtml(level)}" aria-pressed="false">${escapeHtml(level)}</button>`)
    .join("")
  return `<!doctype html>
<html lang="it">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(data.title)}</title>
<style>${CSS}</style>
</head>
<body>
<main>
  <h1>${escapeHtml(data.title)}</h1>
  <p class="lead">Otto inquadrature fisse, prima e dopo. Trascina il cursore sotto l'immagine; per ognuna dì se il «dopo» è peggio, uguale o meglio. Generata ${escapeHtml(data.generated)}.</p>
  <div class="bar">
    <span class="tabs">${tabs}</span>
    <label class="blindbox"><input type="checkbox" id="blind"> alla cieca</label>
    <span id="clips"></span>
    <span class="count" id="count"></span>
  </div>
${shots}
  <section class="shot">
    <h2>I numeri del gate e i controlli</h2>
    <table>
      <thead><tr><th>Controllo</th><th>Prima</th><th>Dopo</th></tr></thead>
      <tbody>
${rows}
      </tbody>
    </table>
  </section>
  <section class="shot">
    <h2>È tripla A?</h2>
    <div class="yn"><button data-a="si" aria-pressed="false">sì</button> <button data-a="no" aria-pressed="false">no</button></div>
    <p><label for="note">Una nota, se serve:</label></p>
    <textarea id="note" rows="3"></textarea>
    <h2 style="margin-top:12px">Le risposte</h2>
    <p class="about">Copia il testo qui sotto (seleziona e Ctrl+C) e incollalo nella conversazione, oppure salva il file.</p>
    <textarea id="out" rows="12" readonly></textarea>
    <p><a id="save" download="giudizio.json">Salva il file</a> · <button id="reset" type="button">Azzera le risposte</button></p>
  </section>
</main>
<script type="application/json" id="data">${scriptJson(data)}</script>
<script>${script()}</script>
</body>
</html>
`
}
