import { readFile } from "node:fs/promises";
import { expect, test } from "@playwright/test";
import {
  collectWorkerScriptReferences,
  findSelfContainmentViolations,
  initConfigForKind,
  openProductionPage,
  PRODUCTION_ORIGIN,
  toWorkerDataUrl,
  type WorkerScriptReference,
} from "./support";

/**
 * 利用側 Vite の production ビルド + moqt-js の既定 useWorker で worker が起動することを
 * 検証する
 *
 * 既存の tests/e2e は dev サーバーと `moqt-js` -> src の alias で動くため、dist の
 * worker 参照が壊れていても検出できない。この spec は tests/e2e/production の
 * production ビルド成果物 (preview が配信するもの) だけを対象にする。
 *
 * 検査は 2 段構えにする。
 *
 * 1. 生成物の検査: ビルドされた JS が `new Worker` へ渡す URL の参照先を解決し、
 *    モジュール解決を要求しない (自己完結した) スクリプトであることを確かめる
 * 2. 実行の検査: 実際の Chromium でその URL から本物の DedicatedWorker を起動し、
 *    worker 自身が実装する init プロトコルへ応答することを確かめる
 *
 * モックやスタブは使わない。参照先は preview が配信する成果物そのものである。
 */

/** 参照元の表示名を作る */
function referenceLabel(reference: WorkerScriptReference): string {
  const kind = reference.kind ?? "種類不明";
  return `${kind} (${reference.chunk})`;
}

/** 参照をブラウザから読める絶対 URL へ変換する */
function toRuntimeUrl(reference: WorkerScriptReference): string {
  if (reference.url.startsWith("data:")) {
    return reference.url;
  }
  // ビルドされた JS の literal は、その JS 自身の位置を基準に解決される
  const chunkUrl = new URL(reference.chunk, `${PRODUCTION_ORIGIN}/`).href;
  return new URL(reference.url, chunkUrl).href;
}

test("production ビルドのアプリが配信され、moqt-js の公開 API が読み込める", async ({ page }) => {
  await openProductionPage(page);

  // dist を読み込めていれば版が取れる (空文字や undefined なら bundle が壊れている)
  const version = await page.evaluate(() => window.__moqtProduction.moqtVersion);
  expect(version).toMatch(/^\d+\.\d+\.\d+/);
});

test("production ビルドが publisher の既定経路で使う worker を参照している", async () => {
  const references = await collectWorkerScriptReferences();
  const kinds = references
    .filter((reference) => reference.referenced)
    .map((reference) => reference.kind);

  // createMediaPublisher の既定 useWorker は音声と映像のエンコーダー worker を読む。
  // 参照が 1 つも無い場合は「検査対象を見つけられていない」ため、green にしてはいけない
  expect(kinds, `参照された worker: ${JSON.stringify(kinds)}`).toContain("audioEncoder");
  expect(kinds, `参照された worker: ${JSON.stringify(kinds)}`).toContain("videoEncoder");
});

test("worker の参照先が preview から配信されている", async ({ request }) => {
  const references = await collectWorkerScriptReferences();
  expect(references.length).toBeGreaterThan(0);

  for (const reference of references) {
    if (reference.url.startsWith("data:")) {
      // インライン化された場合は JS へ埋め込まれているため、配信の確認は不要である
      expect(reference.url.startsWith("data:text/javascript")).toBe(true);
      continue;
    }
    const response = await request.get(toRuntimeUrl(reference));
    expect.soft(response.status(), `${referenceLabel(reference)} が配信されていない`).toBe(200);
    expect.soft(response.headers()["content-type"]).toContain("javascript");
  }
});

