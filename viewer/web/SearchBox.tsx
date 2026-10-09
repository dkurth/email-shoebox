// The search box in the top bar: Gmail syntax, Enter searches, Esc leaves the box, the info button shows the options.
import { forwardRef, useEffect, useState } from "react";
import { Info, Search } from "lucide-react";

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
        <Search className="search-icon" size={18} aria-hidden />
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
          <Info size={18} />
        </button>
      </form>
    );
  },
);
