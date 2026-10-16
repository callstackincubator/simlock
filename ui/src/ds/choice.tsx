import "./choice.css";

import { type ReactNode, useId } from "react";

export interface Choice<T extends string> {
  readonly value: T;
  readonly label: string;
}

// why: a filter is one choice of several, so it is a radio group: the arrow keys move along it
// and a screen reader says which one is on; the chips are only how the radios look.
export function ChoiceChips<T extends string>(props: {
  readonly legend: string;
  readonly choices: readonly Choice<T>[];
  readonly value: T;
  readonly onChange: (value: T) => void;
}) {
  const { choices, legend, onChange, value } = props;
  const name = useId();
  return (
    <fieldset className="chips">
      <legend className="visually-hidden">{legend}</legend>
      {choices.map((choice) => (
        <label key={choice.value} className="chip-choice">
          <input
            type="radio"
            name={name}
            value={choice.value}
            checked={choice.value === value}
            onChange={() => onChange(choice.value)}
          />
          <span>{choice.label}</span>
        </label>
      ))}
    </fieldset>
  );
}

export interface Tab<T extends string> {
  readonly value: T;
  readonly label: string;
}

export function Tabs<T extends string>(props: {
  readonly label: string;
  readonly tabs: readonly Tab<T>[];
  readonly value: T;
  readonly onChange: (value: T) => void;
  readonly children: ReactNode;
}) {
  const { children, label, onChange, tabs, value } = props;
  const base = useId();
  return (
    <div className="tabs">
      <div role="tablist" aria-label={label} className="tab-list">
        {tabs.map((tab) => (
          <button
            key={tab.value}
            type="button"
            role="tab"
            id={`${base}-${tab.value}`}
            aria-selected={tab.value === value}
            aria-controls={`${base}-panel`}
            className="tab"
            onClick={() => onChange(tab.value)}
          >
            {tab.label}
          </button>
        ))}
      </div>
      <div
        role="tabpanel"
        id={`${base}-panel`}
        aria-labelledby={`${base}-${value}`}
        className="tab-panel"
      >
        {children}
      </div>
    </div>
  );
}