test("worker スクリプトが自己完結している (モジュール解決を要求しない)", async () => {
  const references = await collectWorkerScriptReferences();
  expect(references.length).toBeGreaterThan(0);

  for (const reference of references) {
    const violations = findSelfContainmentViolations(reference.script);
    expect
      .soft(
        violations,
        `${referenceLabel(reference)} の参照先が自己完結していない。` +
          `new Worker へ渡る URL は相対解決を保証しない (data URL は階層を持たない)`,
      )
      .toEqual([]);
    // 検査対象が worker スクリプトであること自体を確かめる (空ファイルを green にしない)
    expect
      .soft(reference.script, `${referenceLabel(reference)} が worker スクリプトでない`)
      .toContain("self.onmessage");
  }
});

test("参照された worker が実 Chromium の実 Worker として起動し init へ応答する", async ({
  page,
}) => {
  await openProductionPage(page);

  const collected = await collectWorkerScriptReferences();
  const references = collected.filter((reference) => reference.referenced);
  expect(references.length).toBeGreaterThan(0);

  for (const reference of references) {
    const result = await page.evaluate(
      ([url, config]) => window.__moqtProduction.probeWorkerModule(url, config),
      [toRuntimeUrl(reference), initConfigForKind(reference.kind)] as const,
    );

    // 応答が返る = worker スクリプトの評価と init の実行まで到達している。
    // 壊れた worker は new Worker 直後にロードエラーになるため、ここで落ちる
    expect(
      result.kind,
      `${referenceLabel(reference)} の worker が起動しなかった: ${JSON.stringify(result)}`,
    ).toBe("message");

    const data = result.kind === "message" ? (result.data as { type?: unknown }) : null;
    expect
      .soft(
        data?.type,
        `${referenceLabel(reference)} の init 応答が契約外: ${JSON.stringify(data)}`,
      )
      .toBe("configured");
  }
});

test("参照された worker は data URL へインライン化しても起動する", async ({ page }) => {
  await openProductionPage(page);

  // 利用者の assetsInlineLimit が worker のサイズより大きい場合、Vite は worker を
  // data URL へインライン化する。配信された成果物と同じバイト列を data URL へ入れて
  // その経路を確かめる。data URL は階層を持たないため、相対 import が 1 つでも
  // 残っていれば起動しない (ファイル出力された成果物でも同じバイト列である)。
  const collected = await collectWorkerScriptReferences();
  const references = collected.filter((reference) => reference.referenced);
  expect(references.length).toBeGreaterThan(0);

  for (const reference of references) {
    const result = await page.evaluate(
      ([url, config]) => window.__moqtProduction.probeWorkerModule(url, config),
      [toWorkerDataUrl(reference.script), initConfigForKind(reference.kind)] as const,
    );
    expect(
      result.kind,
      `${referenceLabel(reference)} を data URL として起動できなかった: ${JSON.stringify(result)}`,
    ).toBe("message");
  }
});

test("URL として不正な参照では probe が構築失敗としてエラーを返す", async ({ page }) => {
  await openProductionPage(page);

  // new Worker は URL を解釈できないとき同期で例外を投げる (worker は生成されない)。
  // このときプローブが worker を持たないまま終了処理を通り、TypeError で reject して
  // いないことを確かめる (テストが「エラー応答」ではなく「プローブ自体の失敗」で
  // 落ちる状態を検出する)。
  const result = await page.evaluate(() =>
    window.__moqtProduction.probeWorkerModule("http://[invalid", {}),
  );

  expect(result.kind, `エラー応答にならなかった: ${JSON.stringify(result)}`).toBe("error");
  if (result.kind === "error") {
    expect(result.phase, `同期の構築失敗として扱われていない: ${JSON.stringify(result)}`).toBe(
      "construct",
    );
    expect(result.message.length, "失敗理由が空である").toBeGreaterThan(0);
  }
});

