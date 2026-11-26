import { useEffect, useMemo, useRef, useState } from "react";

import { clientApi, describeError, type ClientView } from "../bridge/commands";

type Props = {
  clients: ClientView[];
  value: string | null;
  onChange: (clientId: string | null) => void;
  /** 新建客户成功后回调，让页面把新客户并入自己的列表。 */
  onClientCreated?: (client: ClientView) => void;
  disabled?: boolean;
  id?: string;
};

type Option =
  | { kind: "none" }
  | { kind: "client"; client: ClientView }
  | { kind: "create"; name: string };

/**
 * 客户选择：一个控件解决「搜索 / 选择 / 新建 / 不关联」。
 *
 * 原来拆成「不关联 / 已有客户 / 新建客户」三段，选一个人要点两次，
 * 而且下拉里只有名字看不出是谁。这里合成一个可搜索的组合框：
 * 打字过滤、回车选中、没有匹配就当场建一个（建完立刻选中）。
 *
 * 「不关联客户」发出去的是真正的空关联，不会为了占位建一条假客户。
 */
export default function ClientPicker({
  clients,
  value,
  onChange,
  onClientCreated,
  disabled,
  id,
}: Props) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const searchRef = useRef<HTMLInputElement | null>(null);

  const selected = clients.find((client) => client.id === value) ?? null;

  const options = useMemo<Option[]>(() => {
    const keyword = query.trim().toLowerCase();
    const matched = keyword === ""
      ? clients
      : clients.filter((client) => client.displayName.toLowerCase().includes(keyword));
    const list: Option[] = [{ kind: "none" }, ...matched.map((client) => ({ kind: "client" as const, client }))];
    const exact = clients.some((client) => client.displayName.trim() === query.trim());
    if (keyword !== "" && !exact) list.push({ kind: "create", name: query.trim() });
    return list;
  }, [clients, query]);

  useEffect(() => {
    if (!open) return;
    setQuery("");
    setActive(0);
    const handle = window.requestAnimationFrame(() => searchRef.current?.focus());
    return () => window.cancelAnimationFrame(handle);
  }, [open]);

  // 点外面关掉：组合框展开后不能挡住别的字段
  useEffect(() => {
    if (!open) return;
    const onDown = (event: MouseEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  async function pick(option: Option) {
    if (option.kind === "none") {
      onChange(null);
      setOpen(false);
      return;
    }
    if (option.kind === "client") {
      onChange(option.client.id);
      setOpen(false);
      return;
    }
    const name = option.name.trim();
    if (name === "") return;
    setCreating(true);
    setError(null);
    try {
      const created = await clientApi.create({ displayName: name });
      onClientCreated?.(created);
      onChange(created.id);
      setOpen(false);
    } catch (e) {
      setError(describeError(e));
    } finally {
      setCreating(false);
    }
  }

  function onKeyDown(event: React.KeyboardEvent) {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setActive((index) => Math.min(index + 1, options.length - 1));
      return;
    }
    if (event.key === "ArrowUp") {
      event.preventDefault();
      setActive((index) => Math.max(index - 1, 0));
      return;
    }
    if (event.key === "Enter") {
      event.preventDefault();
      const option = options[active];
      if (option) void pick(option);
      return;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      setOpen(false);
      return;
    }
  }

  return (
    <div className="client-picker" ref={rootRef}>
      <button
        type="button"
        id={id}
        className="client-picker-trigger"
        role="combobox"
        aria-expanded={open}
        aria-haspopup="listbox"
        aria-label="客户"
        disabled={disabled}
        onClick={() => setOpen((value) => !value)}
        onKeyDown={(event) => {
          if (event.key === "ArrowDown" || event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            setOpen(true);
          }
        }}
      >
        <span className={selected ? "" : "muted"}>{selected ? selected.displayName : "不关联客户"}</span>
        <span className="client-picker-caret" aria-hidden="true">
          ▾
        </span>
      </button>

      {open && (
        <div className="client-picker-pop">
          <input
            ref={searchRef}
            className="client-picker-search"
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setActive(0);
            }}
            onKeyDown={onKeyDown}
            placeholder="搜索客户，或输入新客户名称"
            aria-label="搜索客户"
            disabled={creating}
          />
          <ul className="client-picker-list" role="listbox" aria-label="客户选项">
            {options.map((option, index) => {
              const key =
                option.kind === "none"
                  ? "__none"
                  : option.kind === "client"
                    ? option.client.id
                    : `__create-${option.name}`;
              const label =
                option.kind === "none"
                  ? "不关联客户"
                  : option.kind === "client"
                    ? option.client.displayName
                    : `新建客户「${option.name}」`;
              return (
                <li key={key}>
                  <button
                    type="button"
                    className={`client-picker-option${index === active ? " is-active" : ""}`}
                    role="option"
                    aria-selected={
                      option.kind === "none" ? value === null : option.kind === "client" && option.client.id === value
                    }
                    onMouseEnter={() => setActive(index)}
                    onClick={() => void pick(option)}
                    disabled={creating}
                  >
                    {label}
                  </button>
                </li>
              );
            })}
          </ul>
          {error && (
            <p className="client-picker-error" role="alert">
              {error}
            </p>
          )}
        </div>
      )}
    </div>
  );
}
