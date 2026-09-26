import { describe, expect, test } from "bun:test";
import { createNaturalSpeaker, type NaturalSpeakerDeps } from "./natural-speaker";
import { createFakeSpeaker } from "./speaker";
import { detectReplyLanguage, interfaceLocale, replyLocale, replyVoiceChain, replyVoiceChainFrom, speakingReplyVoice, type ReplyLanguage } from "../settings/reply-voices";
import type { ReplyVoice, TtsLocale } from "../settings/model";

const wav = (text: string) => new TextEncoder().encode(text).buffer as ArrayBuffer;
const said = (buffer: ArrayBuffer) => new TextDecoder().decode(buffer);

/**
 * A host that answers, with the bridge of K4 replaced by a plain function: what
 * these tests are about is what the speaker asks the host for, not that a host
 * exists.
 *
 * `voiceFor` is the real rule, not a stub: the chosen voice, the language the
 * reply's text says, and the setting as the fallback. That is the same
 * composition `workbench.tsx` does, so a test that says the wrong voice is
 * caught here and not in the application.
 */
function host(chosen: ReplyVoice = "af_heart", over: Partial<NaturalSpeakerDeps> = {}) {
  const played: string[] = []
  const asked: { voice: string; text: string; locale: TtsLocale }[] = []
  const fallback = createFakeSpeaker()
  const deps: NaturalSpeakerDeps = {
    voiceFor: (detected) => {
      const spoken = replyLocale(chosen, detected, "it-IT");
      return { voice: speakingReplyVoice(chosen, spoken, "it"), locale: spoken }
    },
    status: async () => ({ supported: true, installed: true }),
    install: async () => {},
    synthesize: async (voice, text, _token, locale) => {
      asked.push({ voice, text, locale });
      return wav(text)
    },
    play: async (buffer) => {
      played.push(said(buffer))
    },
    fallback,
    ...over,
  }
  return { deps, played, asked, fallback }
}

describe("la lingua della risposta viene dal suo testo", () => {
  test("un testo italiano lo dice, e lo dice anche quando l'inglese è più lungo", () => {
    expect(detectReplyLanguage("Ho aperto la sessione e i test sono verdi.")).toBe("it");
    // Una riga di identificatori non è un indizio, e non viene tirata a italianità.
    expect(detectReplyLanguage("RSSMRA80A01H501U")).toBeUndefined();
    expect(detectReplyLanguage("OK 42 3.5 2026-09-26")).toBeUndefined();
  });

  test("un testo inglese lo dice, e senza le vocali accentate italiane", () => {
    expect(detectReplyLanguage("I opened the session and the tests are green.")).toBe("en");
    expect(detectReplyLanguage("Ho aperto la sessione, ma i test non sono verdi.")).toBe("it");
  });

  test("quando il testo non dice niente, decide l'interfaccia, non la voce", () => {
    // Le risposte corte di un assistente non hanno parole da contare, e sono
    // italiane più spesso di quanto sembri: se decidesse la voce, una voce
    // Kokoro le leggerebbe in inglese.
    expect(replyLocale("af_heart", undefined, "it-IT")).toBe("it-IT");
    expect(replyLocale("bf_emma", undefined, "it-IT")).toBe("it-IT");
    // E in una finestra inglese la stessa risposta va in inglese.
    expect(replyLocale("af_heart", undefined, "en-US")).toBe("en-US");
    expect(replyLocale("bf_emma", undefined, "en-GB")).toBe("en-GB");
  });

  test("la variante inglese la dà la voce, ma solo su una risposta già in inglese", () => {
    expect(replyLocale("bf_emma", "en", "it-IT")).toBe("en-GB");
    expect(replyLocale("af_heart", "en", "it-IT")).toBe("en-US");
    // Sul "non so" l'interfaccia decide, anche per una voce britannica.
    expect(replyLocale("bf_emma", undefined, "it-IT")).toBe("it-IT");
  });

  test("una risposta italiana resta italiana anche con la voce inglese scelta", () => {
    expect(replyLocale("af_heart", "it", "en-US")).toBe("it-IT");
    expect(replyLocale("bm_george", "it", "en-US")).toBe("it-IT");
  });

  test("una risposta inglese tiene la variante della voce scelta", () => {
    expect(replyLocale("bf_emma", "en", "it-IT")).toBe("en-GB");
    expect(replyLocale("af_heart", "en", "it-IT")).toBe("en-US");
  });
});

