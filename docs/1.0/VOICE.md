# Voice mode

Talk to hivedesk like a person. One tap on the mic in the top bar, Ctrl Space, or the wake word "Mel" (when it is on) opens a hands free conversation: Mel listens, notices when you stop, answers out loud sentence by sentence while the text appears, stops at once when you talk over her, and listens again for the follow up without another tap. "That is all", Esc, the End button or a tap ends it.

Mel always asks before she acts. Anything that writes, runs, shares or connects is read back and needs a spoken yes or a click on Confirm. Nothing is ever approved by itself.

## What runs where

| Part | Default | Optional | Where the audio goes |
| --- | --- | --- | --- |
| Microphone, voice activity detection, end of turn | the page (`ui/js/voice/mic.js`, `vad.js`) | | stays in the page |
| Speech to text | whisper.cpp server on this computer (`src/voice/whisper.js`) | the browser's recognizer, opt in | local: only to the engine on 127.0.0.1; browser: the browser maker may process it in its cloud |
| The answer | the crew's model through `voice.reply`, streamed | | text only |
| Mel's voice | system voices (`speechSynthesis`) | Piper, a local neural voice | made on this computer (some system voices are online voices of the OS or browser; the voice list says which) |

The browser recognizer is never used by itself. Picking it in Settings opens a notice that says the audio may be processed in the browser maker's cloud, and only "I understand, use the browser" turns it on.

## The conversation loop

`ui/js/voice/turn.js` is a pure state machine (`off`, `dormant`, `listening`, `hearing`, `transcribing`, `thinking`, `speaking`), unit tested in `test/voice/turn.test.js`. `conversation.js` runs its effects:

* Voice activity detection follows the noise floor of the room. Speech is a level clearly above it for 120 ms; the turn ends after a 750 ms pause. A turn is cut at 30 seconds.
* If you start talking again while your last turn is being transcribed, the pause was not the end: both parts are joined and transcribed together.
* Barge in: while Mel speaks the bar is higher (her voice leaks into the microphone), and a clear voice for 260 ms stops her at once, cancels the streamed answer in the engine (`voice.reply.cancel`) and listens.
* After an answer the loop listens for 15 seconds; then it ends, or waits for "Mel" when the wake word is on.
* Push to talk (Settings) is the same loop, held with Ctrl Space, without the follow up.

## Actions by voice

They use the same paths as the buttons:

| Say | What happens |
| --- | --- |
| "create a mobile app for my bakery" | read back, then `job.create` after the yes |
| a question or small talk | `voice.reply`: the engine sorts it with the keyword rules of `src/crew/talk.js`; a request comes back for the yes, never starts by itself; an answer streams |
| "approve it", "reject the step" | read back, then `approval.resolve` |
| "open the editor", "show the files" | opens the window |
| "commit and push" | the GitHub plan of `ui/github/`, read back, then it runs |
| "share my GPU with Ana" | finds Ana among the City peers (`p2p.peers`), reads back "for 24 hours, within your share limits", then `compute.share.set` and `p2p.grant` for `compute.inference` and `compute.gpu` |
| "connect to 123 456 7890" | reads the address back in groups, then `remote.connect`; the other person still accepts on their screen |
| a question card from the crew (`crew.question`) | Mel reads the question and its options (the recommended one first), understands "the second one", "number 3", a label, "both" or "decide for you", says the choice back, and after the yes sends `crew.answer { id, answers, decideForMe }` |

When a feature is not in this build (no p2p layer, no remote desktop), Mel says so instead of pretending.

## Downloads and consent

Settings, Voice, "Choose and download" opens the consent dialog: the three multilingual whisper models with their real size, the memory they need and a speed hint for this computer, the recommended one marked, the whisper.cpp server build (CPU, or CUDA on Windows with an NVIDIA GPU), the total download, the source and the license. Nothing downloads before the Download button. Every file has a pinned size and SHA-256 (`src/voice/catalog.js`), downloads resume, and a changed file asks again.

| Model | Download | Memory | Notes |
| --- | --- | --- | --- |
| Whisper tiny | 78 MB | about 273 MB | quick, mishears more |
| Whisper base | 148 MB | about 388 MB | the balance |
| Whisper small | 488 MB | about 852 MB | the most accurate, best with a GPU |

