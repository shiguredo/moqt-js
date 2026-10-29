/** 日本語の公開発話サンプルと、読み上げ速度を変えた発話音源を調査用の領域へ用意する。 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

const directory = resolve("investigation-logs/playout-quality-2026-10-28/speech-input");
mkdirSync(directory, { recursive: true });
const revision = "e0e8bbaf98e27d19dfc6fe8312be607ad03592ad";
const base = `https://raw.githubusercontent.com/julius-speech/segmentation-kit/${revision}`;
const manifest = [];
for (const [remote, local] of [
  ["wav/sample.wav", "julius-original.wav"],
  ["License.md", "julius-license.txt"],
  ["wav/sample.txt", "julius-transcript.txt"],
]) {
  const response = await fetch(`${base}/${remote}`, { signal: AbortSignal.timeout(10000) });
  if (!response.ok) throw new Error(`Failed to download ${remote}: ${String(response.status)}`);
  writeFileSync(`${directory}/${local}`, new Uint8Array(await response.arrayBuffer()));
}
execFileSync("ffmpeg", [
  "-v",
  "error",
  "-y",
  "-i",
  `${directory}/julius-original.wav`,
  "-ac",
  "1",
  "-ar",
  "48000",
  "-c:a",
  "pcm_f32le",
  `${directory}/julius.wav`,
]);
manifest.push({
  name: "julius",
  kind: "published-speech",
  source: `https://github.com/julius-speech/segmentation-kit/blob/${revision}/wav/sample.wav`,
  license: "julius-license.txt",
  transcript: "julius-transcript.txt",
});
// 入力の発話内容も保存し、無声子音、破裂音、促音、長音、数字、語尾を再現できるようにする。
const text =
  "今日はいい天気ですね。窓を開けると、小さな鳥の声が聞こえます。パパと弟は、切符を買って出発しました。ささやく声と、大きな声を、交互に確かめてください。一、二、三、四、五。音声の先頭と最後まで、はっきり聞こえていますか。少し待ってから、もう一度話します。これで確認を終わります。";
writeFileSync(`${directory}/generated-transcript.txt`, `${text}\n`);
for (const [name, voice, rate] of [
  ["kyoko", "Kyoko", 170],
  ["kyoko-fast", "Kyoko", 260],
  ["eddy", "Eddy (日本語（日本）)", 170],
  ["grandpa", "Grandpa (日本語（日本）)", 130],
]) {
  execFileSync("say", [
    "-v",
    voice,
    "-r",
    String(rate),
    "-f",
    `${directory}/generated-transcript.txt`,
    "-o",
    `${directory}/${name}.aiff`,
  ]);
  execFileSync("ffmpeg", [
    "-v",
    "error",
    "-y",
    "-i",
    `${directory}/${name}.aiff`,
    "-ac",
    "1",
    "-ar",
    "48000",
    "-c:a",
    "pcm_f32le",
    `${directory}/${name}.wav`,
  ]);
  manifest.push({
    name,
    kind: "system-tts",
    voice,
    wordsPerMinute: rate,
    transcript: "generated-transcript.txt",
  });
}
for (const entry of manifest) {
  const samples = readFileSync(`${directory}/${entry.name}.wav`);
  entry.sha256 = createHash("sha256").update(samples).digest("hex");
  entry.durationSeconds = Number(
    execFileSync(
      "ffprobe",
      [
        "-v",
        "error",
        "-show_entries",
        "format=duration",
        "-of",
        "default=nw=1:nk=1",
        `${directory}/${entry.name}.wav`,
      ],
      { encoding: "utf8" },
    ),
  );
}
writeFileSync(`${directory}/manifest.json`, JSON.stringify(manifest, null, 2));
console.log(`Prepared Japanese speech inputs: ${directory}`);
