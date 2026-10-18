// What the local voice can download: the speech to text models (whisper.cpp, multilingual), the
// whisper.cpp server build for this platform, the Piper text to speech program and one Piper voice
// per language. Every file has its exact size and SHA-256, so the consent dialog shows the real
// size and the download is verified like the chat models (src/brain/models.js downloadModel).
//
// Sources: huggingface.co/ggerganov/whisper.cpp (models), github.com/ggml-org/whisper.cpp release
// b5454 (server builds), github.com/rhasspy/piper release 2023.11.14-2 (Piper program) and
// huggingface.co/rhasspy/piper-voices (voices). Checksums were read from those sources (LFS oids
// and the release digests) or computed from the published files when no digest was published.

const HF_WHISPER = 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main';
const GH_WHISPER = 'https://github.com/ggml-org/whisper.cpp/releases/download/b5454';
const GH_PIPER = 'https://github.com/rhasspy/piper/releases/download/2023.11.14-2';
const HF_PIPER = 'https://huggingface.co/rhasspy/piper-voices/resolve/main';

/**
 * Speech to text models. ram: what whisper.cpp needs to run it (its README), so the choice can be
 * honest on a computer with little free memory. speed: rough real time factor on 4 CPU cores.
 */
export const STT_MODELS = [
  { id: 'tiny', name: 'Whisper tiny', file: 'ggml-tiny.bin', bytes: 77691713, sha256: 'be07e048e1e599ad46341c8d2a135645097a538221678b7acdd1b1919c6e1b21', ram: 273e6, quality: 1, cpuRtf: 0.15 },
  { id: 'base', name: 'Whisper base', file: 'ggml-base.bin', bytes: 147951465, sha256: '60ed5bc3dd14eea856493d334349b405782ddcaf0028d4b5df4088345fba2efe', ram: 388e6, quality: 2, cpuRtf: 0.3 },
  { id: 'small', name: 'Whisper small', file: 'ggml-small.bin', bytes: 487601967, sha256: '1be3a9b2063867b937e64e2ec7483364a79917e157fa98c5d94b5c1fffea987b', ram: 852e6, quality: 3, cpuRtf: 1 }
].map((m) => ({ ...m, kind: 'stt', license: 'MIT', source: 'huggingface.co/ggerganov/whisper.cpp', url: `${HF_WHISPER}/${m.file}` }));

/**
 * whisper.cpp server builds. A platform without a published build (macOS) uses a whisper-server the
 * user installed (Homebrew: brew install whisper-cpp), found on PATH or in HIVEDESK_WHISPER_SERVER.
 */
export const STT_RUNTIMES = [
  { id: 'whisper-win-x64-cpu', platform: 'win32', arch: 'x64', gpu: null, file: 'whisper-bin-x64.zip', bytes: 8928640, sha256: '6ba69e3482d7826214f90a6a9c84ca07782aec1e1d0c6a7c30c994fd5d816ccb' },
  { id: 'whisper-win-x64-cuda', platform: 'win32', arch: 'x64', gpu: 'cuda', file: 'whisper-bin-win-cuda-11.8.0-x64.zip', bytes: 284761231, sha256: 'e81c86c542be6e3d7b7245392d4e1c52ab6e5c61dbe38721754bc0ab59d4d027' },
  { id: 'whisper-win-arm64-cpu', platform: 'win32', arch: 'arm64', gpu: null, file: 'whisper-bin-win-cpu-arm64.zip', bytes: 4371193, sha256: '28c37e7b598c3d9bbfef94f3bd67f2ee6f12b7c86f3da5edcf5e4308d615ff6d' },
  { id: 'whisper-linux-x64-cpu', platform: 'linux', arch: 'x64', gpu: null, file: 'whisper-bin-ubuntu-x64.tar.gz', bytes: 10364195, sha256: 'a72becf15d7917f990f6313867a52638b82b7f9ef237fb0c980dac56a135781c' },
  { id: 'whisper-linux-arm64-cpu', platform: 'linux', arch: 'arm64', gpu: null, file: 'whisper-bin-ubuntu-arm64.tar.gz', bytes: 4608377, sha256: '6b95ebfc60447df48e70ef00a73bdc3f41679ed2d01ef465827206a2ff325149' }
].map((r) => ({ ...r, kind: 'stt-runtime', name: `whisper.cpp server (${r.gpu ? r.gpu.toUpperCase() : 'CPU'})`, license: 'MIT', source: 'github.com/ggml-org/whisper.cpp', url: `${GH_WHISPER}/${r.file}`, binary: 'whisper-server' }));

