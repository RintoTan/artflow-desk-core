import { COMMISSION_TYPES } from "../lib/commissionType";

type Props = {
  value: string;
  onChange: (value: string) => void;
  disabled?: boolean;
  id?: string;
};

/**
 * 委托类型输入框 + 高频预设。
 *
 * 输入框始终可编辑：预设是快捷方式，不是白名单。再点一次选中的预设会清空，
 * 这样不用先删字再重选。
 */
export default function CommissionTypeField({ value, onChange, disabled, id }: Props) {
  const current = value.trim();
  return (
    <>
      <input
        id={id}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        maxLength={80}
        disabled={disabled}
        placeholder="选一个常用类型，或直接输入其它类型"
      />
      <div className="type-presets" role="group" aria-label="高频类型">
        {COMMISSION_TYPES.map((type) => {
          const active = current === type;
          return (
            <button
              key={type}
              type="button"
              className={`filter-chip${active ? " filter-chip-active" : ""}`}
              aria-pressed={active}
              disabled={disabled}
              onClick={() => onChange(active ? "" : type)}
            >
              {type}
            </button>
          );
        })}
      </div>
    </>
  );
}
