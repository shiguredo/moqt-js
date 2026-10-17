/**
 * WebCodecs の設定対応確認のテスト
 *
 * Node には WebCodecs が無いため、globalThis.VideoDecoder / globalThis.AudioEncoder を
 * 境界として置き換え、判定規則 (false と reject の両方を非対応として扱う / supported が
 * 明示的に true のときだけ対応とみなす / WebCodecs 非搭載は別の文言で失敗する) だけを
 * 固定する。実ブラウザの WebCodecs を駆動する経路は e2e で確認する。
 */

import { test, assert } from "vite-plus/test";
import {
  probeAudioEncoderConfig,
  isAudioEncoderConfigSupported,
  isVideoDecoderConfigSupported,
} from "./configSupport";
import { withAudioData, withAudioEncoder, withVideoDecoder } from "../testSupport/helpers";

/** 確認に使う映像デコーダー設定 (実際に configure する設定と同じ形) */
const CONFIG: VideoDecoderConfig = {
  codec: "vp8",
  codedWidth: 320,
  codedHeight: 240,
};

/** 確認に使う音声エンコーダー設定 (実際に configure する設定と同じ形) */
const AUDIO_CONFIG: AudioEncoderConfig = {
  codec: "opus",
  sampleRate: 48000,
  numberOfChannels: 1,
  bitrate: 64000,
};

test("isVideoDecoderConfigSupported: supported が true なら対応とみなす", async () => {
  // 対応を申告した設定はそのまま対応になる
  const probedConfigs: VideoDecoderConfig[] = [];
  await withVideoDecoder(
    {
      isConfigSupported: async (config: VideoDecoderConfig) => {
        probedConfigs.push(config);
        return { supported: true };
      },
    },
    async () => {
      assert.isTrue(await isVideoDecoderConfigSupported(CONFIG));
    },
  );
  // 確認した設定はそのまま (複製や改変をしない) 渡される
  assert.deepEqual(probedConfigs, [CONFIG]);
});

test("isVideoDecoderConfigSupported: supported が false なら非対応とみなす", async () => {
  // 非対応を申告した設定は非対応になる
  await withVideoDecoder({ isConfigSupported: async () => ({ supported: false }) }, async () => {
    assert.isFalse(await isVideoDecoderConfigSupported(CONFIG));
  });
});

test("isVideoDecoderConfigSupported: supported が省略されたら非対応とみなす", async () => {
  // supported の省略は「対応を確かめられない」ため非対応にする。
  // 省略を truthy 判定で通すと、非対応の設定でデコーダーを作ってしまう
  await withVideoDecoder({ isConfigSupported: async () => ({}) }, async () => {
    assert.isFalse(await isVideoDecoderConfigSupported(CONFIG));
  });
});

test("isVideoDecoderConfigSupported: isConfigSupported の reject は非対応とみなす", async () => {
  // 不正な設定では同期 throw せず reject した Promise が返る。
  // reject をそのまま伝播させると、非対応の設定で例外の種類が変わってしまう
  await withVideoDecoder(
    {
      isConfigSupported: async () => {
        throw new Error("NotSupportedError");
      },
    },
    async () => {
      assert.isFalse(await isVideoDecoderConfigSupported(CONFIG));
    },
  );
});

test("isVideoDecoderConfigSupported: VideoDecoder が無ければ別の文言で失敗する", async () => {
  // WebCodecs 非搭載の環境を非対応 codec として報告すると、原因を取り違える
  await withVideoDecoder(undefined, async () => {
    let thrown: unknown = null;
    try {
      await isVideoDecoderConfigSupported(CONFIG);
    } catch (error) {
      thrown = error;
    }
    assert.instanceOf(thrown, Error);
    assert.equal((thrown as Error).message, "VideoDecoder is not available in this environment");
  });
});

