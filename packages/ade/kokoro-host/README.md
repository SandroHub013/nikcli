# kokoro-host

Kokoro offline text to speech, as a program of its own.

ADE starts this executable, hands it the runtime on the command line, and then
talks to it in JSON lines over stdin and stdout. One line out says whether the
model loaded, one line in is one synthesis, one line out is the answer, and
the speech itself lands in a WAV file the request asked for.

## Why it is a separate program

`sherpa-onnx-c-api.dll` has espeak-ng, which is GPL-3.0-or-later, linked
statically inside it. ADE stays MIT, so it neither links this crate nor
includes a line of it: the two processes only share a pipe. This crate and its
source are GPL-3.0-or-later, with `LICENSE` and `NOTICE` beside this file.

Nothing is bundled either. The DLL, the model, `voices.bin`, `tokens.txt` and
`espeak-ng-data` are all named on the command line, so there is no fixed path
anywhere in the code and no build script.

## Build

```
cd packages/ade/kokoro-host
cargo build --release
```

The executable is `target\release\kokoro-host.exe`. It needs no arguments to
compile: the runtime is only opened when it runs.

## Run

```
kokoro-host.exe ^
  --dll C:\runtime\sherpa-onnx-c-api.dll ^
  --model C:\model\model.fp16.onnx ^
  --voices C:\model\voices.bin ^
  --tokens C:\model\tokens.txt ^
  --espeak-data C:\model\espeak-ng-data ^
  --lang en-us ^
  --threads 8
```

`--dll`, `--model`, `--voices`, `--tokens` and `--espeak-data` are required;
the rest are not.

| Flag | Default | Meaning |
| --- | --- | --- |
| `--lang` | `en-us` | The language used when a request names none. `en-us` and `en` are the only values: `en-gb` has no voice. |
| `--threads` | `8` | Inference threads. Eight was the fastest measured; 16 bought almost nothing and 2 or 4 fell under the gate. |
| `--lexicon` | none | An optional sherpa lexicon, if one is ever measured. |
| `--dict-dir` | none | An optional sherpa dictionary directory. |

A startup that fails writes one line and leaves with status 2. A startup that
works stays until stdin closes, then leaves with status 0.

## Protocol

The first line out is always:

```json
{"v":1,"ready":true,"loadMs":842,"sampleRate":24000,"pid":1234,"mem":{}}
```

If the model could not be loaded it is `{"v":1,"ready":false,"loadMs":…,"error":"…"}`,
with `error` among `missing:<argument>`, `bad-path:<argument>`, `bad-args:<flag>`, `bad-args:unknown`,
`bad-lang`, `open-dll:<errno>`, `missing-symbol:<name>`, `create-failed` or
`bad-sample-rate`.

After that, one request in and one answer out per line, in order, one
synthesis at a time:

```json
{"id":1,"text":"Hello there.","sid":3,"lang":"en-us","out":"C:\\tmp\\a.wav"}
{"id":1,"ok":true,"synthMs":180.4,"audioMs":1400.2,"samples":33605,"sampleRate":24000,"peak":0.61,"mem":{}}
```

- `id` is echoed back untouched; it is how the caller matches answers to
  requests.
- `text` is what to say. Required, non-empty.
- `sid` is the voice index. Optional, defaults to `0`.
- `lang` is optional. Only `en-us` and `en` are accepted; `en-gb` and `en-uk`
  are answered as `en`, because espeak inside sherpa has no `en-gb` voice and
  refusing it is the failure K1 measured.
- `speed` is optional, `1.0` by default, between `0.25` and `4.0`.
- `out` is where the WAV goes. Required, non-empty. Mono, 16 bit, 24 kHz.

A request that will not be spoken answers on its own line instead, with `ok`
false and one of these codes, and the loop carries on:

| Code | Meaning |
| --- | --- |
| `bad-line` | The line is not one JSON object. |
| `bad-request` | A required field is missing, empty, or the wrong type. |
| `bad-lang` | A language with no voice behind it. |
| `synth-failed` | sherpa returned no audio. |
| `empty-audio` | sherpa returned no samples, so no file was written. |
| `write-failed` | The WAV could not be written where the request pointed. |

## What must not be logged

**The text never leaves this process except as audio.** It is not on stdout,
not on stderr, and not in any log line.

sherpa-onnx itself writes `Failed to phonemize '<text>'` to stderr when it
cannot read a word, and this program cannot silence a DLL it merely loads.
So **ADE must not log the child's stderr**: drop it, or count it and nothing
more. The text is in there when sherpa fails, and it is not ours to write.

## Tests

```
cargo test
```

The tests run with no DLL, no model and no runtime anywhere near them: the
part that calls sherpa sits behind a trait, and the tests use a stand-in. What
they cover is the parsing of the protocol, the error answers, the WAV header,
the first line, and the loop.

## Licence

GPL-3.0-or-later. See `LICENSE` and `NOTICE`.