describe("la voce che parla è quella che il testo chiede", () => {
  const italian = "Ho aperto la sessione sul parser e adesso i test sono verdi.";
  const english = "I opened the session on the parser and the tests are green.";

  test("testo italiano con una voce Kokoro scelta: parla Ugo o Paola", async () => {
    for (const [kokoro, piper] of [
      ["af_heart", "paola"],
      ["bf_emma", "paola"],
      ["am_fenrir", "ugo"],
      ["bm_george", "ugo"],
    ] as const) {
      const h = host(kokoro);
      await createNaturalSpeaker(h.deps).speak(italian);
      expect(new Set(h.asked.map((unit) => unit.voice))).toEqual(new Set([piper]));
    }
  });

  test("e il testo inglese con la stessa voce parla la voce Kokoro", async () => {
    const h = host("af_heart");
    await createNaturalSpeaker(h.deps).speak(english);
    expect(new Set(h.asked.map((unit) => unit.voice))).toEqual(new Set(["af_heart"]));
  });

  test("una risposta troppo corta da contare resta nella lingua dell'interfaccia", async () => {
    // «Salvato.» non ha una parola che si possa contare, e in una finestra
    // italiana lo dice Ugo o Paola: non è il caso in cui la voce decide.
    for (const line of ["Salvato.", "Ok, aperto.", "Tutto a posto: 3 test verdi."]) {
      const h = host("af_heart");
      await createNaturalSpeaker(h.deps).speak(line);
      expect(new Set(h.asked.map((unit) => unit.voice))).toEqual(new Set(["paola"]));
      expect(new Set(h.asked.map((unit) => unit.locale))).toEqual(new Set(["it-IT"]));
    }
  });

  test("la lingua che arriva al bridge è quella della risposta", async () => {
    const h = host("af_heart");
    await createNaturalSpeaker(h.deps).speak(english);
    expect(new Set(h.asked.map((unit) => unit.locale))).toEqual(new Set(["en-US"]));
  });

  test("il prefetch porta la lingua del testo che prefetcha", async () => {
    const h = host("af_heart");
    const speaker = createNaturalSpeaker(h.deps);
    // Una risposta in inglese tiene la voce Kokoro e la rende pronta, così il
    // prefetch ha qualcosa su cui lavorare.
    await speaker.speak(english);
    h.asked.length = 0;
    speaker.prefetch?.(english);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(h.asked.length).toBeGreaterThan(1);
    expect(new Set(h.asked.map((unit) => unit.locale))).toEqual(new Set(["en-US"]));
  });

  test("un warm-up non ha testo da leggere, e usa la voce delle impostazioni", async () => {
    const h = host("ugo");
    await createNaturalSpeaker(h.deps).prepare();
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(h.asked.map((unit) => unit.voice)).toEqual(["ugo"]);
    // E dice quello che non sente nessuno nella lingua di quella voce.
    expect(h.asked.map((unit) => unit.locale)).toEqual(["it-IT"]);
  });
});

