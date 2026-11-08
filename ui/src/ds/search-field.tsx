import "./search-field.css";

import { Icon } from "./icon";

// why: a search box has no button: typing is the act, and the page below follows each key.
export function SearchField(props: {
  readonly label: string;
  readonly value: string;
  readonly onChange: (value: string) => void;
  readonly placeholder?: string;
  readonly className?: string;
}) {
  const { className, label, onChange, placeholder = "Search", value } = props;
  return (
    <span
      className={className === undefined ? "search-field-wrap" : `search-field-wrap ${className}`}
    >
      <Icon name="search" />
      <input
        type="search"
        className="search-field"
        aria-label={label}
        placeholder={placeholder}
        value={value}
        onChange={(event) => onChange(event.currentTarget.value)}
      />
    </span>
  );
}