test("存在しない同一オリジンの参照では probe がロード失敗としてエラーを返す", async ({ page }) => {
  await openProductionPage(page);

  // 構築はできるがスクリプトを取得できない URL。構築失敗とは別の経路であることを
  // 確かめる (非同期の onerror で settle する)。
  // 別オリジンの URL は Chromium が構築時に同オリジン検査で弾くため、同一オリジンで
  // 存在しないパスを使う (preview の fallback で HTML が返っても、モジュールとして
  // 解釈できないためロード失敗になる)
  const result = await page.evaluate(() =>
    window.__moqtProduction.probeWorkerModule(`${location.origin}/nonexistent-worker.js`, {}),
  );

  expect(result.kind, `エラー応答にならなかった: ${JSON.stringify(result)}`).toBe("error");
  if (result.kind === "error") {
    expect(result.phase, `ロード失敗として扱われていない: ${JSON.stringify(result)}`).toBe("load");
  }
});

test("自己完結の検査が minify 形式の import と re-export を検出する", async () => {
  // 検査器そのものの契約を、実際に問題になる形で pin する。成果物は minify されるため、
  // 空白の無い import と re-export を見落とすと、壊れた worker を green にしてしまう
  const cases: ReadonlyArray<{
    label: string;
    script: string;
    expectViolation: boolean;
  }> = [
    {
      label: "minify された相対 import",
      script: 'import{x as a}from"../../workerMessages-DxvrYa2p.js";self.onmessage=()=>{}',
      expectViolation: true,
    },
    {
      label: "整形された相対 import",
      script:
        'import { a as x } from "../../workerMessages-DxvrYa2p.js";\nself.onmessage = () => {};',
      expectViolation: true,
    },
    {
      label: "副作用だけの import",
      script: 'import"./setup.js";self.onmessage=()=>{}',
      expectViolation: true,
    },
    {
      label: "minify された re-export",
      script: 'export{a}from"./helper.js";self.onmessage=()=>{}',
      expectViolation: true,
    },
    {
      label: "星付きの re-export",
      script: 'export * from "./helper.js";self.onmessage=()=>{}',
      expectViolation: true,
    },
    {
      label: "動的 import",
      script: 'self.onmessage=()=>{import("./helper.js")}',
      expectViolation: true,
    },
    {
      label: "import.meta.url 基準の相対 URL",
      script: 'const u=new URL("./helper.js",import.meta.url);self.onmessage=()=>{}',
      expectViolation: true,
    },
    {
      label: "自己完結した worker",
      script: "const a=1;self.onmessage=(event)=>self.postMessage({type:a,data:event.data});",
      expectViolation: false,
    },
    {
      label: "import.meta.url を参照するだけの自己完結した worker",
      script: "self.onmessage=()=>self.postMessage({url:import.meta.url});",
      expectViolation: false,
    },
  ];

  for (const testCase of cases) {
    const violations = findSelfContainmentViolations(testCase.script);
    if (testCase.expectViolation) {
      expect
        .soft(violations.length, `${testCase.label} を検出できなかった: ${testCase.script}`)
        .toBeGreaterThan(0);
    } else {
      expect
        .soft(violations, `${testCase.label} を誤検知した: ${JSON.stringify(violations)}`)
        .toEqual([]);
    }
  }
});

test("production アプリのビルドが src alias を持たない (dist を検証している)", async () => {
  // このテストは検証対象ではなく検証の前提を守るためのものである。src へ alias を張ると
  // アプリ側の Vite が src を直接バンドルし、dist の壊れ方を再現できなくなる。
  // vite.config.ts の assertMoqtJsResolvesToDist がビルド時に同じ前提を検査しており、
  // ここではその検査が外れていないことと、alias が書かれていないことを確かめる。
  const config = await readFile(new URL("./vite.config.ts", import.meta.url), "utf8");
  expect(config).toContain("assertMoqtJsResolvesToDist");
  // src への alias は resolve.alias に moqt-js をキーとして書く形でしか成立しない
  // (コメント中の言及と区別するため、キーとしての形だけを見る)
  expect(config).not.toMatch(/["'`]moqt-js["'`]\s*:/);
});