describe("il taglio che spetta alla voce", () => {
  // Tre frasi, e la prima pesa più dei 30 caratteri del primo pezzo: è il
  // taglio progressivo di K1, non una novità di questo punto.
  const kokoroReply =
    "I opened the Codex session on the parser and the toolchain. Then I ran the whole suite on the worktree, twice, because the first run looked green. Now I am reading the diff and the numbers again.";
  const piperReply = "Ho aperto la sessione Codex sul parser, poi ho lanciato la suite del worktree e adesso guardo i test.";

  test("Kokoro riceve pezzi, e il primo è corto", async () => {
    const h = host("af_heart");
    await createNaturalSpeaker(h.deps).speak(kokoroReply);
    expect(new Set(h.asked.map((unit) => unit.voice))).toEqual(new Set(["af_heart"]));
    expect(h.asked.length).toBeGreaterThan(1);
    expect(h.asked[0]!.text.length).toBeLessThan(kokoroReply.length);
  });

  test("Piper riceve la frase intera, come prima", async () => {
    const h = host("ugo");
    await createNaturalSpeaker(h.deps).speak(piperReply);
    expect(h.asked.map((unit) => unit.text)).toEqual([piperReply]);
  });

  test("e le unità escono in ordine, con la prima che suona prima delle altre", async () => {
    const h = host("af_heart");
    await createNaturalSpeaker(h.deps).speak(kokoroReply);
    expect(h.asked.map((unit) => unit.text).join(" ")).toBe(kokoroReply);
    expect(h.played).toEqual(h.asked.map((unit) => unit.text));
  });
});