test("isAudioEncoderConfigSupported: supported が true なら対応とみなす", async () => {
  // 対応を申告した設定はそのまま対応になる
  const probedConfigs: AudioEncoderConfig[] = [];
  await withAudioEncoder(
    {
      isConfigSupported: async (config: AudioEncoderConfig) => {
        probedConfigs.push(config);
        return { supported: true };
      },
    },
    async () => {
      assert.isTrue(await isAudioEncoderConfigSupported(AUDIO_CONFIG));
    },
  );
  // 確認した設定はそのまま (複製や改変をしない) 渡される
  assert.deepEqual(probedConfigs, [AUDIO_CONFIG]);
});

test("isAudioEncoderConfigSupported: supported が false なら非対応とみなす", async () => {
  // 非対応を申告した設定は非対応になる。
  // `AudioEncoder.configure()` は未対応でも同期の例外を投げないため、
  // ここで弾かないと catalog を送ってから非同期のエラーになる
  await withAudioEncoder({ isConfigSupported: async () => ({ supported: false }) }, async () => {
    assert.isFalse(await isAudioEncoderConfigSupported(AUDIO_CONFIG));
  });
});

test("isAudioEncoderConfigSupported: supported が省略されたら非対応とみなす", async () => {
  // supported の省略は「対応を確かめられない」ため非対応にする
  await withAudioEncoder({ isConfigSupported: async () => ({}) }, async () => {
    assert.isFalse(await isAudioEncoderConfigSupported(AUDIO_CONFIG));
  });
});

test("isAudioEncoderConfigSupported: isConfigSupported の reject は非対応とみなす", async () => {
  // 不正な設定では同期 throw せず reject した Promise が返る。
  // reject をそのまま伝播させると、非対応の設定で例外の種類が変わってしまう
  await withAudioEncoder(
    {
      isConfigSupported: async () => {
        throw new Error("NotSupportedError");
      },
    },
    async () => {
      assert.isFalse(await isAudioEncoderConfigSupported(AUDIO_CONFIG));
    },
  );
});

test("isAudioEncoderConfigSupported: AudioEncoder が無ければ別の文言で失敗する", async () => {
  // WebCodecs 非搭載の環境を非対応 codec として報告すると、原因を取り違える
  await withAudioEncoder(undefined, async () => {
    let thrown: unknown = null;
    try {
      await isAudioEncoderConfigSupported(AUDIO_CONFIG);
    } catch (error) {
      thrown = error;
    }
    assert.instanceOf(thrown, Error);
    assert.equal((thrown as Error).message, "AudioEncoder is not available in this environment");
  });
});

// ============================================================================
// probeAudioEncoderConfig: 実符号化の確認
// ============================================================================

/**
 * 実符号化確認のテストで使う AudioData の置き換え
 *
 * Node には AudioData が無いため、probe が確認用の AudioData を作る経路だけを
 * 置き換える。close が呼ばれたことは静的カウンタで観測する
 */
class FakeAudioData {
  /** close が呼ばれた回数の合計 */
  static closedCount = 0;
  /** 直近に作られた AudioData の初期化値 */
  static lastInit: {
    format: string;
    sampleRate: number;
    numberOfFrames: number;
    numberOfChannels: number;
  } | null = null;
  closed = false;

  constructor(init: {
    format: string;
    sampleRate: number;
    numberOfFrames: number;
    numberOfChannels: number;
    timestamp: number;
    data: BufferSource;
  }) {
    FakeAudioData.lastInit = {
      format: init.format,
      sampleRate: init.sampleRate,
      numberOfFrames: init.numberOfFrames,
      numberOfChannels: init.numberOfChannels,
    };
  }

  close(): void {
    this.closed = true;
    FakeAudioData.closedCount += 1;
  }
}

/** 実符号化確認で使う AudioEncoder の置き換えの挙動 */
interface FakeAudioEncoderBehavior {
  /** 静的な対応確認の結果 */
  supported: boolean;
  /** configure が throw するか */
  configureThrows: boolean;
  /** encode が throw するか */
  encodeThrows: boolean;
  /** encode の後に出力チャンクを何件返すか */
  outputChunkCount: number;
  /** encode の後に error コールバックへ渡す理由 (null なら呼ばない) */
  errorReason: string | null;
  /** flush の振る舞い */
  flush: "resolve" | "reject" | "never";
}

