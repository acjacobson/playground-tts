/*
 * Voice catalog helpers shared by index.html, voices.html and scripts/generate-samples.mjs.
 * Plain script with no imports: it sets globalThis.VoiceCatalog, so it loads from file:// pages too.
 */
(function (root) {
  'use strict';

  // Short self-introductions, keyed by base language. [with a name, without one]
  const SAMPLE_TEXT = {
    en: ["Hi, I'm {name}. This is a quick sample of how I sound.", 'Hi! This is a quick sample of how I sound.'],
    de: ['Hallo, ich bin {name}. Das ist eine kurze Hörprobe meiner Stimme.', 'Hallo! Das ist eine kurze Hörprobe meiner Stimme.'],
    fr: ["Bonjour, je m'appelle {name}. Voici un court extrait de ma voix.", 'Bonjour ! Voici un court extrait de ma voix.'],
    es: ['Hola, soy {name}. Esta es una breve muestra de mi voz.', '¡Hola! Esta es una breve muestra de mi voz.'],
    it: ['Ciao, sono {name}. Questo è un breve assaggio della mia voce.', 'Ciao! Questo è un breve assaggio della mia voce.'],
    pt: ['Olá, eu sou {name}. Esta é uma pequena amostra da minha voz.', 'Olá! Esta é uma pequena amostra da minha voz.'],
    nl: ['Hallo, ik ben {name}. Dit is een kort voorbeeld van mijn stem.', 'Hallo! Dit is een kort voorbeeld van mijn stem.'],
    da: ['Hej, jeg hedder {name}. Dette er en kort prøve på min stemme.', 'Hej! Dette er en kort prøve på min stemme.'],
    sv: ['Hej, jag heter {name}. Det här är ett kort prov på min röst.', 'Hej! Det här är ett kort prov på min röst.'],
    nb: ['Hei, jeg heter {name}. Dette er en kort prøve på stemmen min.', 'Hei! Dette er en kort prøve på stemmen min.'],
    fi: ['Hei, olen {name}. Tämä on lyhyt näyte äänestäni.', 'Hei! Tämä on lyhyt näyte äänestäni.'],
    pl: ['Cześć, jestem {name}. To krótka próbka mojego głosu.', 'Cześć! To krótka próbka mojego głosu.'],
    cs: ['Ahoj, jsem {name}. Tohle je krátká ukázka mého hlasu.', 'Ahoj! Tohle je krátká ukázka mého hlasu.'],
    hu: ['Szia, {name} vagyok. Ez egy rövid minta a hangomból.', 'Szia! Ez egy rövid minta a hangomból.'],
    ro: ['Bună, sunt {name}. Aceasta este o scurtă mostră a vocii mele.', 'Bună! Aceasta este o scurtă mostră a vocii mele.'],
    ru: ['Привет, я {name}. Это короткий образец моего голоса.', 'Привет! Это короткий образец моего голоса.'],
    tr: ['Merhaba, ben {name}. Bu, sesimden kısa bir örnek.', 'Merhaba! Bu, sesimden kısa bir örnek.'],
    hi: ['नमस्ते, मैं {name} हूँ। यह मेरी आवाज़ का एक छोटा सा नमूना है।', 'नमस्ते! यह मेरी आवाज़ का एक छोटा सा नमूना है।'],
    id: ['Halo, saya {name}. Ini contoh singkat suara saya.', 'Halo! Ini contoh singkat suara saya.'],
    vi: ['Xin chào, tôi là {name}. Đây là một đoạn mẫu ngắn giọng nói của tôi.', 'Xin chào! Đây là một đoạn mẫu ngắn giọng nói của tôi.'],
    th: ['สวัสดี ฉันชื่อ {name} นี่คือตัวอย่างเสียงสั้นๆ ของฉัน', 'สวัสดี นี่คือตัวอย่างเสียงสั้นๆ ของฉัน'],
    ko: ['안녕하세요, 저는 {name}입니다. 제 목소리를 잠깐 들려드릴게요.', '안녕하세요! 제 목소리를 잠깐 들려드릴게요.'],
    ja: ['こんにちは、{name}です。これは私の声の短いサンプルです。', 'こんにちは。これは私の声の短いサンプルです。'],
    zh: ['你好，我是{name}。这是我声音的一段简短示例。', '你好！这是我声音的一段简短示例。'],
  };

  // Kokoro voice IDs start with a language letter and a gender letter, e.g. "bf_emma".
  const KOKORO_LANG = { a: 'en-US', b: 'en-GB', e: 'es', f: 'fr', h: 'hi', i: 'it', j: 'ja', p: 'pt-BR', z: 'zh' };
  // Voxtral voice IDs look like "gb_jane_curious".
  const VOXTRAL_LANG = { en: 'en-US', gb: 'en-GB', fr: 'fr-FR', de: 'de-DE', es: 'es-ES', it: 'it-IT', pt: 'pt-PT', nl: 'nl-NL' };
  // MiniMax voice IDs start with a language word, e.g. "English_CalmWoman".
  const LANG_WORDS = { english: 'en', german: 'de', french: 'fr', spanish: 'es', italian: 'it', portuguese: 'pt', japanese: 'ja', korean: 'ko', chinese: 'zh', russian: 'ru', dutch: 'nl', turkish: 'tr' };
  const ENGLISH_ONLY = /^(canopylabs\/orpheus|sesame\/csm|elevenlabs\/eleven-(turbo|flash)-v2$|deepgram\/flux)/;
  const NOT_NAMES = new Set(['none', 'default', 'neutral']);

  const cap = s => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s);
  function humanize(s) {
    return s
      .replace(/([a-z])([A-Z])/g, '$1 $2')
      .replace(/[_]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .split(' ')
      .map(cap)
      .join(' ');
  }

  /**
   * What a voice ID tells us: a display name, a BCP 47 language tag ('' when the voice
   * follows the language of the text), and whether the name reads like a person's name.
   */
  function voiceInfo(modelId, voice) {
    const v = voice || '';
    const provider = modelId.split('/')[0];
    const fallbackLang = ENGLISH_ONLY.test(modelId) ? 'en' : '';
    let m;
    if (!v) return { name: 'Default voice', lang: fallbackLang, personal: false, detail: '' };
    if ((m = v.match(/^([a-z]{2,3}-[A-Z]{2})-(.+?):MAI-Voice/))) return { name: m[2], lang: m[1], personal: true, detail: '' };
    if ((m = v.match(/^(?:aura-2|flux)-([a-z]+)-([a-z]{2})$/))) return { name: cap(m[1]), lang: m[2], personal: true, detail: '' };
    if (provider === 'hexgrad' && (m = v.match(/^([a-z])([fm])_(.+)$/))) {
      return { name: cap(m[3]), lang: KOKORO_LANG[m[1]] || '', personal: true, detail: m[2] === 'f' ? 'female' : 'male' };
    }
    if (provider === 'mistralai' && (m = v.match(/^([a-z]{2})_([a-z]+)_([a-z]+)$/))) {
      return { name: cap(m[2]), lang: VOXTRAL_LANG[m[1]] || m[1], personal: true, detail: m[3] };
    }
    if ((m = v.match(/^([A-Za-z]+)_(.+)$/)) && LANG_WORDS[m[1].toLowerCase()]) {
      return { name: humanize(m[2]), lang: LANG_WORDS[m[1].toLowerCase()], personal: false, detail: '' };
    }
    // Qwen voice IDs are catalog codes rather than names, so they are not spoken.
    if (/^[A-Za-z]+$/.test(v) && provider !== 'qwen' && !NOT_NAMES.has(v.toLowerCase())) return { name: cap(v), lang: fallbackLang, personal: true, detail: '' };
    return { name: humanize(v), lang: fallbackLang, personal: false, detail: '' };
  }

  /** Base language code for filtering, or 'multi' for voices that follow the text's language. */
  function languageGroup(modelId, voice) {
    const { lang } = voiceInfo(modelId, voice);
    return lang ? lang.split('-')[0] : 'multi';
  }

  let displayNames;
  function languageName(tag) {
    if (!tag) return 'Multilingual';
    if (tag === 'multi') return 'Multilingual';
    try {
      displayNames = displayNames || new Intl.DisplayNames(['en'], { type: 'language' });
      return displayNames.of(tag) || tag;
    } catch {
      return tag;
    }
  }

  /**
   * The sentence each voice speaks in its sample. Seed Audio treats input as a prompt, so it gets one.
   * `lang` (a base code such as 'de') asks for a sample in that language instead of the voice's own.
   */
  function sampleText(modelId, voice, lang) {
    const info = voiceInfo(modelId, voice);
    const base = lang || (info.lang || 'en').split('-')[0];
    const [named, plain] = SAMPLE_TEXT[base] || SAMPLE_TEXT.en;
    if (modelId.startsWith('bytedance-seed/')) {
      return base === 'en' ? 'A friendly narrator says: "Hi! This is a quick sample of my voice."' : `A friendly narrator says: "${plain}"`;
    }
    return info.personal ? named.replace('{name}', info.name) : plain;
  }

  // Models whose providers document German synthesis. Not every voice sounds native in German.
  const GERMAN_MODELS = new Set([
    'speechify/simba-3.5', 'assemblyai/assemblyai-tts-1',
    'heygen/heygen-voice-1', 'heygen/heygen-voice-1-turbo', 'heygen/heygen-voice-1-turbo:free',
    'mistralai/voxtral-mini-tts-3-0', 'mistralai/voxtral-mini-tts-2603',
    'fish-audio/drama-3', 'fish-audio/s1', 'fish-audio/s2-pro', 'fish-audio/s2.1-pro', 'fish-audio/s2.1-pro-free:free',
    'elevenlabs/eleven-v4', 'elevenlabs/eleven-v4-turbo', 'elevenlabs/eleven-v3', 'elevenlabs/eleven-v3-conversational',
    'elevenlabs/eleven-flash-v2.5', 'elevenlabs/eleven-turbo-v2.5', 'elevenlabs/eleven-multilingual-v2',
    'microsoft/mai-voice-2.1', 'microsoft/mai-voice-2.1-flash', 'microsoft/mai-voice-2', 'microsoft/mai-voice-2-flash',
    'bytedance-seed/seed-audio-1-0',
    'google/gemini-3.8-flash-tts', 'google/gemini-3.8-flash-lite-tts', 'google/gemini-3.1-flash-tts-preview',
    'deepgram/aura-2', 'deepgram/flux-tts',
    'qwen/qwen-audio-3.0-tts-flash', 'qwen/qwen-audio-3.0-tts-plus',
    'minimax/speech-2.8-hd', 'minimax/speech-2.8-turbo',
    'x-ai/grok-voice-tts-1.0',
  ]);
  // For a model with no multilingual voices, the voice to use for its single German sample.
  const GERMAN_VOICE = {
    'mistralai/voxtral-mini-tts-2603': 'en_paul_neutral',
  };

  /**
   * The voices that get an extra German sample. A German-capable model with no German voice of its
   * own gets one for every multilingual voice, which is any voice not tied to a language. A model
   * whose voices all name another language gets a single sample, so the model is still covered.
   * '' stands for the model's default voice. Returns [] when the model needs none: it is not
   * documented to speak German, or it already has German voices.
   */
  function germanSampleVoices(model) {
    if (!GERMAN_MODELS.has(model.id)) return [];
    const voices = voicesFor(model);
    if (voices.some(v => languageGroup(model.id, v) === 'de')) return [];
    const multilingual = voices.filter(v => languageGroup(model.id, v) === 'multi');
    if (multilingual.length) return multilingual;
    const pick = GERMAN_VOICE[model.id];
    return [pick !== undefined && voices.includes(pick) ? pick : voices[0]];
  }

  const slug = s => String(s).replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^\.+/, '_');

  /** Where a sample lives, relative to the project root and without a file extension. */
  function sampleBase(modelId, voice, lang) {
    const [provider, ...rest] = modelId.split('/');
    return `samples/${slug(provider)}/${slug(rest.join('/'))}/${voice ? slug(voice) : '_default'}${lang ? `.${lang}` : ''}`;
  }

  /** Samples in a language other than the voice's own get that language as a third part of the key. */
  const sampleKey = (modelId, voice, lang) => `${modelId}|${voice || ''}${lang ? `|${lang}` : ''}`;

  // Gemini and HeyGen speech only come back as raw PCM through OpenRouter; asking for mp3 is a 400.
  const PCM_ONLY = /^(google|heygen)\//;
  const learnedFormats = new Map();

  /** The response_format to request for a model, given the format the user would prefer. */
  function responseFormat(modelId, preferred) {
    return learnedFormats.get(modelId) || (PCM_ONLY.test(modelId) ? 'pcm' : preferred || 'mp3');
  }

  /**
   * Reads errors such as 'Gemini TTS only supports response_format="pcm"', remembers that format
   * for the model and returns it, so the caller can retry. Returns null for any other error.
   */
  function learnFormatFromError(modelId, message) {
    const m = /only supports response_format\W*(mp3|pcm|wav|opus|aac|flac)\b/i.exec(message || '');
    if (!m) return null;
    const format = m[1].toLowerCase();
    learnedFormats.set(modelId, format);
    return format;
  }

  /** The voices to sample for a model: its preset list, or the provider's default voice. */
  function voicesFor(model) {
    const vs = Array.isArray(model.supported_voices) ? model.supported_voices : model.voices;
    return Array.isArray(vs) && vs.length ? vs : [''];
  }

  root.VoiceCatalog = { voiceInfo, languageGroup, languageName, sampleText, sampleBase, sampleKey, germanSampleVoices, voicesFor, responseFormat, learnFormatFromError };
})(typeof globalThis !== 'undefined' ? globalThis : window);