describe("la catena è quella che si prova davvero", () => {
  const italian = "Ho aperto la sessione Codex sul parser e adesso i test sono verdi.";

  /**
   * A host where Kokoro is the voice the settings ask for and the host has never
   * heard of it: `status` refuses, exactly as it does on a build where the 219 MB
   * runtime is not there.
   */
  function withoutKokoro(chosen: ReplyVoice) {
    const h = host(chosen, {
      status: async (voice) => (voice.startsWith("af_") || voice.startsWith("am_") || voice.startsWith("bf_") || voice.startsWith("bm_")
        ? { supported: false, installed: false }
        : { supported: true, installed: true }),
    });
    return h
  }

  test("Kokoro non c'è: parla Piper, e non la voce di sistema", async () => {
    const h = withoutKokoro("af_heart")
    await createNaturalSpeaker(h.deps).speak(italian)
    // La voce di Kokoro non è mai stata chiesto al bridge, e niente è andato
    // nella voce di sistema: la catena si è fermata a Piper.
    expect(h.asked.map((unit) => unit.voice)).toEqual(["paola"])
    expect(h.asked.map((unit) => unit.text)).toEqual([italian])
    expect(h.played).toEqual([italian])
    expect(h.fallback.spoken).toEqual([])
  })

  test("e la lingua che arriva al bridge è quella della risposta, non quella del pannello", async () => {
    const h = withoutKokoro("af_heart")
    await createNaturalSpeaker(h.deps).speak(italian)
    expect(h.asked.map((unit) => unit.locale)).toEqual(["it-IT"])
  })

  test("un Kokoro maschio ripiega su Ugo, e la domanda di Ugo non porta a un Kokoro", async () => {
    const h = withoutKokoro("am_fenrir")
    await createNaturalSpeaker(h.deps).speak(italian)
    expect(h.asked.map((unit) => unit.voice)).toEqual(["ugo"])
  })

  test("una risposta inglese con Kokoro scelto ripiega su Lessac", async () => {
    const h = withoutKokoro("bf_emma")
    await createNaturalSpeaker(h.deps).speak("I opened the session and the tests are green.")
    expect(h.asked.map((unit) => unit.voice)).toEqual(["lessac"])
    expect(h.asked.map((unit) => unit.locale)).toEqual(["en-GB"])
  })

  test("una risposta italiana con Kokoro scelto non scarica i 219 MB", async () => {
    const asked: string[] = []
    const h = host("af_heart", {
      status: async (voice) => {
        asked.push(`status:${voice}`)
        return { supported: true, installed: true }
      },
      install: async (voice) => {
        asked.push(`install:${voice}`)
      },
    })
    await createNaturalSpeaker(h.deps).speak(italian)
    // Kokoro non può dire l'italiano, quindi non viene neppure chiesto: la
    // risposta è di Paola e i 219 MB non servono a nessuno.
    expect(asked).toEqual(["status:paola"])
    expect(h.asked.map((unit) => unit.voice)).toEqual(["paola"])
  })

  test("Kokoro scelto, non ancora installato: la risposta è di Lessac e nessuno scarica", async () => {
    const asked: string[] = []
    const h = host("af_heart", {
      status: async (voice) => {
        asked.push(`status:${voice}`)
        return voice === "af_heart" ? { supported: true, installed: false } : { supported: true, installed: true }
      },
      install: async (voice) => {
        asked.push(`install:${voice}`)
      },
    })
    const english = "I opened the session on the parser and the tests are green."
    await createNaturalSpeaker(h.deps).speak(english)
    // Il pannello promette che i 219 MB arrivano premendo Installa, quindi una
    // risposta non li avvia: si chiede se Kokoro c'è, si va a Lessac, e basta.
    expect(asked).toEqual(["status:af_heart", "status:lessac"])
    expect(h.asked.map((unit) => unit.voice)).toEqual(["lessac"])
    expect(h.played).toEqual([english])
    expect(h.fallback.spoken).toEqual([])
  })

  test("Kokoro che risponde non viene ripetuto: la catena non viene percorsa", async () => {
    const asked: string[] = []
    const h = host("af_heart", {
      status: async (voice) => {
        asked.push(voice)
        return { supported: true, installed: true }
      },
    })
    await createNaturalSpeaker(h.deps).speak("I opened the session and the tests are green.")
    expect(asked).toEqual(["af_heart"])
    expect(new Set(h.asked.map((unit) => unit.voice))).toEqual(new Set(["af_heart"]))
  })

  test("Kokoro e Piper assenti: la voce di sistema, e la notizia una volta sola", async () => {
    const h = host("af_heart", {
      status: async () => ({ supported: false, installed: false }),
      fallbackNotice: () => "La voce naturale non è pronta.",
    })
    const speaker = createNaturalSpeaker(h.deps)
    await speaker.speak(italian)
    await speaker.speak("E adesso guardo i numeri del worktree.")
    // Le parole escono dalla voce di sistema, che è l'ultimo ripiego, e la notifica
    // che è scesa di gradino non ripete quello che ha già detto una volta.
    expect(h.fallback.spoken).toEqual([
      "La voce naturale non è pronta.",
      italian,
      "E adesso guardo i numeri del worktree.",
    ]);
  })

  test("Kokoro pronto che poi fallisce: Piper risponde tutto, senza la voce di sistema", async () => {
    // `ready` ricorda che Kokoro era installato, e il bridge lo rifiuta: è la
    // catena che deve accorgersene, non la cache.
    const asked: string[] = []
    const h = host("af_heart", {
      status: async () => ({ supported: true, installed: true }),
      synthesize: async (voice, text) => {
        asked.push(voice)
        if (voice === "af_heart") throw new Error("Failed to set eSpeak-ng voice")
        return wav(text)
      },
    })
    const english = "I opened the session and the tests are green."
    await createNaturalSpeaker(h.deps).speak(english)
    // Kokoro è stato provato e non ha risposto, e la risposta è interamente di
    // Lessac: una voce sola per una risposta sola. Le unità di Kokoro sono state
    // chieste tutte insieme, quindi lo si vede più di una volta.
    expect(new Set(asked)).toEqual(new Set(["af_heart", "lessac"]))
    expect(asked.at(-1)).toBe("lessac")
    expect(h.played).toEqual([english])
    expect(h.fallback.spoken).toEqual([])
  })

  test("i pezzi della voce abbandonata non restano in coda al posto di quella che segue", async () => {
    // I pezzi sono chiesti tutti insieme, quindi quando Kokoro non risponte
    // quelli dopo il primo restano in coda sull'host: la voce dopo deve poter
    // passare, non aspettare un pezzo che nessuno suona.
    const cancelled: number[][] = [];
    const english = [
      "I opened the session on the parser and the toolchain.",
      "Then I ran the whole suite on the worktree, twice, because the first run looked green.",
      "Now I am reading the diff and the numbers again.",
    ].join(" ");
    const h = host("af_heart", {
      status: async () => ({ supported: true, installed: true }),
      cancel: async (tokens) => {
        cancelled.push([...tokens])
      },
      synthesize: async (voice, text) => {
        // Kokoro non risponde: nessun pezzo arriva, e gli altri restano in coda
        // sull'host anche se nessuno li suona.
        if (voice === "af_heart") throw new Error("runtime crash")
        return wav(text);
      },
    });
    await createNaturalSpeaker(h.deps).speak(english)
    // I pezzi di Kokoro dopo quello in corso sono stati annullati, e la risposta
    // l'ha letta Lessac dall'inizio, tutta quanta e a frasi intere.
    expect(cancelled.flat().length).toBeGreaterThan(0);
    expect(h.played.join(" ")).toBe(english);
    expect(h.fallback.spoken).toEqual([]);
  });

  test("Kokoro che parte a metà: la voce non cambia sotto una risposta già iniziata", async () => {
    const english = [
      "I opened the session on the parser and the toolchain.",
      "Then I ran the whole suite on the worktree, twice, because the first run looked green.",
      "Now I am reading the diff and the numbers again.",
    ].join(" ")
    let asked = 0
    const h = host("af_heart", {
      status: async () => ({ supported: true, installed: true }),
      synthesize: async (voice, text) => {
        // I primi due pezzi funzionano, il terzo no: la risposta è già iniziata.
        if (voice === "af_heart" && ++asked > 2) throw new Error("runtime crash")
        return wav(text)
      },
    })
    await createNaturalSpeaker(h.deps).speak(english)
    // Due pezzi suonati, e il terzo non è mai arrivato: la catena non ha
    // ricominciato da Lessac sopra una risposta già iniziata.
    expect(h.played.length).toBe(2)
    expect(english.startsWith(h.played.join(" "))).toBe(true)
    // Il resto non è perduto, ed è nella voce di sotto, che è l'ultimo ripiego.
    expect(h.fallback.spoken.length).toBe(1)
    expect(h.fallback.spoken[0]).toContain("Now I am reading the diff")
  })
});

