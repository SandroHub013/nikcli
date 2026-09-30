/*
 * A plugin for trying the host: it asks for every message of API v1 and shows the answer. It has no build step and no inline script or
 * style, so it runs under the plugin's release policy as it is.
 *
 * What a test reads (over CDP, from inside the frame): `window.__hello` = { port, state, answers, events, log }.
 * What a test can make it do: `__hello.runAll()`, `__hello.navigate(url)`.
 */
;(function () {
  var nonce = (location.hash.match(/[#&]n=([0-9a-f]+)/) || [])[1] || ""
  var hello = (window.__hello = { port: null, state: "waiting", answers: {}, events: [], pushes: [], log: [], granted: null, pauses: 0, resumes: 0, pings: 0 })
  var next = 1
  var pending = {}
  var status = document.getElementById("status")
  var table = document.querySelector("#answers tbody")

  function say(text) {
    status.textContent = text
  }

  function show(name, reply) {
    var row = document.createElement("tr")
    var label = document.createElement("td")
    label.textContent = name
    var cell = document.createElement("td")
    cell.className = reply.ok ? "ok" : "no"
    cell.textContent = reply.ok ? JSON.stringify(reply.value).slice(0, 160) : "errore: " + reply.error
    row.appendChild(label)
    row.appendChild(cell)
    table.appendChild(row)
  }

  /** One request; resolves with the reply (`{ok, value | error}`). */
  function ask(type, body) {
    return new Promise(function (resolve) {
      var id = next++
      pending[id] = function (reply) {
        hello.answers[type] = reply
        show(type, reply)
        resolve(reply)
      }
      hello.port.postMessage(Object.assign({ v: 1, id: id, type: type }, body || {}))
    })
  }
  hello.ask = ask

  hello.runAll = function () {
    var chord = { key: "p", ctrl: true, alt: false, shift: true, meta: false }
    var steps = [
      ["sessions.snapshot"],
      ["projects"],
      ["decisions.count"],
      ["pane.focus", { paneId: "inventata" }],
      ["command.run", { chord: chord }],
      ["command.run", { chord: { key: "w", ctrl: true, alt: false, shift: false, meta: false } }],
      ["focus.release"],
      ["storage.set", { value: { visto: Date.now() } }],
      ["storage.get"],
      ["messaggio.sconosciuto"],
      ["__proto__"],
    ]
    return steps.reduce(function (chain, step) {
      return chain.then(function () {
        return ask(step[0], step[1]).then(function (reply) {
          hello.log.push({ type: step[0], ok: reply.ok, error: reply.error, value: reply.value })
        })
      })
    }, Promise.resolve())
  }

  /** Asks ADE to focus the first session it was shown. ADE then puts that session in front, so the plugin's own pane leaves the view: no reply is waited for. */
  hello.focusFirst = function () {
    var first = hello.pushes.filter(function (m) { return m.type === "sessions.snapshot" })[0]
    var paneId = first && first.snapshot.sessions[0] ? first.snapshot.sessions[0].paneId : "inventata"
    hello.port.postMessage({ v: 1, id: next++, type: "pane.focus", paneId: paneId })
  }

  hello.navigate = function (url) {
    location.href = url
  }

  function onPort(port) {
    hello.port = port
    port.onmessage = function (event) {
      var m = event.data
      if (!m || typeof m !== "object") return
      if (m.type === "reply") {
        var done = pending[m.id]
        delete pending[m.id]
        if (done) done(m)
        return
      }
      if (m.type === "hello") {
        hello.granted = m.granted
        hello.state = "hello"
        say("api " + m.api + ", permessi: " + (m.granted.join(", ") || "nessuno"))
        port.postMessage({ v: 1, type: "ready" })
        return
      }
      if (m.type === "ping") {
        hello.pings++
        port.postMessage({ v: 1, type: "pong", id: m.id })
        return
      }
      if (m.type === "pause") hello.pauses++
      if (m.type === "resume") hello.resumes++
      if (m.type === "sessions.event") hello.events.push(m.event)
      hello.pushes.push(m)
    }
  }

  window.addEventListener("message", function (event) {
    var m = event.data
    if (m && m.type === "plugin:port" && event.ports && event.ports[0]) onPort(event.ports[0])
  })
  parent.postMessage({ type: "plugin:hello", nonce: nonce }, "*")
})()
