import type { ComponentChildren } from "preact";

interface ActionButtonProps {
  onClick: () => void;
  title: string;
  variant?: "default" | "danger" | "warning";
  disabled?: boolean;
  children: ComponentChildren;
}

const variantClasses = {
  default: "text-slate-400 hover:text-slate-600 hover:bg-slate-100",
  danger: "text-red-400 hover:text-red-600 hover:bg-red-50",
  warning: "text-amber-400 hover:text-amber-600 hover:bg-amber-50",
} as const;

export function ActionButton({
  onClick,
  title,
  variant = "default",
  disabled = false,
  children,
}: ActionButtonProps) {
  const baseClass = "p-1 rounded transition-colors disabled:opacity-50 disabled:cursor-not-allowed";

  return (
    <button
      onClick={onClick}
      title={title}
      disabled={disabled}
      class={`${baseClass} ${variantClasses[variant]}`}
    >
      {children}
    </button>
  );
}