/**
 * 実符号化確認で使う AudioEncoder の置き換え
 *
 * probe がエンコーダーを必ず閉じることと、失敗の種類ごとに supported と reason を
 * どう返すかを固定するため、WebCodecs の境界だけを模す (実装のモックではなく、
 * Node に無いブラウザ API の置き換え)
 */
class FakeAudioEncoder {
  static behavior: FakeAudioEncoderBehavior = {
    supported: true,
    configureThrows: false,
    encodeThrows: false,
    outputChunkCount: 1,
    errorReason: null,
    flush: "resolve",
  };
  /** 生成されたエンコーダー (close の確認に使う) */
  static instances: FakeAudioEncoder[] = [];

  static async isConfigSupported(_config: AudioEncoderConfig): Promise<{ supported: boolean }> {
    return { supported: FakeAudioEncoder.behavior.supported };
  }

  state: "unconfigured" | "configured" | "closed" = "unconfigured";
  readonly configureCalls: AudioEncoderConfig[] = [];
  private readonly init: {
    output: (chunk: unknown, metadata?: unknown) => void;
    error: (error: unknown) => void;
  };

  constructor(init: {
    output: (chunk: unknown, metadata?: unknown) => void;
    error: (error: unknown) => void;
  }) {
    this.init = init;
    FakeAudioEncoder.instances.push(this);
  }

  configure(config: AudioEncoderConfig): void {
    this.configureCalls.push(config);
    if (FakeAudioEncoder.behavior.configureThrows) {
      throw new Error("configure failed");
    }
    this.state = "configured";
  }

  encode(_data: unknown): void {
    if (FakeAudioEncoder.behavior.encodeThrows) {
      throw new Error("encode failed");
    }
    const { outputChunkCount, errorReason } = FakeAudioEncoder.behavior;
    queueMicrotask(() => {
      for (let index = 0; index < outputChunkCount; index++) {
        this.init.output({});
      }
      if (errorReason !== null) {
        this.init.error(new Error(errorReason));
      }
    });
  }

  flush(): Promise<void> {
    switch (FakeAudioEncoder.behavior.flush) {
      case "reject":
        return Promise.reject(new Error("flush failed"));
      case "never":
        return new Promise<void>(() => {});
      default:
        return Promise.resolve();
    }
  }

  close(): void {
    this.state = "closed";
  }
}

/** 実符号化確認に使う音声エンコーダー設定 */
const PROBE_CONFIG: AudioEncoderConfig = {
  codec: "mp4a.40.2",
  sampleRate: 48000,
  numberOfChannels: 2,
  bitrate: 64000,
};

/**
 * 置き換えた WebCodecs の境界で実符号化確認を実行する
 *
 * AudioEncoder と AudioData の両方を置き換え、終わったら必ず元に戻す
 */
async function withProbeBoundary(
  behavior: Partial<FakeAudioEncoderBehavior>,
  run: () => Promise<void>,
): Promise<void> {
  FakeAudioEncoder.behavior = {
    supported: true,
    configureThrows: false,
    encodeThrows: false,
    outputChunkCount: 1,
    errorReason: null,
    flush: "resolve",
    ...behavior,
  };
  FakeAudioEncoder.instances = [];
  FakeAudioData.closedCount = 0;
  FakeAudioData.lastInit = null;
  try {
    await withAudioData(FakeAudioData, () => withAudioEncoder(FakeAudioEncoder, run));
  } finally {
    FakeAudioEncoder.instances = [];
  }
}

test("probeAudioEncoderConfig: 出力チャンクが得られたら対応とみなす", async () => {
  await withProbeBoundary({}, async () => {
    const result = await probeAudioEncoderConfig(PROBE_CONFIG);
    assert.isTrue(result.supported);
    assert.isUndefined(result.reason);
    // 確認に使った設定は同じ形で configure へ渡る
    const [encoder] = FakeAudioEncoder.instances;
    assert.isDefined(encoder);
    assert.deepEqual(encoder?.configureCalls, [PROBE_CONFIG]);
    // 確認用のエンコーダーは閉じる
    assert.equal(encoder?.state, "closed");
    // 確認用の AudioData は f32-planar の無音で、1 チャンク以上出る長さ
    assert.deepEqual(FakeAudioData.lastInit, {
      format: "f32-planar",
      sampleRate: 48000,
      numberOfFrames: 4800,
      numberOfChannels: 2,
    });
    assert.equal(FakeAudioData.closedCount, 1);
  });
});