Recommendation: small with a usable GPU and enough free memory, base on the CPU from 8 threads, tiny otherwise or when free memory is low.

Piper (about 22 to 26 MB) and one medium voice per language (about 63 MB) download behind the same kind of dialog. Piper has voices for English, Portuguese (Brazil), Spanish, French, German, Italian, Chinese and Russian. It has no Japanese or Korean voice; those languages keep the system voice.

Files live in `~/.hivedesk/voice/`. The whisper process starts with the first turn and stops after a quiet minute, so it does not hold memory while you do not talk.

## Honest limits

* **Latency on the CPU.** Measured on the development PC (4 threads, other work running): an 11 second sentence took about 4 seconds with tiny when the CPU was free and up to 9 seconds under load, plus about 1.5 seconds to start the process the first time. From that rate, a short turn of two or three seconds should take about one second with tiny (estimated, not measured separately). Base and small were not run on this PC (it had about 2 GB of free memory); by the published whisper.cpp numbers base is roughly twice as slow as tiny and small roughly six times, and with a GPU build small runs faster than real time.
* **Quality of tiny.** Tiny mishears names, accents and noisy rooms more often, and sometimes adds a word in silence. Mel reads every action back before it runs, so a mishearing never acts by itself; for everyday use base is the better choice when the CPU allows it.
* **Wake word accuracy.** There is no dedicated wake word model. With the wake word on, the microphone stays open, every short sentence (up to 4 seconds) is transcribed locally and checked for "Mel" in the first words. It can miss a quiet "Mel", wake on a similar word ("Mel" and "Mell" count, "Melissa" does not), and it costs CPU while people talk in the room. It is off by default.
* **Barge in and echo.** The microphone uses the browser's echo cancellation, which reliably removes Mel's voice only when it plays through the page (Piper). System voices play outside the page, so loud speakers can still make Mel cut herself off or ignore a soft interruption. Headphones fix both.
* **Browser fallback.** With the browser recognizer the start of a turn is found by our voice activity detection and the browser starts listening then, so the first syllable can be lost; it also needs the browser's online service.
* **macOS** has no published whisper.cpp server build. Install whisper-cpp (Homebrew) and hivedesk uses `whisper-server` from the PATH, or set `HIVEDESK_WHISPER_SERVER`.
* **Desktop app and the npx tab** run the same page; the microphone permission prompt is the browser's (127.0.0.1 counts as a secure origin).

## Keys

Ctrl Space starts or ends a conversation (held in push to talk). Ctrl Shift Space mutes the microphone. Esc ends the conversation. The orb's mute button shows a crossed out microphone while muted.

## Protocol

Commands: `voice.status`, `voice.strings`, `voice.consent { id, yes: true }`, `voice.cancel`, `voice.remove`, `voice.select`, `voice.reply { text, lang, replyId, mode }`, `voice.reply.cancel { replyId }`, `voice.stt.stop`. Routes with the same token as every `/api` call: `POST /api/voice/stt?lang=` (16 kHz mono 16 bit WAV, 30 seconds at most) and `POST /api/voice/tts` (`{ text, lang, rate }`, answers `audio/wav`). Live frames: `voice.token`, `voice.done`, `voice.download`. Events: `voice.consent.given`, `voice.installed`, `voice.removed`. A Code together guest is refused by every voice command.

## What was checked on the development PC

* The real whisper.cpp server build (b5454, CPU) and the tiny model downloaded through `voice.consent` with their checksums, and the engine transcribed the whisper.cpp sample sentence correctly; the process stopped afterwards.
* One headless Edge run with a fake microphone playing that sample: the orb opened with Ctrl Space, voice activity detection moved the loop through listening, hearing and transcribing, and the consent dialog rendered with the real sizes. The PC was heavily loaded by other work, so a full spoken answer was not observed inside that short run; the answer path is covered by the unit tests.
* Piper was not run on this PC (no local model runs were allowed besides a few short whisper tiny checks); its process wrapper and endpoint are unit tested with a stand in.
