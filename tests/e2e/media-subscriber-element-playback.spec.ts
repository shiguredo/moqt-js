/**
 * 高レベル API の音声と映像を同じ video 要素へ接続する。
 * 入力の識別子を音声の振幅と映像の画素へ埋め、内部の同期統計に頼らず観測する。
 * 音声は MediaStream の分岐点、映像は要素の表示通知で測る。スピーカーとの同期測定ではない。
 */
import { test } from "@playwright/test";
import {
  defineElementPlaybackTests,
  elementPlaybackLaunchOptions,
} from "./elementPlaybackDiagnostics";

test.use(elementPlaybackLaunchOptions);
defineElementPlaybackTests("trace=default", 1);