describe("il profilo di default non si rimappa da solo", () => {
  test("Ugo, finestra italiana, risposta inglese: resta Ugo e non scarica Lessac", async () => {
    // La voce è già stata risolta dalla lingua dell'interfaccia. Se la catena la
    // risolvesse di nuovo, chiederebbe Lessac, ne avvierebbe il download senza
    // che nessuno l'abbia chiesto, e per intanto la risposta la leggerebbe la
    // voce di sistema.
    const asked: string[] = []
    const h = host("ugo", {
      status: async (voice) => {
        asked.push(`status:${voice}`)
        return { supported: true, installed: voice === "ugo" }
      },
      install: async (voice) => {
        asked.push(`install:${voice}`)
      },
    })
    const line = "I opened the session and the toolchain is ready."
    await createNaturalSpeaker(h.deps).speak(line)
    expect(asked).toEqual(["status:ugo"])
    expect(h.asked.map((unit) => unit.voice)).toEqual(["ugo"])
    expect(h.played).toEqual([line])
    // E la voce di sistema non è coinvolta: nessun avviso, nessun ripiego.
    expect(h.fallback.spoken).toEqual([])
  })

  test("una catena non rimappa mai un id Piper", () => {
    for (const id of ["ugo", "paola", "lessac"] as const) {
      for (const locale of ["it-IT", "en-US", "en-GB"] as const) {
        expect(replyVoiceChainFrom(id, locale)).toEqual([id, "system"])
      }
    }
    // Mentre per un id Kokoro la catena scende, che è il suo punto.
    expect(replyVoiceChainFrom("af_heart", "en-US")).toEqual(["af_heart", "lessac", "system"])
  })
});