test("probeAudioEncoderConfig: 対応の申告が false ならエンコーダーを作らず非対応", async () => {
  await withProbeBoundary({ supported: false }, async () => {
    const result = await probeAudioEncoderConfig(PROBE_CONFIG);
    assert.isFalse(result.supported);
    assert.equal(result.reason, "isConfigSupported returned unsupported");
    // 非対応と分かった時点でエンコーダーは作らない (AAC の失敗を繰り返さない)
    assert.lengthOf(FakeAudioEncoder.instances, 0);
    assert.equal(FakeAudioData.closedCount, 0);
  });
});

test("probeAudioEncoderConfig: error コールバックの理由を返す", async () => {
  await withProbeBoundary({ errorReason: "Encoding error." }, async () => {
    const result = await probeAudioEncoderConfig(PROBE_CONFIG);
    assert.isFalse(result.supported);
    assert.equal(result.reason, "Encoding error.");
    // 失敗した設定でもエンコーダーは閉じる
    assert.equal(FakeAudioEncoder.instances[0]?.state, "closed");
  });
});

test("probeAudioEncoderConfig: flush の reject を理由にする", async () => {
  await withProbeBoundary({ flush: "reject", outputChunkCount: 0 }, async () => {
    const result = await probeAudioEncoderConfig(PROBE_CONFIG);
    assert.isFalse(result.supported);
    assert.equal(result.reason, "flush failed: flush failed");
    assert.equal(FakeAudioEncoder.instances[0]?.state, "closed");
  });
});

test("probeAudioEncoderConfig: 出力の無いまま flush が解決したら非対応", async () => {
  await withProbeBoundary({ outputChunkCount: 0 }, async () => {
    const result = await probeAudioEncoderConfig(PROBE_CONFIG);
    assert.isFalse(result.supported);
    assert.equal(result.reason, "flush completed without output chunk");
  });
});

test("probeAudioEncoderConfig: 待ち上限まで出力が無ければ非対応", async () => {
  await withProbeBoundary({ flush: "never", outputChunkCount: 0 }, async () => {
    const result = await probeAudioEncoderConfig(PROBE_CONFIG, 1);
    assert.isFalse(result.supported);
    assert.equal(result.reason, "no output chunk within 1ms");
    assert.equal(FakeAudioEncoder.instances[0]?.state, "closed");
  });
});

test("probeAudioEncoderConfig: configure の同期 throw を理由にする", async () => {
  await withProbeBoundary({ configureThrows: true }, async () => {
    const result = await probeAudioEncoderConfig(PROBE_CONFIG);
    assert.isFalse(result.supported);
    assert.equal(result.reason, "configure failed");
    assert.equal(FakeAudioEncoder.instances[0]?.state, "closed");
  });
});

test("probeAudioEncoderConfig: encode の同期 throw を理由にする", async () => {
  await withProbeBoundary({ encodeThrows: true }, async () => {
    const result = await probeAudioEncoderConfig(PROBE_CONFIG);
    assert.isFalse(result.supported);
    assert.equal(result.reason, "encode failed");
    // encode に失敗しても確認用の AudioData は閉じる
    assert.equal(FakeAudioData.closedCount, 1);
  });
});

test("probeAudioEncoderConfig: AudioEncoder が無ければ別の文言で失敗する", async () => {
  await withAudioEncoder(undefined, async () => {
    let thrown: unknown = null;
    try {
      await probeAudioEncoderConfig(PROBE_CONFIG);
    } catch (error) {
      thrown = error;
    }
    assert.instanceOf(thrown, Error);
    assert.equal((thrown as Error).message, "AudioEncoder is not available in this environment");
  });
});
