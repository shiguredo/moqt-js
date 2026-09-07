/**
 * Worker 初期化の応答契約と完了管理のテスト
 *
 * Wrapper と Worker はブラウザ依存 (Worker 生成・WebCodecs) のため、
 * ブラウザ非依存の純粋部分 (応答生成・完了管理) を pin する。
 * 配線 (メッセージの送受信) はレビューで確認する。
 */

import { test, assert } from "vite-plus/test";
import { runWorkerInit, WorkerConfigureGate } from "./workerConfigure";

// ============================================================================
// runWorkerInit
// ============================================================================

test("runWorkerInit: 成功時は configured を返す", () => {
  // 正常な init は成功応答になる
  let called = false;
  const result = runWorkerInit(() => {
    called = true;
  });

  assert.isTrue(called);
  assert.deepEqual(result, { type: "configured" });
});

test("runWorkerInit: Error の throw 時は error と文言を返す", () => {
  // 未対応コーデック等の初期化失敗は失敗応答になり、configured は返らない
  const result = runWorkerInit(() => {
    throw new Error("unsupported codec");
  });

  assert.deepEqual(result, { type: "error", message: "unsupported codec" });
});

test("runWorkerInit: message 持ち非 Error は文言を優先する", () => {
  // DOMException 相当 (Error 継承を持たない message 持ち) の再現。
  // String 化すると "[object ...]" になり文言が失われるため優先する
  const domExceptionLike: Error = {
    message: "NotSupportedError",
    name: "NotSupportedError",
  } as unknown as Error;
  const result = runWorkerInit(() => {
    throw domExceptionLike;
  });

  assert.deepEqual(result, { type: "error", message: "NotSupportedError" });
});

test("runWorkerInit: 文言なし非 Error は文字列化して返す", () => {
  // message を持たない値の送出時は String 化する (形状は保つ)
  const foreign: Error = undefined as unknown as Error;
  const result = runWorkerInit(() => {
    throw foreign;
  });

  assert.deepEqual(result, { type: "error", message: "undefined" });
});

test("runWorkerInit: message 取得失敗時も error 応答になる", () => {
  // message アクセス自体が送出する値でも例外を漏らさず error 応答になる。
  // String 化は message を読まないため "[object Object]" に落ちる
  const poisoned = Object.defineProperty({}, "message", {
    get(): string {
      throw new Error("poisoned");
    },
  }) as unknown as Error;
  const result = runWorkerInit(() => {
    throw poisoned;
  });

  assert.deepEqual(result, { type: "error", message: "[object Object]" });
});

test("runWorkerInit: 非 string の message は文字列化して返す", () => {
  // message が string でない場合は String 化に落とす (message 契約を守る)
  const numbered = { message: 42 } as unknown as Error;
  const result = runWorkerInit(() => {
    throw numbered;
  });

  assert.deepEqual(result, { type: "error", message: "[object Object]" });
});

test("runWorkerInit: 空文言の Error は型名に落とす", () => {
  // 空文言のまま reject すると原因特定ができないため非空を保証する
  const result = runWorkerInit(() => {
    const empty = new Error("placeholder");
    empty.message = "";
    throw empty;
  });

  assert.deepEqual(result, { type: "error", message: "Error" });
});

// ============================================================================
// WorkerConfigureGate
// ============================================================================

/**
 * Wrapper の振り分け (初回応答は settle、遅延 error は通知、
 * 遅延 configured は黙殺) を模した手順。
 * ブラウザ依存の配線自体は実行できないため、順序依存をこの形で pin する。
 */
function routeByGate(gate: WorkerConfigureGate, settled: string[], notified: string[]) {
  return {
    // 実配線の case "configured" と同一 (遅延到達は黙殺する)
    onConfigured: () => {
      if (gate.trySettle()) {
        settled.push("configured");
      }
    },
    // 実配線の case "error" と同一 (遅延到達は通知する)
    onError: () => {
      if (gate.trySettle()) {
        settled.push("error");
      } else {
        notified.push("error");
      }
    },
  };
}

test("WorkerConfigureGate: configured 優先で error は通知に回る", () => {
  // 初期化成功後の運用中 error は reject ではなく通知である
  const gate = new WorkerConfigureGate();
  const settled: string[] = [];
  const notified: string[] = [];
  const onResponse = routeByGate(gate, settled, notified);

  onResponse.onConfigured();
  onResponse.onError();

  assert.deepEqual(settled, ["configured"]);
  assert.deepEqual(notified, ["error"]);
});

test("WorkerConfigureGate: error 優先で configured は無視される", () => {
  // 初期化失敗の reject 後に遅延 configured が届いても二重解決せず通知もしない
  const gate = new WorkerConfigureGate();
  const settled: string[] = [];
  const notified: string[] = [];
  const onResponse = routeByGate(gate, settled, notified);

  onResponse.onError();
  onResponse.onConfigured();

  assert.deepEqual(settled, ["error"]);
  assert.deepEqual(notified, []);
});

test("WorkerConfigureGate: 複数インスタンスは独立する", () => {
  // 再 configure は新しい管理で行い、前回の完了に影響されない
  const first = new WorkerConfigureGate();
  const second = new WorkerConfigureGate();

  assert.isTrue(first.trySettle());
  assert.isTrue(second.trySettle());
});
