/**
 * CI でテストがハングしたときに、どのファイル / テストまで進んだかを追う reporter
 *
 * 通常の reporter はテストの完了時にしか出力しないため、ハングした時点で「何が動いて
 * いたか」がログに残らない。開始と終了を即時 stderr へ出し、ジョブのタイムアウト時に
 * 最後の行から原因のテストを特定できるようにする。
 *
 * `MOQT_TEST_TRACE=1` のときだけ vite.config.ts が読み込む。
 */

/** 1 行を即時出力する (バッファに残さない) */
function write(line) {
  process.stderr.write(`[test-trace ${new Date().toISOString()}] ${line}\n`);
}

export default class TestTraceReporter {
  onTestRunStart() {
    write("run start");
  }

  onTestRunEnd() {
    write("run end");
  }

  onTestModuleStart(module) {
    write(`module start ${module?.moduleId ?? module?.id ?? "unknown"}`);
  }

  onTestModuleEnd(module) {
    write(`module end ${module?.moduleId ?? module?.id ?? "unknown"}`);
  }

  onTestStart(test) {
    const moduleId = test?.module?.moduleId ?? test?.file?.filepath ?? "unknown";
    write(`test start ${moduleId} :: ${test?.name ?? "unknown"}`);
  }

  onTestFinished(test) {
    const moduleId = test?.module?.moduleId ?? test?.file?.filepath ?? "unknown";
    write(`test done ${moduleId} :: ${test?.name ?? "unknown"}`);
  }
}