export const TTS_RUNTIMES = [
  { id: 'piper-win-x64', platform: 'win32', arch: 'x64', file: 'piper_windows_amd64.zip', bytes: 22477236, sha256: 'f3c58906402b24f3a96d92145f58acba6d86c9b5db896d207f78dc80811efcea' },
  { id: 'piper-linux-x64', platform: 'linux', arch: 'x64', file: 'piper_linux_x86_64.tar.gz', bytes: 26460462, sha256: 'a50cb45f355b7af1f6d758c1b360717877ba0a398cc8cbe6d2a7a3a26e225992' },
  { id: 'piper-linux-arm64', platform: 'linux', arch: 'arm64', file: 'piper_linux_aarch64.tar.gz', bytes: 26004717, sha256: 'fea0fd2d87c54dbc7078d0f878289f404bd4d6eea6e7444a77835d1537ab88eb' },
  { id: 'piper-mac-x64', platform: 'darwin', arch: 'x64', file: 'piper_macos_x64.tar.gz', bytes: 19146927, sha256: 'ced85c0a3df13945b1e623b878a48fdc2854d5c485b4b67f62857cf551deaf8b' },
  { id: 'piper-mac-arm64', platform: 'darwin', arch: 'arm64', file: 'piper_macos_aarch64.tar.gz', bytes: 19146957, sha256: '6b1eb03b3735946cb35216e063e7eebcc33a6bbf5dd96ec0217959bf1cdcb0cc' }
].map((r) => ({ ...r, kind: 'tts-runtime', name: 'Piper', license: 'MIT', source: 'github.com/rhasspy/piper', url: `${GH_PIPER}/${r.file}`, binary: 'piper' }));

const voice = (locale, dir, name, onnxSha, jsonBytes, jsonSha, bytes = 63201294) => ({
  id: `piper-${name}`, kind: 'tts', locale, name, license: 'see the voice MODEL_CARD', source: 'huggingface.co/rhasspy/piper-voices',
  files: [
    { file: `${name}.onnx`, bytes, sha256: onnxSha, url: `${HF_PIPER}/${dir}/${name}.onnx` },
    { file: `${name}.onnx.json`, bytes: jsonBytes, sha256: jsonSha, url: `${HF_PIPER}/${dir}/${name}.onnx.json` }
  ]
});

/** One medium quality Piper voice per language. Piper publishes no Japanese or Korean voice. */
export const TTS_VOICES = [
  voice('en', 'en/en_US/lessac/medium', 'en_US-lessac-medium', '5efe09e69902187827af646e1a6e9d269dee769f9877d17b16b1b46eeaaf019f', 4885, 'efe19c417bed055f2d69908248c6ba650fa135bc868b0e6abb3da181dab690a0'),
  voice('pt-BR', 'pt/pt_BR/faber/medium', 'pt_BR-faber-medium', '858555e3a064209c57088fe6bd70c4c3dc54d03eaa00c45d5ecaf43a33f95aa7', 4855, '7e694de195ae3fc36dd732c445eb04fb49b649854893cb5506b978f0d50a1d6f'),
  voice('es', 'es/es_ES/davefx/medium', 'es_ES-davefx-medium', '6658b03b1a6c316ee4c265a9896abc1393353c2d9e1bca7d66c2c442e222a917', 4817, '0e0dda87c732f6f38771ff274a6380d9252f327dca77aa2963d5fbdf9ec54842'),
  voice('fr', 'fr/fr_FR/siwis/medium', 'fr_FR-siwis-medium', '641d1ab097da2b81128c076810edb052b385decc8be3381814802a64a73baf99', 4875, '39479916c2db192b5ac9764daddd0c744d83e023ad890c6976c0633ae4df8959'),
  voice('de', 'de/de_DE/thorsten/medium', 'de_DE-thorsten-medium', '7e64762d8e5118bb578f2eea6207e1a35a8e0c30595010b666f983fc87bb7819', 4819, '974adee790533adb273a1ac88f49027d2a1b8f0f2cf4905954a4791e79264e85'),
  voice('it', 'it/it_IT/paola/medium', 'it_IT-paola-medium', '6fc918b5a0ea6137382833dddfa567bffbe6a5060c02043c87192ee59c04210c', 7099, 'aea19c0a7fce29fbc359b93f10e7902854401e4c95ae2ea328ae516b15d296cf', 63511038),
  voice('zh-CN', 'zh/zh_CN/huayan/medium', 'zh_CN-huayan-medium', '9929917bf8cabb26fd528ea44d3a6699c11e87317a14765312420be230be0f3d', 4822, 'd521dc45504a8ccc99e325822b35946dd701840bfb07e3dbb31a40929ed6a82b'),
  voice('ru', 'ru/ru_RU/irina/medium', 'ru_RU-irina-medium', '8ff38212d23da300bbe3705c645e6e5b9475f0bfde01558eb17813e22acaaaaa', 4765, 'c2ec28bb38e2b59e93b959b3e40348c1afebbd272f30fed5d41205d08e98a9d7')
].map((v) => ({ ...v, bytes: v.files.reduce((n, f) => n + f.bytes, 0) }));

