import { Search, X } from "lucide-react";
import { useId, useState, type ChangeEvent, type InputHTMLAttributes } from "react";

import styles from "./ui.module.css";

export interface SearchFieldProps extends Omit<InputHTMLAttributes<HTMLInputElement>, "type" | "onChange"> {
  label?: string;
  onChange?: (event: ChangeEvent<HTMLInputElement>) => void;
  onClear?: () => void;
}

export function SearchField({
  className,
  defaultValue,
  id,
  label = "Search",
  onChange,
  onClear,
  placeholder = "Search",
  value,
  ...props
}: SearchFieldProps) {
  const generatedId = useId();
  const inputId = id ?? `terra-search-${generatedId}`;
  const controlled = value !== undefined;
  const [uncontrolledValue, setUncontrolledValue] = useState(() => String(defaultValue ?? ""));
  const currentValue = controlled ? String(value ?? "") : uncontrolledValue;

  function handleChange(event: ChangeEvent<HTMLInputElement>) {
    if (!controlled) setUncontrolledValue(event.target.value);
    onChange?.(event);
  }

  function handleClear() {
    if (!controlled) setUncontrolledValue("");
    onClear?.();
  }

  const classes = [styles.searchField, className].filter(Boolean).join(" ");

  return (
    <div className={classes} role="search">
      <label className={styles.visuallyHidden} htmlFor={inputId}>
        {label}
      </label>
      <Search aria-hidden="true" className={styles.searchIcon} size={15} />
      <input
        {...props}
        id={inputId}
        className={styles.searchInput}
        onChange={handleChange}
        placeholder={placeholder}
        type="search"
        value={currentValue}
      />
      {currentValue ? (
        <button aria-label="Clear search" className={styles.searchClear} onClick={handleClear} type="button">
          <X aria-hidden="true" size={14} />
        </button>
      ) : null}
    </div>
  );
}
