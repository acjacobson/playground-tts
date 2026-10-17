# OpenRouter TTS Playground

A bring-your-own-key playground for the text-to-speech models on [OpenRouter](https://openrouter.ai). Pick a model and a voice, type something (or let Claude Haiku write it), and hear it. You can also stage a multi-voice conversation, or send the same text to several models and compare them side by side.

It is plain HTML with no build step and no backend. Your browser calls OpenRouter's API directly with your key, and the model and voice lists come live from OpenRouter, so new models show up on their own.

**Try it at [acjacobson.github.io/playground-tts](https://acjacobson.github.io/playground-tts/)**, or browse the [voice library](https://acjacobson.github.io/playground-tts/voices.html). The site is served by GitHub Pages straight from this repo.

It was inspired by Simon Willison's [Gemini TTS Playground](https://simonwillison.net/2026/Sep/23/gemini-tts-playground/), extended from Gemini to every speech model OpenRouter offers. When the samples were last generated (October 2026) that meant 35 models from 14 providers, with 830 voices.

## Quick start

1. Get an API key at [openrouter.ai/settings/keys](https://openrouter.ai/settings/keys).
2. Open the [hosted playground](https://acjacobson.github.io/playground-tts/), or run it from a copy of this repo:

   ```bash
   open index.html
   ```

   Serving the folder over HTTP instead also gives you waveforms for saved samples:

   ```bash
   python3 -m http.server 8765
   ```

   Then go to <http://localhost:8765>.
3. Paste your key under **Connection**, then press **Generate** or ⌘↵.

The key stays in the page's memory. It is saved to the browser only if you tick **Remember on this device**, and it is never put in share links. Usage is billed to your OpenRouter account.

## The Playground (`index.html`)

- **Three modes.**
  - **Single voice** reads one text in one voice.
  - **Conversation** gives a cast of speakers lines with their own delivery directions.
  - **Compare models** sends the same text to several models in parallel.
- **Write it for me.** Describe what you want, or press **Surprise me**, and an OpenRouter chat model writes the text. It defaults to `anthropic/claude-haiku-5.5` and uses the same key. In Conversation mode it writes the whole script, one line per speaker. The prompt adapts to the speech model:
  - ElevenLabs v3/v4 get inline tags such as `[whispers]`.
  - Fish Audio gets bracketed directions.
  - Gemini gets a separate Style line that fills the Style instructions field.
  - Seed gets a scene prompt.

  Text is written in the voice's own language when the voice has one. Each write costs a fraction of a cent, and Undo puts back what was there before.
- **A searchable voice picker.** Its **▶ Try** button plays the saved sample when there is one, so trying a voice is instant and free.
- **Model-aware settings.** Each model shows its price and tips, and the page knows which models:
  - accept style instructions
  - understand inline tags
  - handle conversations natively
  - support voice cloning from a reference clip
- **Conversations on any model.** Gemini and most Fish Audio models take a whole conversation in one request. For the rest, each line is generated separately and the clips are joined in the browser.
- **Takes.** Every result is kept as a take, with:
  - a waveform
  - a download link
  - the actual cost reported by OpenRouter
  - a **Reuse settings** button
- **Share links.** Your settings live in the URL, without the key.
- **Under the hood.** Shows the exact request JSON, copyable as JSON or as a cURL command, plus the response headers.

## The Voice library (`voices.html`)

Every preset voice from every speech model, each with a short saved sample.

- Filter by provider, model, language and whether a sample exists, or search by name or voice ID.
- **Play all** goes through the current list one voice after another.
- **Use in Playground** opens that model and voice in the Playground.
- Samples are spoken in the voice's own language when its ID names one. For example, `de-DE-Klaus` introduces himself in German. Multilingual voices, such as Gemini's and ElevenLabs', speak whatever language the text is in, so their samples are in English.
- If OpenRouter adds voices that have no sample yet, the page shows how many are missing and the command that makes them. With a key you can also preview a missing voice live.

## Generating voice samples

The clips live in `samples/`, and `samples/manifest.js` lists them. The script below creates whatever is missing:

```bash
export OPENROUTER_API_KEY=sk-or-...
node scripts/generate-samples.mjs
```

The script works like this:

- It loads the current model list from OpenRouter and works out which voices have no sample yet.
- It prints an estimated cost per model and asks before spending anything. The estimate for all 830 samples was about $1.20.
- It rebuilds the manifest from the files on disk at the end, so rerunning it later fills in only new models and voices.
- Failures are recorded in the manifest, shown on the Voices page, and retried on the next run.
- Gemini and HeyGen only return raw PCM. The script requests that, then converts it to MP3 with `ffmpeg` if ffmpeg is installed, and saves it as WAV if not.

To see what's missing and what it would cost, without a key and without changing anything:

```bash
node scripts/generate-samples.mjs --dry-run
```

| Option | What it does |
| --- | --- |
| `--dry-run` | List missing samples and the estimated cost. Needs no key and changes nothing. |
| `--yes` | Skip the confirmation prompt. |
| `--provider=a,b` | Only these providers, e.g. `--provider=elevenlabs,google`. |
| `--model=id,id` | Only these models, e.g. `--model=deepgram/aura-2`. |
| `--limit=N` | Generate at most N samples in this run. |
| `--concurrency=N` | Requests in parallel (default 4, max 16). |
| `--force` | Regenerate samples that already exist, within the filters. |
| `--no-transcode` | Keep PCM-only models' samples as WAV instead of converting them to MP3. |
| `--sync` | Only rebuild `samples/manifest.js` from the files on disk. |

The script needs Node 18 or later, and `ffmpeg` is optional. Setting `OPENROUTER_API_BASE` points it at a different API URL, which is useful for testing against a mock server.

## Project layout

```
index.html                    The Playground
voices.html                   The Voice library
voice-catalog.js              Shared by both pages and the script: voice names, languages,
                              sample text, sample paths and response formats
scripts/generate-samples.mjs  Creates missing samples and rebuilds the manifest
samples/                      One clip per model and voice, plus manifest.js
```

`voice-catalog.js` and `samples/manifest.js` are plain scripts rather than modules or JSON. That way both pages also work when opened straight from disk with `file://`.

## How it talks to OpenRouter

| Endpoint | Used for |
| --- | --- |
| `GET /api/v1/models?output_modalities=speech` | The live list of speech models, voices and prices. No key needed. |
| `GET /api/v1/models/{id}/endpoints` | Whether a model supports voice cloning. |
| `POST /api/v1/audio/speech` | Generating speech. |
| `POST /api/v1/chat/completions` | "Write it for me", streamed, with reasoning turned off so text starts at once. |
| `GET /api/v1/generation?id=…` | The actual cost of each take. |
| `GET /api/v1/key` | **Check key** in the Connection panel. |

OpenRouter's API allows requests straight from the browser, which is why no backend is needed.

Some behaviour can't be read from the API, so it's written into the code from [OpenRouter's TTS docs](https://openrouter.ai/docs/guides/overview/multimodal/tts):

- which providers take style instructions or whole conversations
- which models only return PCM
- how directions are written for each model

If a model rejects the audio format and names the one it wants, the page and the script switch to that format automatically.

## Your API key

The pages are built so you don't have to take their handling of your key on trust:

- **There is no server.** The pages are static files with no analytics, no third-party scripts and no outside fonts. Your browser sends your key straight to OpenRouter, and nowhere else.
- **Your browser enforces it.** Both pages carry a Content Security Policy at the top of the HTML. It allows background requests only to `https://openrouter.ai` and to the site's own files, and blocks image beacons and form posts. Even if the code were changed to send the key elsewhere in the background, the browser would refuse.
- **You can check it.** Use View Source to read the policy, or watch your browser's Network tab while you use the page. GitHub Pages serves the files in this repo as they are.
- **Use a limited key.** OpenRouter lets you create extra keys with their own credit limit. Making one for this page, and deleting it afterwards, caps what any key can cost you.

The key stays in the page's memory unless you tick **Remember on this device**, which keeps it in the browser's local storage for that site. It never goes into share links.

One limit to be aware of: a policy like this can't stop a page from navigating the whole tab to another site. That wouldn't be silent, because you'd see the page change, and the code that did it would be visible in this repo.

## License

The code is released under the [MIT License](LICENSE).

The audio clips in `samples/` were generated with each provider's models through OpenRouter and are included as voice previews. They are not covered by the MIT License. Their use is governed by the terms of the provider that made them.