describe("il ripiego viene dalla lingua dell'interfaccia, non dall'impostazione", () => {
  /**
   * The composition `workbench.tsx` does in `voiceFor`, spelled out: the
   * interface's language is the fallback, the text wins over it, and the voice is
   * derived from the locale that came out. It is the same three calls in the same
   * order, so a test that says the wrong voice is caught here and not in the app.
   */
  const voiceFor = (chosen: ReplyVoice, ui: "it" | "en", ttsLocale: TtsLocale, text: string) => {
    const spoken = replyLocale(chosen, detectReplyLanguage(text), interfaceLocale(ui, ttsLocale));
    return { voice: speakingReplyVoice(chosen, spoken, ui), locale: spoken };
  };

  test("interfaccia inglese, voce Kokoro, «Done.»: la voce inglese", () => {
    // ttsLocale rimasto it-IT, come sta su un profilo che non l'ha toccato: se il
    // ripiego venisse da lì, «Done.» andrebbe a Paola.
    expect(voiceFor("af_heart", "en", "it-IT", "Done.")).toEqual({ voice: "af_heart", locale: "en-US" });
  });

  test("interfaccia italiana, voce Kokoro, «Salvato.»: Paola", () => {
    expect(voiceFor("af_heart", "it", "it-IT", "Salvato.")).toEqual({ voice: "paola", locale: "it-IT" });
  });

  test("la variante britannica si conserva quando l'impostazione la ha già", () => {
    expect(voiceFor("bf_emma", "en", "en-GB", "Done.")).toEqual({ voice: "bf_emma", locale: "en-GB" });
    // E una finestra italiana non la riporta indietro: l'inglese è una scelta.
    expect(voiceFor("bf_emma", "it", "en-GB", "Done.")).toEqual({ voice: "paola", locale: "it-IT" });
  });

  test("un testo riconosciuto vince sull'interfaccia, in entrambe le direzioni", () => {
    // Finestra inglese, ma la risposta è italiana: la risposta comanda.
    expect(voiceFor("af_heart", "en", "en-US", "Ho aperto la sessione e i test sono verdi.")).toEqual({
      voice: "paola",
      locale: "it-IT",
    });
    // Finestra italiana, ma la risposta è inglese: idem, e su Ugo resta Ugo.
    expect(voiceFor("ugo", "it", "it-IT", "I opened the session and the tests are green.")).toEqual({
      voice: "ugo",
      locale: "en-US",
    });
  });

  test("l'impostazione non può più essere la risposta, quale che sia", () => {
    // Il punto della condizione: qualunque valore abbia ttsLocale, un testo che
    // non dice la lingua prende la lingua dell'interfaccia.
    for (const ttsLocale of ["it-IT", "en-US", "en-GB"] as const) {
      expect(interfaceLocale("en", ttsLocale).startsWith("en")).toBe(true);
      expect(interfaceLocale("it", ttsLocale)).toBe("it-IT");
    }
  });
});

