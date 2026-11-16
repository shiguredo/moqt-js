interface SetupButtonProps {
  disabled: boolean;
  settingUp: boolean;
  testId: string;
  onSetup: () => Promise<void>;
}

/** SETUP 単独の操作。接続中と接続済み、配信・購読中は再実行しない。 */
export function SetupButton({ disabled, settingUp, testId, onSetup }: SetupButtonProps) {
  return (
    <button
      type="button"
      onClick={() => void onSetup()}
      disabled={disabled}
      data-testid={testId}
      title="Establish a session with SETUP only. Publish or subscribe separately on the same session"
      class="w-28 shrink-0 py-2.5 border border-slate-300 bg-white hover:bg-slate-100 disabled:bg-slate-100 disabled:text-slate-400 disabled:cursor-not-allowed text-slate-700 font-medium rounded-lg transition-colors"
    >
      {settingUp ? "Setting up..." : "Setup"}
    </button>
  );
}