/** whisper.cpp language codes for the ten UI locales. */
export const WHISPER_LANG = { en: 'en', 'pt-BR': 'pt', es: 'es', fr: 'fr', de: 'de', it: 'it', ja: 'ja', ko: 'ko', 'zh-CN': 'zh', ru: 'ru' };

export const sttModel = (id) => STT_MODELS.find((m) => m.id === id) || null;
export const ttsVoice = (locale) => TTS_VOICES.find((v) => v.locale === locale) || null;
export const ttsVoiceById = (id) => TTS_VOICES.find((v) => v.id === id) || null;

/** The published whisper.cpp server builds for this platform (CPU first). */
export function sttRuntimesFor(platform = process.platform, arch = process.arch) {
  return STT_RUNTIMES.filter((r) => r.platform === platform && r.arch === arch);
}

export function ttsRuntimeFor(platform = process.platform, arch = process.arch) {
  return TTS_RUNTIMES.find((r) => r.platform === platform && r.arch === arch) || null;
}

export function anyById(id) {
  return STT_MODELS.find((m) => m.id === id) || STT_RUNTIMES.find((r) => r.id === id) || TTS_RUNTIMES.find((r) => r.id === id) || ttsVoiceById(id);
}

/**
 * Which whisper model and build to recommend for this hardware.
 * A GPU the build can use (NVIDIA on Windows, Metal through a Homebrew build) runs small in real time;
 * on the CPU, base is the best trade off from 8 threads and tiny below, and free RAM caps the choice.
 * @param {{ gpu?: { name?: string, backend?: string, vramBytes?: number } | null, cpus?: number, ramBytes?: number, freeRamBytes?: number, os?: string, arch?: string }} hw
 * @returns {{ model: string, runtime: string | null, device: 'gpu' | 'cpu', reason: string }}
 */
export function recommendStt(hw = {}) {
  const os = hw.os || process.platform;
  const arch = hw.arch || process.arch;
  const builds = sttRuntimesFor(os, arch);
  const nvidia = !!hw.gpu && (/nvidia|geforce|rtx|gtx|quadro|tesla/i.test(hw.gpu.name || '') || hw.gpu.backend === 'cuda');
  const metal = os === 'darwin' && hw.gpu?.backend === 'metal';
  const cudaBuild = nvidia ? builds.find((b) => b.gpu === 'cuda') : null;
  const free = Number(hw.freeRamBytes) || Number(hw.ramBytes) || 0;
  const threads = Number(hw.cpus) || 4;
  const fits = (m) => !free || free > m.ram + 300e6;
  let model;
  let reason;
  if ((cudaBuild || metal) && fits(sttModel('small'))) { model = 'small'; reason = 'gpu'; }
  else if (threads >= 8 && fits(sttModel('base'))) { model = 'base'; reason = 'cpu_fast'; }
  else { model = 'tiny'; reason = free && !fits(sttModel('base')) ? 'low_ram' : 'cpu_small'; }
  const cpuBuild = builds.find((b) => !b.gpu) || null;
  // The CPU build is the default download (9 MB); the CUDA build (285 MB) is offered beside it.
  return { model, runtime: cpuBuild?.id || null, gpuRuntime: cudaBuild?.id || null, device: cudaBuild || metal ? 'gpu' : 'cpu', reason };
}