describe("una risposta non scarica mai niente", () => {
  const english = "I opened the session and the tests are green.";

  test("Kokoro scelto e non installato: nessun download, e la catena scende", async () => {
    // Il pannello promette che i 219 MB arrivano premendo Installa. Una risposta
    // che li avvia da sé rompe la promessa, e basta una frase inglese per
    // metterla in moto.
    const asked: string[] = []
    const h = host("af_heart", {
      status: async (voice) => {
        asked.push(`status:${voice}`)
        return { supported: true, installed: voice === "lessac" }
      },
      install: async (voice) => {
        asked.push(`install:${voice}`)
      },
    })
    await createNaturalSpeaker(h.deps).speak(english)
    expect(asked).toEqual(["status:af_heart", "status:lessac"])
    expect(asked.filter((step) => step.startsWith("install"))).toEqual([])
    // E la risposta è di Lessac, che era già lì: la catena ha usato quello che
    // c'era senza andare a prendere niente.
    expect(new Set(h.asked.map((unit) => unit.voice))).toEqual(new Set(["lessac"]))
  })

  test("Kokoro scelto e non installato, e Lessac nemmeno: la voce di sistema", async () => {
    const h = host("af_heart", {
      status: async () => ({ supported: true, installed: false }),
      install: async () => {
        throw new Error("una risposta non scarica niente")
      },
    })
    await createNaturalSpeaker(h.deps).speak(english)
    expect(h.asked).toEqual([])
    expect(h.fallback.spoken).toEqual([english])
  })

  test("il passo di mezzo della catena è usato solo se è già installato", async () => {
    // La regola vale per ogni passo dopo il primo: Lessac è la voce che c'era
    // dentro la catena, non una scelta, e non viene scaricata da una risposta.
    const asked: string[] = []
    const h = host("bm_george", {
      status: async (voice) => {
        asked.push(voice)
        return { supported: true, installed: false }
      },
      install: async (voice) => {
        asked.push(`install:${voice}`)
      },
    })
    await createNaturalSpeaker(h.deps).speak(english)
    // Il Kokoro scelto non scarica niente, e il suo passo di mezzo è chiesto una
    // volta e basta: nessun download.
    expect(asked).toEqual(["bm_george", "lessac"])
    expect(h.asked).toEqual([])
  })

  test("il warm-up non scarica niente nemmeno lui", async () => {
    const h = host("af_heart", {
      status: async () => ({ supported: true, installed: false }),
      install: async () => {
        throw new Error("il warm-up non scarica niente")
      },
    })
    const speaker = createNaturalSpeaker(h.deps)
    speaker.prepare()
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(h.asked).toEqual([])
  })

  test("la voce scelta che non c'è ancora si scarica ancora, se è di Piper", async () => {
    // La regola è sulla catena e sul backend, non sulle risposte in generale: una
    // voce Piper scelta e non ancora presente si prende come una volta sola, e la
    // risposta di dopo la trova già pronta.
    const installed: string[] = []
    let ready = false
    const h = host("ugo", {
      status: async () => ({ supported: true, installed: ready }),
      install: async (voice) => {
        installed.push(voice)
        ready = true
      },
    })
    const speaker = createNaturalSpeaker(h.deps)
    await speaker.speak("I opened the session and the tests are green.")
    expect(installed).toEqual(["ugo"])
    // Il modello non c'era, quindi questa risposta la legge la voce di sotto, e la
    // seconda la legge Ugo: è il comportamento di sempre per Piper.
    expect(h.fallback.spoken.length).toBe(1)
    await speaker.speak("And now the second one.")
    expect(new Set(h.asked.map((unit) => unit.voice))).toEqual(new Set(["ugo"]))
  });
});

describe("la catena di ripiego è quella del dominio", () => {
  test("Kokoro, poi Piper nella stessa lingua, poi il sistema", () => {
    expect(replyVoiceChain("af_heart", "en-US")).toEqual(["af_heart", "lessac", "system"]);
    expect(replyVoiceChain("bm_george", "en-GB")).toEqual(["bm_george", "lessac", "system"]);
  });

  test("su una risposta italiana la catena comincia da Piper, e resta offline", () => {
    expect(replyVoiceChain("af_heart", "it-IT")).toEqual(["paola", "system"]);
    expect(replyVoiceChain("am_fenrir", "it-IT")).toEqual(["ugo", "system"]);
  });

  test("mai Kokoro nel mezzo di un utente che non l'ha scelto", () => {
    // È la regola che 219 MB non arrivano senza che qualcuno li chieda.
    for (const id of ["ugo", "paola", "lessac"] as const) {
      for (const locale of ["it-IT", "en-US", "en-GB"] as const) {
        expect(replyVoiceChain(id, locale)).not.toContain("af_heart");
      }
    }
  });

  test("la catena segue la lingua della risposta, non quella delle impostazioni", () => {
    const chosen: ReplyVoice = "af_heart";
    const italian: ReplyLanguage = "it";
    const spoken = replyLocale(chosen, italian, "en-US");
    expect(replyVoiceChain(chosen, spoken)).toEqual(["paola", "system"]);
  });
});
