// The search box in the top bar: Gmail syntax, Enter searches, Esc leaves the box, ⓘ shows the options.
import { forwardRef, useEffect, useState } from "react";

export const SearchBox = forwardRef<HTMLInputElement, { query: string; onSearch: (q: string) => void; onHelp: () => void }>(
  function SearchBox({ query, onSearch, onHelp }, ref) {
    const [text, setText] = useState(query);
    useEffect(() => setText(query), [query]);
    return (
      <form
        className="search-box"
        role="search"
        onSubmit={(e) => {
          e.preventDefault();
          if (text.trim()) onSearch(text.trim());
        }}
      >
        <span className="search-icon" aria-hidden>🔍</span>
        <input
          ref={ref}
          type="search"
          aria-label="Search mail"
          placeholder="Search mail"
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Escape") (e.target as HTMLInputElement).blur();
          }}
        />
        <button type="button" className="search-help-button" aria-label="Search options" title="Search options" onClick={onHelp}>
          ⓘ
        </button>
      </form>
    );
  },
);
