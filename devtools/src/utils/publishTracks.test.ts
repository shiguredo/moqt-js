import { test, assert } from "vite-plus/test";
import {
  assertTrackNames,
  resolveAudioAdvertisement,
  resolveTrackNameProblem,
  resolveVideoAdvertisement,
} from "./publishTracks";

// draft-ietf-moq-msf-01 §5.2.3: track name は Required で、catalog の中で namespace ごとに
// 一意でなければならない MUST。空名と同名は配信の前に拒否する
test("resolveTrackNameProblem: 空名と同名を検出し、問題の無い組み合わせでは null を返す", () => {
  // トラックを 1 つも配信しない設定 (映像と音声の入力がどちらも None) は検証する名前が無い
  assert.isNull(resolveTrackNameProblem([]));

  // 1 トラックだけの配信 (映像だけ / 音声だけ) は同名の問題が起きない
  assert.isNull(resolveTrackNameProblem(["video"]));

  // 別名を持つ 2 トラックは問題無し
  assert.isNull(resolveTrackNameProblem(["audio", "video"]));

  // 空名は Required (§5.2.3) に反する
  assert.equal(resolveTrackNameProblem([""]), "empty");
  assert.equal(resolveTrackNameProblem(["video", ""]), "empty");

  // 同名は一意性 (§5.2.3) に反する
  assert.equal(resolveTrackNameProblem(["audio", "audio"]), "duplicate");
  // 空名と同名が同時に起きているときは空名を先に返す (入力の指摘として分かりやすい方)
  assert.equal(resolveTrackNameProblem(["", ""]), "empty");
});

test("assertTrackNames: 問題のある名前で throw し、問題の無い名前では何もしない", () => {
  assertTrackNames([]);
  assertTrackNames(["video"]);
  assertTrackNames(["audio", "video"]);

  assert.throws(
    () => assertTrackNames(["video", ""]),
    /track name must not be empty per draft-ietf-moq-msf-01 §5\.2\.3/,
  );
  assert.throws(
    () => assertTrackNames(["audio", "audio"]),
    /track names must be unique per namespace per draft-ietf-moq-msf-01 §5\.2\.3/,
  );
});

// 映像の入力が None のときは映像トラックを広告しない。カメラの許可は配信を始めるまで
// 確定しないため、ここでは「広告する予定」だけを返す
test("resolveVideoAdvertisement: 入力が None のときだけ広告しない", () => {
  assert.isFalse(resolveVideoAdvertisement("none").advertised);
  assert.deepEqual(resolveVideoAdvertisement("none"), {
    advertised: false,
    reason: "source-none",
  });
  assert.deepEqual(resolveVideoAdvertisement("dummy"), { advertised: true });
  assert.deepEqual(resolveVideoAdvertisement("camera"), { advertised: true });
});

// 音声は入力が None のほかに、MediaStreamTrackProcessor が無いブラウザでも広告しない。
// この 2 つは理由が違うため、画面が別々の文言を出せるように reason で区別する
test("resolveAudioAdvertisement: 入力が None と未対応ブラウザを区別する", () => {
  // 入力が None ならブラウザの対応に関わらず広告しない
  assert.deepEqual(resolveAudioAdvertisement("none", true), {
    advertised: false,
    reason: "source-none",
  });
  assert.deepEqual(resolveAudioAdvertisement("none", false), {
    advertised: false,
    reason: "source-none",
  });

  // 入力はあるが、音声を取り出せないブラウザでは広告しない
  assert.deepEqual(resolveAudioAdvertisement("dummy", false), {
    advertised: false,
    reason: "browser-unsupported",
  });
  assert.deepEqual(resolveAudioAdvertisement("microphone", false), {
    advertised: false,
    reason: "browser-unsupported",
  });

  // Chromium で入力があれば広告する
  assert.deepEqual(resolveAudioAdvertisement("dummy", true), { advertised: true });
  assert.deepEqual(resolveAudioAdvertisement("microphone", true), { advertised: true });
});
