/** wasm32 対応の LLVM clang で固定次数の数値カーネルを再生成する。 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const source = resolve(import.meta.dirname, "../src/playout/wasm/audioPredictor.c");
const destination = resolve(import.meta.dirname, "../src/playout/wasm/audioPredictorBytes.ts");
const compiler = process.env.PLAYOUT_WASM_CC ?? "clang";
const directory = mkdtempSync(join(tmpdir(), "moqt-audio-wasm-"));
try {
  const output = join(directory, "audioPredictor.wasm");
  execFileSync(compiler, [
    "--target=wasm32",
    "-O3",
    "-ffp-contract=off",
    "-nostdlib",
    "-Wl,--no-entry",
    "-Wl,--export-memory",
    "-Wl,--initial-memory=131072",
    "-Wl,--max-memory=131072",
    "-Wl,--export=coefficients_address",
    "-Wl,--export=history_address",
    "-Wl,--export=samples_address",
    "-Wl,--export=generate",
    source,
    "-o",
    output,
  ]);
  const bytes = readFileSync(output);
  const sourceHash = createHash("sha256").update(readFileSync(source)).digest("hex");
  const lines = Array.from(
    { length: Math.ceil(bytes.length / 20) },
    (_, index) => "  " + [...bytes.subarray(index * 20, (index + 1) * 20)].join(", ") + ",",
  );
  writeFileSync(
    destination,
    `// generate-audio-predictor-wasm.mjs で生成する。手で編集しない。\n// 元ソースの SHA-256: ${sourceHash}\nexport const audioPredictorBytes = new Uint8Array([\n${lines.join("\n")}\n]);\n`,
  );
  execFileSync("vp", ["fmt", destination], { stdio: "inherit" });
} finally {
  rmSync(directory, { recursive: true, force: true });
}
