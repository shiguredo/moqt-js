/**
 * 再生の入口 (MediaPlayout) の E2E が使うテストページと、実ブラウザ側モジュールの読み込み
 *
 * 実リレーへは接続しない。dev サーバーが配信するページを開き、`page.evaluate` から
 * 公開 API (`src/index.ts`) と実ブラウザのヘルパー (playoutBrowserHarness.ts) を直接読む。
 * 2 つのスペックで同じ URL と `page.evaluate` の定型を書かないよう、ここ 1 か所に置く。
 */

import { resolve } from "node:path";
import type { Page } from "@playwright/test";
import { RELAY_PAGE_URL } from "./urls";

/** 公開 API (`src/index.ts`) のモジュール URL。dev サーバーが配信するソースを直接読む */
export const PLAYOUT_MODULE_URL = new URL(`/@fs${resolve("src/index.ts")}`, RELAY_PAGE_URL).href;

/** 実ブラウザの共通ヘルパー (`playoutBrowserHarness.ts`) の URL */
export const PLAYOUT_HARNESS_URL = new URL("./playoutBrowserHarness.ts", RELAY_PAGE_URL).href;

/** `page.evaluate` の本体へ渡す、実ブラウザ側モジュールの URL */
export interface PlayoutBrowserModules {
  readonly moduleUrl: string;
  readonly harnessUrl: string;
}

/**
 * 再生の入口のテストページを開く
 *
 * @param page - 開く Playwright のページ
 */
export async function openPlayoutPage(page: Page): Promise<void> {
  await page.goto(RELAY_PAGE_URL);
}

/**
 * 実ブラウザのコンテキストで本体を実行する
 *
 * 公開 API と共通ヘルパーの URL を毎回書かずに済むよう、ここで渡す。本体は関数として
 * ブラウザへ渡されるため、外側の変数を参照せず引数だけで完結させること。
 *
 * @param page - 実行する Playwright のページ
 * @param body - 実ブラウザで実行する本体。引数に URL と、`arg` で渡した値が入る
 * @param arg - 本体へ渡す追加の値 (省略できる)
 * @returns 本体の戻り値
 */
export function evaluatePlayout<Arg extends object, Result>(
  page: Page,
  body: (modules: Arg & PlayoutBrowserModules) => Result | Promise<Result>,
  arg?: Arg,
): Promise<Result> {
  const evaluateArg: Arg & PlayoutBrowserModules = {
    ...(arg ?? ({} as Arg)),
    moduleUrl: PLAYOUT_MODULE_URL,
    harnessUrl: PLAYOUT_HARNESS_URL,
  };
  // Playwright は引数を直列化できる形へ写してから本体へ渡すため、ここでは具体の形へ
  // 寄せて渡す (呼び出し側の型は、この関数の引数の型で担保する)
  const pageFunction = body as (modules: PlayoutBrowserModules) => Result | Promise<Result>;
  return page.evaluate(pageFunction, evaluateArg);
}
