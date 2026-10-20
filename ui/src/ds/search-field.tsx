import "./search-field.css";

// why: a search box has no button: typing is the act, and the page below follows each key.
export function SearchField(props: {
  readonly label: string;
  readonly value: string;
  readonly onChange: (value: string) => void;
}) {
  const { label, onChange, value } = props;
  return (
    <input
      type="search"
      className="search-field"
      aria-label={label}
      placeholder="Search"
      value={value}
      onChange={(event) => onChange(event.currentTarget.value)}
    />
  );
}
