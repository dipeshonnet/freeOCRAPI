import { useEffect, useRef, type ReactNode } from "react";
import { X, LoaderCircle, ChevronDown } from "lucide-react";
export function Header({
  title,
  description,
  actions,
}: {
  title: string;
  description?: string;
  actions?: ReactNode;
}) {
  return (
    <div className="page-header">
      <div>
        <h1>{title}</h1>
        {description && <p>{description}</p>}
      </div>
      {actions && <div className="actions">{actions}</div>}
    </div>
  );
}
export function Empty({
  title,
  children,
}: {
  title: string;
  children?: ReactNode;
}) {
  return (
    <div className="empty">
      <h2>{title}</h2>
      <p>{children}</p>
    </div>
  );
}
export function Busy() {
  return (
    <div className="busy">
      <LoaderCircle className="spin" size={18} /> Loading…
    </div>
  );
}
export function Badge({ children }: { children: ReactNode }) {
  return <span className="badge">{children}</span>;
}
export function Toggle({
  value,
  onChange,
  label,
  disabled = false,
}: {
  value: boolean;
  onChange: (value: boolean) => void;
  label: string;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      className={`switch ${value ? "on" : ""}`}
      role="switch"
      aria-checked={value}
      aria-label={label}
      onClick={() => onChange(!value)}
      disabled={disabled}
    >
      <span />
    </button>
  );
}
export function Modal({
  title,
  children,
  onClose,
}: {
  title: string;
  children: ReactNode;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    ref.current?.showModal();
    return () => ref.current?.close();
  }, []);
  return (
    <dialog
      ref={ref}
      onCancel={onClose}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="dialog-header">
        <h2>{title}</h2>
        <button
          className="icon-button"
          onClick={onClose}
          aria-label="Close dialog"
        >
          <X size={18} />
        </button>
      </div>
      {children}
    </dialog>
  );
}
export function Menu({
  label,
  children,
}: {
  label: ReactNode;
  children: ReactNode;
}) {
  return (
    <details className="menu">
      <summary>
        {label}
        <ChevronDown size={12} />
      </summary>
      <div
        className="menu-content"
        onClick={(e) => {
          const details = e.currentTarget.closest("details");
          if (details) details.open = false;
        }}
      >
        {children}
      </div>
    </details>
  );
}
export const show = (value: number | null | undefined, suffix = "") =>
  value === null || value === undefined
    ? "—"
    : `${Number.isInteger(value) ? value.toLocaleString() : value.toFixed(1)}${suffix}`;
export const date = (value: string) => new Date(value).toLocaleString();
